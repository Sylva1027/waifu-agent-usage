import { UsageQueries } from "./usage-reader.js";
import { createStoredQuotaSourceResolver } from "./usage-quota-source-store.js";
import { canonicalModelName } from "../public/model-identity.js";
import { summarizeUsage } from "./usage-summary.js";
import { readUsageSourceInputs } from "./usage-source-inputs.js";
import { selectStoredQuotaWindows } from "./usage-quota-store.js";
import {
  ensureUsageAllSummarySchema,
  buildStoredAllSummary,
  USAGE_ALL_SUMMARY_TABLE_NAMES,
} from "./usage-all-summary-store.js";
import { currentLocalRollupZoneIdentity } from "./usage-sql.js";
import {
  tryAppendUsageRollups,
  tryInitializeUsageRollups,
  createUsageRollups,
  listDirtyUsageRollupDays,
  rebuildUsageRollups,
  localUsageRollupDaysForUtcDays,
  checkpointUsageRollups,
} from "./usage-rollups.js";
import {
  publishedUsageEventFromRow,
  publishedUsageHomesFromDatabase,
  publishedUsageSessionsFromEvents,
  quotaObservationsFromDatabase,
} from "./usage-published.js";

export class UsageProjectionOwner extends UsageQueries {
  constructor(view = {}) {
    super(view);
    this.storeRevision = view.revision ?? 0;
    this.derivedRevision = this.storeRevision;
    this.writeTransactionDepth = 0;
    this.metadataCache = null;
    this.quotaObservationCache = null;
    this.summaryProjectionCache = null;
    this.periodComparisonCache = new Map();
    this.ownsPeriodComparisonCache = true;
    this.ownsDatabase = false;
    this.registeredReadDatabase = null;
    this.quotaSourceLookup = null;
    this.summarySnapshotRead = this.metadataSnapshotRead = this.periodComparisonSnapshotRead = true;
  }

  get sourceInputReader() {
    return readUsageSourceInputs;
  }
  get editionProjectionTables() {
    return USAGE_ALL_SUMMARY_TABLE_NAMES;
  }
  prepareEditionSummarySchema() {
    ensureUsageAllSummarySchema(this.database);
  }
  prepareAllSummaryProjection(filters, options) {
    if (this.database.isTransaction || this.writeTransactionDepth) return;
    const input = this.allSummaryOptions(filters, options);
    if (!input) return;
    if (this.historyPersistentRead) ensureUsageAllSummarySchema(this.database, { mode: "history" });
    input.contextKey = () => this.allSummaryOptions(filters, options)?.key;
    try {
      this.lastAllSummaryWork = this.withBusinessProjection(() => buildStoredAllSummary(input));
    } catch (error) {
      if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
      this.lastAllSummaryWork = { fallbackReason: error.code };
    }
  }
  modelName(model) {
    return canonicalModelName(model);
  }
  readMetadata(_asOf = new Date()) {
    return super.metadata();
  }
  readPeriodComparison(options = {}) {
    return super.periodComparison(options);
  }
  summarizeInReadTransaction(filters = {}, options = {}) {
    return super.summarize(filters, options);
  }
  metadata(asOf) {
    return this.readMetadata(asOf);
  }
  periodComparison(options = {}) {
    return this.readPeriodComparison(options);
  }
  summarize(filters = {}, options = {}) {
    return this.summarizeInReadTransaction(filters, options);
  }
  async dashboardHistory(filters = {}, options = {}) {
    return {
      summary: this.summarizeInReadTransaction(filters, options),
      metadata: this.readMetadata(filters.now ? new Date(filters.now) : new Date()),
      periodComparison: this.readPeriodComparison(filters),
    };
  }

  readMetaRaw(key) {
    return this.database.prepare("SELECT value FROM store_meta WHERE key=?").get(key)?.value;
  }
  readDataVersion() {
    return Number(this.database.prepare("PRAGMA data_version").get().data_version);
  }
  registerReadFunctions() {
    super.registerReadFunctions();
    this.registeredReadDatabase = this.database;
  }
  withBusinessProjection(work) {
    return work();
  }
  prepareMetadataProjection() {
    /* Counts are read from the shared rollups and factual rows. */
  }
  prepareQuotaProjection(filters) {
    if (
      this.database.isTransaction ||
      this.writeTransactionDepth ||
      (this.verifiedHistorySqlRead && !this.historyPersistentRead) ||
      (!this.historyPersistentRead &&
        this.database.prepare("SELECT 1 FROM store_meta WHERE key='history_archive_event_authority'").get())
    )
      return;
    const official = JSON.parse(this.readMetaRaw("official_quota_observations") || "[]");
    this.withBusinessProjection(() =>
      selectStoredQuotaWindows(this.database, filters.now ? new Date(filters.now) : new Date(), official),
    );
  }
  prepareHotRollups() {
    if (
      this.database.isTransaction ||
      this.writeTransactionDepth ||
      (this.verifiedHistorySqlRead && !this.historyPersistentRead) ||
      (!this.historyPersistentRead &&
        this.database.prepare("SELECT 1 FROM store_meta WHERE key='history_archive_event_authority'").get())
    )
      return;
    if (this.historyPersistentRead) {
      createUsageRollups(this.database);
      const initial = tryInitializeUsageRollups(this.database, { zoneIdentity: currentLocalRollupZoneIdentity() });
      if (initial.applied) {
        this.lastRollupWork = initial;
        return initial;
      }
    }
    return this.withBusinessProjection(() => {
      const zoneIdentity = currentLocalRollupZoneIdentity();
      const work = tryAppendUsageRollups(this.database, { zoneIdentity });
      this.lastRollupWork = work;
      if (work.applied) return;
      const days = listDirtyUsageRollupDays(this.database);
      for (const day of days) {
        this.database.exec("SAVEPOINT business_rollup_day");
        try {
          rebuildUsageRollups(this.database, { days: [day], calendarZone: "utc" });
          rebuildUsageRollups(this.database, { days: localUsageRollupDaysForUtcDays([day]), calendarZone: "local" });
          this.database.exec("RELEASE business_rollup_day");
        } catch (error) {
          this.database.exec("ROLLBACK TO business_rollup_day; RELEASE business_rollup_day");
          throw error;
        }
      }
      this.lastRollupWork = {
        ...work,
        fallbackDays: days.length,
        checkpoint: checkpointUsageRollups(this.database, { zoneIdentity }),
      };
    });
  }

  publishedUsageHomes() {
    return publishedUsageHomesFromDatabase(this.database);
  }
  quotaSourceFor(home, session, time) {
    this.quotaSourceLookup ||= createStoredQuotaSourceResolver(this.database, this.quotaSourceEvidence);
    return this.quotaSourceLookup(home, session, time);
  }
  publishedUsageEvents() {
    this.assertSourceRepairsComplete();
    const aliases = this.repositoryAliases();
    return this.database
      .prepare(
        `SELECT e.*,sf.kind AS source_kind FROM events e JOIN source_files sf ON sf.path=e.source_path ORDER BY e.timestamp_ms,e.id`,
      )
      .all()
      .map((row) => publishedUsageEventFromRow(row, row.source_kind, null, this.quotaSourceFor?.bind(this), aliases));
  }
  publishedUsageSessions() {
    return publishedUsageSessionsFromEvents(this.publishedUsageEvents(), this.publishedUsageHomes());
  }
  quotaObservations() {
    return quotaObservationsFromDatabase(this.database, this.verifiedHistorySqlRead && !this.historyDiskRead);
  }
  publishedUsageReport() {
    this.database.exec("SAVEPOINT published_usage_report_read");
    try {
      return {
        events: this.publishedUsageEvents(),
        homes: this.publishedUsageHomes(),
        sessions: this.publishedUsageSessions(),
        rateLimitObservations: this.quotaObservations(),
      };
    } finally {
      this.database.exec("RELEASE published_usage_report_read");
    }
  }
  summarizeHistoryReport(report, filters = {}, { includeDetails = true } = {}) {
    const excluded = new Set((filters.excludeHomes || []).map(String));
    const scoped = excluded.size
      ? {
          ...report,
          events: report.events.filter((event) => !excluded.has(String(event.homeId))),
          sessions: report.sessions.filter((session) => !excluded.has(String(session.homeId))),
        }
      : report;
    const result = summarizeUsage({ ...scoped, generatedAt: this.generatedAt, warnings: this.warnings }, filters);
    if (!includeDetails) for (const key of ["homes", "projects", "repositories"]) delete result[key];
    return result;
  }
  createQueryOwner(view) {
    return new UsageProjectionOwner(view);
  }
  createPublishedReader(view) {
    return new UsagePublishedReader(view);
  }
  metadataFromHistoryEvents(events, carrier) {
    const sessions = new Set();
    const homes = new Map();
    for (const event of events) {
      const member = JSON.stringify([event.homeId, event.sessionId]);
      sessions.add(member);
      const row = homes.get(event.homeId) || { eventCount: 0, sessions: new Set() };
      row.eventCount++;
      row.sessions.add(member);
      homes.set(event.homeId, row);
    }
    return {
      generatedAt: carrier.generatedAt,
      eventCount: events.length,
      sessionCount: sessions.size,
      homeCount: carrier.homes.length,
      warnings: carrier.warnings,
      homes: carrier.homes.map((home) => ({
        ...home,
        status: homes.has(home.id) ? "active" : "no-events",
        eventCount: homes.get(home.id)?.eventCount || 0,
        sessionCount: homes.get(home.id)?.sessions.size || 0,
      })),
    };
  }
  borrowReadDatabase(database) {
    if (this.database) throw new Error("A read database is already attached");
    this.database = database;
    this.ownsDatabase = false;
  }
  releaseReadDatabase() {
    if (this.ownsDatabase) throw new Error("The owning view must close its database");
    this.releaseReadFunctions?.();
    this.releaseReadFunctions = null;
    this.database = null;
    this.registeredReadDatabase = null;
    this.quotaSourceLookup = null;
  }
  borrowPeriodComparisonCache(cache) {
    if (this.periodComparisonCache.size) throw new Error("Cannot replace an active period cache");
    this.periodComparisonCache = cache;
    this.ownsPeriodComparisonCache = false;
  }
  close() {
    const database = this.database;
    this.quotaSourceLookup?.clearCache();
    this.quotaSourceLookup = null;
    if (this.ownsPeriodComparisonCache) this.periodComparisonCache.clear();
    try {
      super.close();
    } finally {
      if (this.ownsDatabase) database?.close();
    }
  }
}

class UsagePublishedReader extends UsageProjectionOwner {
  constructor(view) {
    if (!view?.database) throw new TypeError("A fixed usage database view is required");
    super(view);
    this.withVerifiedRead = null;
  }
  async dashboardHistory(filters = {}, options = {}) {
    const read = () => super.dashboardHistory(filters, options);
    return this.withVerifiedRead ? this.withVerifiedRead(read) : read();
  }
}
