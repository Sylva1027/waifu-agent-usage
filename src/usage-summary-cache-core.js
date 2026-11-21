import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calendarPresetRange } from "../public/period-comparison.js";
import { QUOTA_PERCENT_STALE_AFTER_MS, usageComparisonFromAggregates } from "./usage-query.js";
import { readUsageSourceInputs } from "./usage-source-inputs.js";
import { buildUsageFingerprint, discoverUsageSources } from "./usage-sources.js";
import { calendarContext } from "./calendar-context.js";
import { isSqliteBusy } from "./sqlite-busy.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
// Bump when payload formulas or executor snapshot semantics change.
const SUMMARY_CACHE_VERSION = 11;

/** Recompute clock fields from cached aggregates, using the shared formulas. */
export function refreshSummaryClock(payload, now) {
  const summary = payload.summary;
  const range = summary.range;
  const comparison = summary.comparison;
  const quota = summary.quota;
  const asOf = now.toISOString();
  if (quota) {
    quota.asOf = asOf;
    for (const window of Object.values(quota.windows || {})) {
      if (window.state === "available") {
        window.percentStale = now.getTime() - Date.parse(window.observedAt) > QUOTA_PERCENT_STALE_AFTER_MS;
      }
    }
  }
  range.asOf = asOf;
  if (range.quotaWindow) {
    range.asOf = asOf;
    range.end = new Date(Math.min(now.getTime(), Date.parse(range.windowEndExclusive)) - 1).toISOString();
    range.percentStale = now.getTime() - Date.parse(range.observedAt) > QUOTA_PERCENT_STALE_AFTER_MS;
    for (const row of summary.timeline || []) {
      if (Number.isFinite(row.slotStartMs)) row.future = row.slotStartMs >= now.getTime();
    }
  }
  if (comparison) {
    summary.comparison = usageComparisonFromAggregates({
      range: {
        ...range,
        start: range.start ? new Date(range.start) : null,
        end: range.end ? new Date(range.end) : null,
      },
      currentTotals: summary.totals,
      previousTotals: comparison.previousTotals,
      previousEventCount: comparison.previousEventCount,
      previousSessionCount: comparison.previousSessionCount,
      previousRange: comparison.previousRange
        ? { start: new Date(comparison.previousRange.start), end: new Date(comparison.previousRange.end) }
        : null,
      now,
    });
  }
  payload.periodComparison.asOf = asOf;
  return payload;
}

export function summaryCacheKey(filters, includeDetails, context = { edition: "lite" }) {
  if (filters.preset === "recent" && String(filters.recentValue || "").replace(/\s+/g, "") === "1天") return null;
  const { now = new Date(), pricingModels: _models, ...shape } = filters;
  const calendar = filters.calendarContext || calendarContext();
  if (calendar.timeZone !== calendarContext().timeZone) return null;
  const day = calendarPresetRange("today", new Date(now), filters.calendarZone);
  return digest(
    JSON.stringify({
      ...shape,
      calendarContext: calendar,
      version: SUMMARY_CACHE_VERSION,
      excludeHomes: [...(shape.excludeHomes || [])].sort(),
      includeDetails,
      day: day.start.toISOString(),
      context,
    }),
  );
}

/** Small persistent results; the source index is opened only for short read queries. */
export class UsageSummaryCache {
  constructor(
    options = {},
    { readInputs = readUsageSourceInputs, refreshClock = refreshSummaryClock, cacheName = "lite" } = {},
  ) {
    this.readInputs = readInputs;
    this.refreshClock = refreshClock;
    this.options = options;
    this.databaseFile =
      options.databaseFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "usage-index.sqlite");
    this.file = `${this.databaseFile}.${cacheName ? `${cacheName}.` : ""}summaries.sqlite`;
    this.database = null;
    this.source = null;
    this.sourceIdentity = "";
    this.publication = null;
    this.observedVersion = null;
    this.samePublicationRevision = 0;
  }

  async open({ optional = false } = {}) {
    if (this.database) return true;
    await mkdir(path.dirname(this.file), { recursive: true });
    if (this.database) return true;
    let database;
    try {
      database = new DatabaseSync(this.file);
      database.exec(`PRAGMA busy_timeout = ${optional ? 0 : 5000}`);
      this.initialize(database);
      this.database = database;
      return true;
    } catch (error) {
      database?.close();
      if (optional && isSqliteBusy(error)) return false;
      throw error;
    }
  }

  initialize(database) {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS summary_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), signature TEXT, state TEXT);
      INSERT OR IGNORE INTO summary_state VALUES (1, NULL, NULL);
      CREATE TABLE IF NOT EXISTS summaries (key TEXT PRIMARY KEY, signature TEXT NOT NULL, created_at REAL NOT NULL, valid_until REAL NOT NULL, payload TEXT NOT NULL);
    `);
    this.readState = database.prepare("SELECT signature,state FROM summary_state WHERE singleton = 1");
    this.readEntry = database.prepare("SELECT * FROM summaries WHERE key = ?");
    this.writeEntry = database.prepare("INSERT OR REPLACE INTO summaries VALUES (?, ?, ?, ?, ?)");
    const retained = this.readState.get();
    if (retained.state) {
      let saved;
      try {
        saved = JSON.parse(String(retained.state));
      } catch {
        // Rebuildable state must not prevent a fresh index query.
      }
      if (saved?.version !== SUMMARY_CACHE_VERSION) {
        database.exec("DELETE FROM summaries; UPDATE summary_state SET signature = NULL, state = NULL");
        return;
      }
      if (saved.publication && this.observedVersion === null) {
        this.publication = saved.publication;
        this.samePublicationRevision = Number(saved.publication.revision || 0);
      }
    }
  }

  async readSourceState(options = this.options) {
    const homes = await discoverUsageSources(options);
    const usage = await buildUsageFingerprint({ ...options, homes });
    const { inputs, auxiliary, routingFingerprint } = await this.readInputs(options, homes, usage.fingerprint);
    const publication = await this.readPublication();
    return {
      ...usage,
      inputs,
      auxiliary,
      routingFingerprint,
      publication,
      signature: digest(`${inputs}\0${publication?.signature || ""}`),
    };
  }

  async readCertifiedSourceState(options, status) {
    const acquisition = status?.acquisition;
    if (acquisition?.format !== 1) return null;
    const input = await this.readInputs(options, acquisition.homes, status.fingerprint);
    if (input.auxiliary !== acquisition.auxiliary) return null;
    const publication = await this.readPublication();
    return {
      fingerprint: status.fingerprint,
      checkedAt: status.checkedAt,
      fileCount: status.fileCount,
      homeCount: acquisition.homes.length,
      inputs: input.inputs,
      auxiliary: input.auxiliary,
      routingFingerprint: input.routingFingerprint,
      publication,
      signature: digest(`${input.inputs}\0${publication?.signature || ""}`),
      acquisition,
      completion: status.completion ?? null,
    };
  }

  async readCompletedSourceState(options, status, homes, before) {
    if (!status.completion) return null;
    const input = await this.readInputs(options, homes, status.fingerprint);
    if (
      input.auxiliary !== before.auxiliary &&
      (status.fingerprint !== before.fingerprint || input.routingFingerprint !== before.routingFingerprint)
    )
      return null;
    const publication = await this.readPublication();
    if (!publication) return null;
    return {
      fingerprint: status.fingerprint,
      checkedAt: status.checkedAt,
      fileCount: status.fileCount,
      homeCount: homes.length,
      inputs: input.inputs,
      auxiliary: input.auxiliary,
      routingFingerprint: input.routingFingerprint,
      publication,
      signature: digest(`${input.inputs}\0${publication.signature}`),
      completion: status.completion,
    };
  }

  async readPublication() {
    // Restore the cache's publication revision before computing identities for persisted results.
    if (!(await this.open({ optional: true }))) return null;
    try {
      const info = await stat(this.databaseFile);
      const identity = `${info.dev}:${info.ino}`;
      if (this.source && identity !== this.sourceIdentity) {
        this.source.close();
        this.source = null;
        this.publication = null;
      }
      if (!this.source) {
        this.source = new DatabaseSync(this.databaseFile, { readOnly: true });
        this.source.exec("PRAGMA busy_timeout = 0");
        this.sourceIdentity = identity;
      }
      const hash = createHash("sha256");
      const versionBefore = Number(this.source.prepare("PRAGMA data_version").get().data_version);
      this.source.exec("BEGIN");
      try {
        for (const row of this.source.prepare("SELECT key,value FROM store_meta ORDER BY key").iterate()) {
          hash.update(String(row.key)).update("\0").update(String(row.value)).update("\0");
        }
      } finally {
        this.source.exec("ROLLBACK");
      }
      const version = Number(this.source.prepare("PRAGMA data_version").get().data_version);
      if (version !== versionBefore) return null;
      const durable = hash.digest("hex");
      if (this.publication?.durable !== durable) this.samePublicationRevision = 0;
      else if (this.observedVersion !== null && version !== this.observedVersion) this.samePublicationRevision += 1;
      this.observedVersion = version;
      this.publication = {
        durable,
        revision: this.samePublicationRevision,
        signature: `${durable}:${this.samePublicationRevision}`,
      };
      return this.publication;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (/locked|busy|no such table/.test(error.message)) return null;
      throw error;
    }
  }

  async retainedState() {
    // A startup hint only; current source and publication checks authorize reuse.
    if (!(await this.open({ optional: true }))) return null;
    try {
      const saved = JSON.parse(String(this.readState.get().state));
      return saved?.executor || null;
    } catch {
      return null;
    }
  }

  async stateFor(source) {
    if (!source.publication || !(await this.open({ optional: true }))) return null;
    const row = this.readState.get();
    if (row.signature !== source.signature || !row.state) return null;
    const saved = JSON.parse(String(row.state));
    return saved.executor || saved;
  }

  async get(key, source, now) {
    if (!key || !source.publication || !(await this.open({ optional: true }))) return null;
    const row = this.readEntry.get(key);
    if (
      !row ||
      row.signature !== source.signature ||
      now.getTime() < Number(row.created_at) ||
      now.getTime() >= Number(row.valid_until)
    )
      return null;
    let payload;
    try {
      payload = JSON.parse(String(row.payload));
    } catch {
      return null;
    }
    if (
      payload.metadata?.calendarContext?.timeZone &&
      payload.metadata.calendarContext.timeZone !== calendarContext().timeZone
    )
      return null;
    return this.refreshClock(payload, now);
  }

  async publish(key, payload, state, source, now) {
    if (!key || !source.publication || source.publication.pending) return;
    if (
      payload.metadata?.calendarContext?.timeZone &&
      payload.metadata.calendarContext.timeZone !== calendarContext().timeZone
    )
      return;
    if (!(await this.open({ optional: true })) || !this.source) return;
    // Cold carriers must be verified by their existing readers, including missing-segment checks.
    if (this.source.prepare("SELECT 1 FROM archive_segments LIMIT 1").get()) return;
    const next = this.source
      .prepare(`SELECT MIN(boundary) AS boundary FROM (
      SELECT MIN(timestamp_ms) AS boundary FROM events WHERE timestamp_ms >= ?
      UNION ALL SELECT MIN(observed_at_ms) FROM rate_limit_observations WHERE observed_at_ms >= ?
      UNION ALL SELECT MIN(resets_at_ms) FROM rate_limit_observations WHERE resets_at_ms >= ?
      UNION ALL SELECT MIN(resets_at_ms - window_minutes * 60000) FROM rate_limit_observations WHERE resets_at_ms - window_minutes * 60000 >= ?
    )`)
      .get(...Array(4).fill(now.getTime())).boundary;
    const day = calendarPresetRange("today", now, payload.summary.range.calendarZone);
    const quotaResets = Object.values(payload.summary.quota?.windows || {})
      .filter((window) => window.state === "available")
      .map((window) => Date.parse(window.windowEndExclusive))
      .filter((time) => Number.isFinite(time) && time >= now.getTime());
    const validUntil = Math.min(day.end.getTime() + 1, next === null ? Infinity : Number(next), ...quotaResets);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.readState.get().signature !== source.signature) this.database.exec("DELETE FROM summaries");
      this.writeEntry.run(
        key,
        source.signature,
        now.getTime(),
        validUntil,
        JSON.stringify({ ...payload, completion: undefined }),
      );
      this.database
        .prepare("UPDATE summary_state SET signature = ?, state = ? WHERE singleton = 1")
        .run(
          source.signature,
          JSON.stringify({ version: SUMMARY_CACHE_VERSION, executor: state, publication: source.publication }),
        );
      this.database.exec(
        "DELETE FROM summaries WHERE key IN (SELECT key FROM summaries ORDER BY created_at DESC LIMIT -1 OFFSET 32)",
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async invalidate() {
    await this.open();
    try {
      this.database.exec(
        "PRAGMA busy_timeout = 5000; DELETE FROM summaries; UPDATE summary_state SET signature = NULL, state = NULL",
      );
    } finally {
      this.database.exec("PRAGMA busy_timeout = 0");
    }
  }

  close() {
    this.source?.close();
    this.database?.close();
    this.source = null;
    this.database = null;
  }
}

export function publishedSummarySource(before, after) {
  return {
    ...after,
    inputs: before.inputs,
    fingerprint: before.fingerprint,
    routingFingerprint: before.routingFingerprint,
    signature: digest(`${before.inputs}\0${after.publication?.signature || ""}`),
  };
}
