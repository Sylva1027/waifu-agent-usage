import {
  isQuotaPreset,
  resolveDateRange,
  previousUsageRange,
  usageComparisonFromAggregates,
  summaryRangeFields,
} from "./usage-query.js";
import { COMPARISON_PERIOD_KEYS } from "../public/period-comparison.js";
import { canonicalModelName } from "../public/model-identity.js";
import { cacheHitRate } from "../public/usage-metrics.js";
import { isQuotaUsage } from "../public/quota-usage.js";
import {
  homeSourceKinds,
  sourceGroup,
  timelineDateKey,
  rangeHourStart,
  deriveTimelineBucket,
  createTimelineAccumulator,
  previousQuotaRange,
} from "../public/timeline-utils.js";
import { readStoredQuotaWindows, readStoredCompletedQuotaWindows } from "./usage-quota-store.js";
import { createStoredQuotaSourceResolver } from "./usage-quota-source-store.js";
import { UsageSessionMembers } from "./usage-session-members.js";
import { createHash } from "node:crypto";
import { readStoredAllSummary } from "./usage-all-summary-store.js";
import { currentLocalRollupZoneIdentity } from "./usage-sql.js";
import { createFusedSummaryGroups } from "./usage-summary-groups.js";
import { createRepositoryAliases } from "./repository-aliases.js";
import { CODEX_WORKTREE_ROOTS_META } from "./codex-worktree-roots.js";
import {
  queryUsageRollupModelsWindow,
  queryUsageRollupRepositoriesWindow,
  queryUsageRollupsRange,
} from "./usage-rollups.js";
import { sessionIdentity } from "../public/usage-fields.js";
import {
  scopeFilterSql,
  completeRollupDays,
  PERIOD_DETAIL_FIELDS,
  eventRangeScope,
  rangeParameters,
  usageFromRow,
  canonicalFactPayload,
  HISTORY_ARCHIVE_EVENT_AUTHORITY_META,
  periodRollupWindow,
  compareSqliteText,
  readMetadataUsageCounts,
} from "./usage-sql.js";

export class UsageQueries {
  /** @param {any} [view] */
  constructor({
    database,
    databaseFile = null,
    homes = [],
    worktreeSnapshot = undefined,
    generatedAt = "",
    warnings = [],
    quotaSourceEvidence = null,
    historyProjectionInput = null,
    sourceKinds = null,
    verifiedHistorySqlRead = false,
    historyDiskRead = false,
    historyPersistentRead = false,
    publishedHistoryProjection = false,
  } = {}) {
    this.database = database;
    this.databaseFile = databaseFile;
    this.homes = structuredClone(homes);
    this.worktreeSnapshot = worktreeSnapshot;
    this.generatedAt = generatedAt;
    this.warnings = [...warnings];
    this.quotaSourceEvidence = quotaSourceEvidence;
    this.historyProjectionInput = historyProjectionInput ? structuredClone(historyProjectionInput) : null;
    this.releaseReadFunctions = null;
    this.historySourceKinds = sourceKinds ? new Map(sourceKinds) : null;
    this.verifiedHistorySqlRead = verifiedHistorySqlRead;
    this.historyDiskRead = historyDiskRead;
    this.historyPersistentRead = historyPersistentRead;
    this.publishedHistoryProjection = publishedHistoryProjection;
    this.writeTransactionDepth = 0;
  }

  repositoryWorktreeSnapshot() {
    return (
      this.worktreeSnapshot ??
      this.database.prepare("SELECT value FROM store_meta WHERE key=?").get(CODEX_WORKTREE_ROOTS_META)?.value
    );
  }

  repositoryAliases() {
    const cache = this.repositoryAliasCache;
    if (cache?.homes === this.homes && cache.database === this.database && cache.generatedAt === this.generatedAt)
      return cache.aliases;
    const homes = this.homes.length
      ? this.homes
      : this.database.prepare("SELECT DISTINCT home_path AS path, kind FROM source_files").all();
    const snapshot = this.repositoryWorktreeSnapshot();
    const aliases = createRepositoryAliases(
      homes,
      this.database,
      snapshot === undefined ? undefined : new Map(JSON.parse(snapshot)),
    );
    this.repositoryAliasCache = { homes: this.homes, database: this.database, generatedAt: this.generatedAt, aliases };
    return aliases;
  }

  /** @param {any} filters @param {any} options @param {any} [range] @returns {any} */
  allSummaryOptions(filters = {}, options = {}, range = null, bucket = null) {
    if (
      filters.preset !== "all" ||
      options.includeDetails !== false ||
      (filters.excludeHomes || []).length ||
      this.writeTransactionDepth ||
      (this.verifiedHistorySqlRead && !this.historyPersistentRead) ||
      (!this.historyPersistentRead &&
        this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META))
    )
      return null;
    const bounds = this.eventBounds();
    range ||= resolveDateRange(
      filters,
      [bounds.minimum, bounds.maximum]
        .filter((value) => value !== null)
        .map((value) => ({ timestamp: new Date(Number(value)).toISOString() })),
    );
    bucket ||= deriveTimelineBucket(range, range.bucket || filters.bucket || "day");
    if (!["day", "week", "month"].includes(bucket)) return null;
    const sourceKinds = new Map(
      this.database
        .prepare("SELECT home_id,kind FROM source_files")
        .all()
        .map((row) => [String(row.home_id), String(row.kind)]),
    );
    const history = this.historyPersistentRead;
    const schema = history
      ? this.historyProjectionInput?.schema
      : this.database.prepare("PRAGMA main.schema_version").get().schema_version;
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          "usage-all-summary-v1",
          schema,
          bucket,
          range.calendarZone,
          currentLocalRollupZoneIdentity(),
          [...sourceKinds].sort(),
        ]),
      )
      .digest("hex");
    const database = this.database;
    return {
      database,
      ...(history ? { mode: "history" } : {}),
      key,
      range,
      bucket,
      requestedBucket: filters.bucket || "day",
      sourceKinds,
      *eventsAfter(position, limit) {
        const query = database.prepare(
          `SELECT ${history ? "history_ordinal" : "id"} AS event_id,timestamp_ms,session_id,home_id,home_label,source_path,channel,model,project,total,input,cached,output,reasoning,detail_mask FROM events WHERE ${history ? "(timestamp_ms,history_ordinal)>(?,?) ORDER BY timestamp_ms,history_ordinal" : "id>? ORDER BY id"} LIMIT ?`,
        );
        for (const row of query.iterate(...(history ? [position.ms, position.id, limit] : [position.id, limit])))
          yield {
            id: Number(row.event_id),
            timestamp: Number(row.timestamp_ms),
            sessionId: String(row.session_id),
            homeId: String(row.home_id),
            homeLabel: String(row.home_label),
            sourcePath: String(row.source_path),
            sourceKind: sourceKinds.get(String(row.home_id)),
            channel: String(row.channel),
            model: String(row.model),
            project: String(row.project),
            detailMask: Number(row.detail_mask),
            total: usageFromRow(row),
          };
      },
    };
  }

  readSummaryProjection(filters, options, range, bucket) {
    const table = this.historyPersistentRead
      ? "usage_history_all_summary_usage_state"
      : "usage_all_summary_usage_state";
    if (!this.database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) return null;
    const input = this.allSummaryOptions(filters, options, range, bucket);
    return input ? readStoredAllSummary(input) : null;
  }

  assertSourceRepairsComplete() {
    if (this.database.prepare("SELECT 1 FROM usage_source_reparse LIMIT 1").get())
      throw Object.assign(
        new Error("Source dependency repair is incomplete; retry when the affected source is available"),
        {
          code: "SOURCE_DEPENDENCY_PENDING",
        },
      );
  }

  metadata() {
    this.assertSourceRepairsComplete();
    const counts = readMetadataUsageCounts(this.database, this.verifiedHistorySqlRead ? this.eventBounds() : null);
    return {
      generatedAt: this.generatedAt,
      eventCount: counts.eventCount,
      sessionCount: counts.sessionCount,
      homeCount: this.homes.length,
      homes: this.homes.map((home) => {
        const row = counts.homeRows.get(home.id);
        return {
          ...home,
          status: row ? "active" : "no-events",
          eventCount: Number(row?.event_count || 0),
          sessionCount: Number(row?.session_count || 0),
        };
      }),
      warnings: [...this.warnings],
    };
  }

  registerReadFunctions() {
    if (this.releaseReadFunctions) return;
    const database = this.database;
    const evidence = this.quotaSourceEvidence;
    let quotaSource = null;
    database.function("usage_day_key", (time) => timelineDateKey(new Date(Number(time)), "local"));
    database.function("usage_hour_start", (time) => rangeHourStart(Number(time), "local"));
    database.function("usage_source_group", (channel, kind) => sourceGroup(channel, String(kind ?? "")));
    database.function("usage_model_group", (model) => canonicalModelName(String(model ?? "")));
    database.function("usage_quota_allowed", (model, home, session, time) => {
      quotaSource ||= createStoredQuotaSourceResolver(database, evidence);
      return Number(isQuotaUsage({ model, quotaSource: quotaSource(String(home), String(session), Number(time)) }));
    });
    this.releaseReadFunctions = () => {
      quotaSource?.clearCache();
      quotaSource = null;
    };
  }

  *usageEventsForRange(range, excludeHomes = []) {
    const where = eventRangeScope(range, scopeFilterSql(excludeHomes));
    const order = this.historyDiskRead
      ? ` ORDER BY ${this.historyPersistentRead ? "timestamp_ms,history_ordinal" : "id"}`
      : "";
    const statement = this.database.prepare(`SELECT timestamp_ms,session_id,home_id,home_label,source_path,
      channel,model,project,total,input,cached,output,reasoning,detail_mask FROM events WHERE ${where.sql}${order}`);
    statement.setReturnArrays(true);
    for (const row of statement.iterate(...where.params)) {
      yield {
        timestamp: Number(row[0]),
        sessionId: String(row[1]),
        homeId: String(row[2]),
        homeLabel: String(row[3]),
        sourcePath: String(row[4]),
        channel: String(row[5]),
        model: String(row[6]),
        project: String(row[7]),
        total: {
          total: Number(row[8]),
          input: Number(row[9]),
          cached: Number(row[10]),
          output: Number(row[11]),
          reasoning: Number(row[12]),
        },
        detailMask: Number(row[13]),
      };
    }
  }

  /** @param {any} range @param {string} bucket @param {{excludeHomes?: string[], onEvent?: (event: any) => void}} [options] */
  timelineRange(range, bucket, { excludeHomes = [], onEvent } = {}) {
    const members = new UsageSessionMembers();
    try {
      const timeline = createTimelineAccumulator(range, bucket, {
        sourceKinds: this.historySourceKinds ?? homeSourceKinds(this.homes),
        createSessionSet: () => members.createSet(),
      });
      for (const event of this.usageEventsForRange(range, excludeHomes)) {
        timeline.add(event);
        onEvent?.(event);
      }
      return timeline.result();
    } finally {
      members.close();
    }
  }

  summarize(filters = {}, { includeDetails = true } = {}) {
    this.assertSourceRepairsComplete();
    this.registerReadFunctions();
    const excludeHomes = filters.excludeHomes || [];
    const asOf = filters.now ? new Date(filters.now) : new Date();
    const official = JSON.parse(
      this.database.prepare("SELECT value FROM store_meta WHERE key='official_quota_observations'").get()?.value ||
        "[]",
    );
    const quota = readStoredQuotaWindows(this.database, asOf, official);
    const observations = {
      completedQuotaWindows: (limit, time, minutes) =>
        readStoredCompletedQuotaWindows(this.database, limit, time, minutes, official),
    };
    const bounds = this.eventBounds(excludeHomes);
    const boundary = [bounds.minimum, bounds.maximum]
      .filter((value) => value !== null)
      .map((value) => ({ timestamp: new Date(Number(value)).toISOString() }));
    const range = resolveDateRange({ ...filters, now: asOf, quota }, boundary);
    const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
    const nonCodexHomes = quotaPreset
      ? this.database
          .prepare("SELECT DISTINCT home_id FROM source_files WHERE kind NOT IN ('main','jetbrains','extra','codex')")
          .all()
          .map((row) => String(row.home_id))
      : [];
    const scope = quotaPreset ? [...new Set([...excludeHomes, ...nonCodexHomes])] : excludeHomes;
    const bucket = deriveTimelineBucket(
      range,
      range.bucket ||
        (quotaPreset ? (range.preset === "quota_5h" ? "quota_30m" : "quota_24h") : filters.bucket || "day"),
    );
    const projection = this.readSummaryProjection(filters, { includeDetails }, range, bucket);
    const aggregate = projection?.aggregate ?? this.aggregateRange(range, scope);
    const totals = usageFromRow(aggregate);
    const previousRange = quotaPreset ? previousQuotaRange(range, quota, observations) : previousUsageRange(range);
    const previousAggregate = previousRange ? this.aggregateRange(previousRange, scope) : null;
    const comparison = usageComparisonFromAggregates({
      range,
      currentTotals: totals,
      previousRange,
      previousTotals: usageFromRow(previousAggregate),
      previousEventCount: Number(previousAggregate?.event_count || 0),
      previousSessionCount: Number(previousAggregate?.session_count || 0),
      now: asOf,
    });
    const sourceKinds = new Map(
      this.database
        .prepare("SELECT path,kind FROM source_files")
        .all()
        .map((row) => [String(row.path), String(row.kind)]),
    );
    const groups =
      quotaPreset || projection ? null : createFusedSummaryGroups(sourceKinds, canonicalModelName, { includeDetails });
    let timeline = projection?.timeline ?? [],
      timelineError = projection?.timelineError ?? null;
    try {
      if (!projection)
        timeline = this.timelineRange(range, bucket, {
          excludeHomes: scope,
          onEvent: groups ? (event) => groups.add(event) : undefined,
        });
    } catch (error) {
      if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
      timelineError = error.message;
    }
    const fused = projection ?? (timelineError ? null : groups?.result());
    const details = this.rangeDetails(range, scope);
    const summary = {
      generatedAt: this.generatedAt,
      range: summaryRangeFields(range, bucket),
      totals,
      details,
      cacheHitRate: cacheHitRate(details),
      comparison,
      quota,
      eventCount: Number(aggregate.event_count || 0),
      sessionCount: Number(aggregate.session_count || 0),
      homeCount: Number(aggregate.home_count || 0),
      timeline,
      timelineError,
      channels: fused?.channels ?? this.groupedRange("channel", range, "total DESC", scope),
      models: fused?.models ?? this.groupedRange("model", range, "total DESC", scope),
    };
    if (includeDetails) {
      summary.homes = fused?.homes ?? this.groupedRange("home_label", range, "total DESC", scope);
      summary.projects = fused?.projects ?? this.groupedRange("project", range, "total DESC", scope);
      summary.repositories = this.repositoriesRange(range, scope);
    }
    return summary;
  }

  periodComparison(options = {}) {
    this.assertSourceRepairsComplete();
    this.registerReadFunctions();
    const now = options.now ? new Date(options.now) : new Date();
    const excludeHomes = options.excludeHomes || [];
    const zone = options.calendarZone === "utc" ? "utc" : "local";
    const bounds = this.eventBounds(excludeHomes);
    const events =
      bounds.minimum === null
        ? []
        : [bounds.minimum, bounds.maximum].map((value) => ({ timestamp: new Date(Number(value)).toISOString() }));
    const ranges = Object.fromEntries(
      COMPARISON_PERIOD_KEYS.map((key) => [key, resolveDateRange({ preset: key, now, calendarZone: zone }, events)]),
    );
    const models = this.periodAggregateCore("model", "model", now, ranges, { excludeHomes });
    const totals = models.length
      ? Object.fromEntries(
          COMPARISON_PERIOD_KEYS.map((period) => {
            const total = {};
            for (const model of models)
              for (const [field, value] of Object.entries(model.periods[period]))
                total[field] = (total[field] || 0) + value;
            return [period, total];
          }),
        )
      : this.periodAggregateCore(null, null, now, ranges, { excludeHomes })[0].periods;
    return {
      asOf: now.toISOString(),
      periods: COMPARISON_PERIOD_KEYS.map((key) => ({
        key,
        start: ranges[key].start?.toISOString() || null,
        end: ranges[key].end?.toISOString() || null,
      })),
      totals,
      models,
      repositories: this.periodAggregateCore("repository_key", "repository_path", now, ranges, {
        includeKind: true,
        excludeHomes,
      }),
    };
  }

  dashboard(filters = {}, options = {}) {
    return {
      summary: this.summarize(filters, options),
      metadata: this.metadata(),
      periodComparison: this.periodComparison(filters),
    };
  }

  eventBounds(excludeHomes = []) {
    if (this.verifiedHistorySqlRead && !this.historyDiskRead && excludeHomes.length === 0) {
      return this.database
        .prepare(`
        SELECT MIN(minimum) AS minimum, MAX(maximum) AS maximum FROM (
          SELECT (SELECT MIN(timestamp_ms) FROM history_hot.events) AS minimum,
                 (SELECT MAX(timestamp_ms) FROM history_hot.events) AS maximum
          UNION ALL
          SELECT (SELECT MIN(timestamp_ms) FROM main.events),
                 (SELECT MAX(timestamp_ms) FROM main.events)
        )
      `)
        .get();
    }
    if (excludeHomes.length === 0) {
      return this.database
        .prepare(`SELECT
        (SELECT MIN(timestamp_ms) FROM events) AS minimum,
        (SELECT MAX(timestamp_ms) FROM events) AS maximum`)
        .get();
    }
    const scope = scopeFilterSql(excludeHomes);
    return this.database
      .prepare(
        `SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events${scope.sql ? ` WHERE ${scope.sql}` : ""}`,
      )
      .get(...scope.params);
  }

  rangeDetails(range, excludeHomes = []) {
    const days = completeRollupDays(range);
    if (days) {
      try {
        const row = queryUsageRollupsRange(this.database, { ...days, excludeHomes });
        return Object.fromEntries(
          PERIOD_DETAIL_FIELDS.map(([field]) => [
            field,
            Number(
              row[
                {
                  input: "inputKnownTokens",
                  cached: "cachedKnownTokens",
                  output: "outputKnownTokens",
                  reasoning: "reasoningKnownTokens",
                }[field] || field
              ] || 0,
            ),
          ]),
        );
      } catch (error) {
        if (error.code !== "ROLLUP_DAYS_MISSING") throw error;
      }
    }
    const where = eventRangeScope(range, scopeFilterSql(excludeHomes));
    const row = this.database
      .prepare(
        `SELECT ${PERIOD_DETAIL_FIELDS.map(([key, sql]) => `COALESCE(SUM(${sql}),0) AS "${key}"`).join(",")} FROM events WHERE ${where.sql}`,
      )
      .get(...where.params);
    return Object.fromEntries(PERIOD_DETAIL_FIELDS.map(([field]) => [field, Number(row[field])]));
  }

  aggregateRange(range, excludeHomes = []) {
    const rollupDays = completeRollupDays(range);
    if (rollupDays) {
      try {
        const totals = queryUsageRollupsRange(this.database, {
          ...rollupDays,
          excludeHomes,
        });
        return {
          event_count: totals.eventCount,
          session_count: totals.sessionCount,
          home_count: totals.homeCount,
          total: totals.total,
          input: totals.input,
          cached: totals.cached,
          output: totals.output,
          reasoning: totals.reasoning,
        };
      } catch (error) {
        if (error?.code !== "ROLLUP_DAYS_MISSING") throw error;
      }
    }
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    return this.database
      .prepare(`
        SELECT
          COUNT(*) AS event_count,
          COUNT(DISTINCT json_array(home_id,session_id)) AS session_count,
          COUNT(DISTINCT home_id) AS home_count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
      `)
      .get(...where.params);
  }

  groupedRange(column, range, orderBy = "total DESC", excludeHomes = []) {
    const allowedColumns = new Set([
      "channel",
      "home_label",
      "model",
      "project",
      "hour_key",
      "day_key",
      "week_key",
      "month_key",
    ]);
    if (!allowedColumns.has(column)) {
      throw new Error(`不支持的聚合字段：${column}`);
    }
    const dimension =
      column === "model"
        ? "usage_model_group(model)"
        : column === "channel" && !isQuotaPreset(range.preset) && !range.quotaWindow && !range.quotaPreset
          ? "usage_source_group(channel, (SELECT kind FROM source_files WHERE path = events.source_path))"
          : column;
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const rows = this.database
      .prepare(`
        SELECT
          ${dimension} AS key,
          COUNT(*) AS count,
          COUNT(DISTINCT json_array(home_id,session_id)) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
        GROUP BY ${dimension}
        ORDER BY ${orderBy}
      `)
      .all(...where.params);
    return rows.map((row) => ({
      key: row.key,
      name: row.key,
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      total: usageFromRow(row),
    }));
  }

  repositoriesRange(range, excludeHomes = []) {
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const repo = this.repositoryAliases().sql(
      "events.repository_key",
      "events.repository_path",
      "events.repository_kind",
    );
    const rows = this.database
      .prepare(`
        SELECT
          ${repo.key} AS key,
          MIN(${repo.path}) AS name,
          MAX(${repo.kind}) AS kind,
          COUNT(DISTINCT NULLIF(cwd, '')) AS path_count,
          COUNT(*) AS count,
          COUNT(DISTINCT json_array(home_id,session_id)) AS sessions,
          json_group_array(DISTINCT json_array(home_id,session_id)) AS session_ids,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
        GROUP BY key
        ORDER BY total DESC, name ASC
      `)
      .all(...where.params);
    const orderedSessions = this.verifiedHistorySqlRead ? this.historyRepositorySessionOrder(where) : undefined;
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      kind: row.kind,
      pathCount: Number(row.path_count || 0),
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      sessionIds:
        orderedSessions?.get(row.key) ??
        JSON.parse(String(row.session_ids || "[]")).map(
          (value) => (Array.isArray(value) ? value : JSON.parse(value))[1],
        ),
      total: usageFromRow(row),
    }));
  }

  historyRepositorySessionOrder(where, firsts = null) {
    const { key } = this.repositoryAliases().sql(
      "events.repository_key",
      "events.repository_path",
      "events.repository_kind",
    );
    if (this.historyDiskRead) {
      const sessions = new Map();
      const sql = this.historyPersistentRead
        ? `SELECT repository_key,session_id FROM (
        SELECT ${key} AS repository_key,home_id,session_id,timestamp_ms,history_ordinal,
          ROW_NUMBER() OVER(PARTITION BY ${key},home_id,session_id ORDER BY timestamp_ms,history_ordinal) AS position
        FROM events WHERE ${where.sql}) WHERE position=1 ORDER BY repository_key,timestamp_ms,history_ordinal`
        : `SELECT ${key} AS repository_key,session_id,MIN(id) AS first_id
          FROM events WHERE ${where.sql} GROUP BY 1,home_id,session_id ORDER BY 1,first_id`;
      for (const row of this.database.prepare(sql).iterate(...where.params)) {
        const values = sessions.get(row.repository_key) ?? [];
        values.push(row.session_id);
        sessions.set(row.repository_key, values);
      }
      return sessions;
    }
    firsts ??= this.database
      .prepare(`
      SELECT ${key} AS repository_key, home_id, session_id, MIN(timestamp_ms) AS first_ms FROM events
      WHERE ${where.sql} GROUP BY 1, home_id, session_id ORDER BY 1, first_ms
    `)
      .all(...where.params);
    const tieRows = this.database.prepare(`
      SELECT * FROM (SELECT * FROM history_hot.events UNION ALL SELECT * FROM main.events) AS events
      WHERE ${key} = ? AND timestamp_ms = ? AND ${where.sql}
    `);
    const orderedSessions = new Map();
    for (let first = 0; first < firsts.length; ) {
      let end = first + 1;
      const row = firsts[first];
      while (
        end < firsts.length &&
        firsts[end].repository_key === row.repository_key &&
        firsts[end].first_ms === row.first_ms
      )
        end++;
      const group = firsts.slice(first, end);
      if (group.length > 1) {
        const payloads = new Map();
        for (const event of tieRows.iterate(row.repository_key, row.first_ms, ...where.params)) {
          const payload = JSON.stringify(canonicalFactPayload(event, ["id"]));
          const member = sessionIdentity(event.home_id, event.session_id);
          if (!payloads.has(member) || payload < payloads.get(member)) payloads.set(member, payload);
        }
        group.sort((left, right) => {
          const a = payloads.get(sessionIdentity(left.home_id, left.session_id)),
            b = payloads.get(sessionIdentity(right.home_id, right.session_id));
          return a < b ? -1 : a > b ? 1 : 0;
        });
      }
      const sessions = orderedSessions.get(row.repository_key) || [];
      for (const entry of group) sessions.push(entry.session_id);
      orderedSessions.set(row.repository_key, sessions);
      first = end;
    }
    return orderedSessions;
  }

  periodAggregateCore(groupColumn, nameColumn, _now, ranges, { includeKind = false, excludeHomes = [] } = {}) {
    // Published cold rollups contain the complete history, not the hot-only table.
    const hotAuthority =
      !this.verifiedHistorySqlRead &&
      Boolean(this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META));
    const modelDimension = groupColumn === "model" && nameColumn === "model" && !includeKind;
    const repositoryDimension = groupColumn === "repository_key" && nameColumn === "repository_path" && includeKind;
    const aliases = repositoryDimension ? this.repositoryAliases() : null;
    const repo = aliases?.sql("events.repository_key", "events.repository_path", "events.repository_kind");
    const dimensionKey = modelDimension ? "usage_model_group(model)" : (repo?.key ?? groupColumn);
    const dimensionName = modelDimension ? dimensionKey : (repo?.path ?? nameColumn);
    const dimensions = dimensionKey
      ? `${dimensionKey} AS dimension_key, ${includeKind ? `MIN(${dimensionName}) AS dimension_name, MIN(${repo?.kind ?? "repository_kind"}) AS dimension_kind, COUNT(DISTINCT NULLIF(cwd, '')) AS path_count` : `${dimensionName} AS dimension_name`},`
      : "";
    const fields = PERIOD_DETAIL_FIELDS;
    if (repositoryDimension && !hotAuthority && !this.verifiedHistorySqlRead) {
      this.database.exec("SAVEPOINT period_repository_rollup");
      try {
        const bounds = this.eventBounds(excludeHomes);
        if (bounds.minimum !== null && bounds.maximum !== null) {
          const minimum = Number(bounds.minimum);
          const endMs = Number(bounds.maximum) + 1;
          const complete = periodRollupWindow(minimum, endMs, minimum, endMs - 1);
          const repositories = new Map(
            queryUsageRollupRepositoriesWindow(this.database, { ...complete, excludeHomes, aliases }).map((row) => [
              row.key,
              {
                key: row.key,
                name: row.name,
                kind: row.kind,
                pathCount: row.pathCount,
                periods: Object.fromEntries(
                  COMPARISON_PERIOD_KEYS.map((period) => [
                    period,
                    Object.fromEntries(fields.map(([field]) => [field, 0])),
                  ]),
                ),
              },
            ]),
          );
          for (const period of COMPARISON_PERIOD_KEYS) {
            const range = ranges[period] || {};
            const window = periodRollupWindow(
              range.start == null ? minimum : new Date(range.start).getTime(),
              range.end == null ? endMs : new Date(range.end).getTime() + 1,
              minimum,
              endMs - 1,
            );
            if (!window) continue;
            for (const row of queryUsageRollupRepositoriesWindow(this.database, {
              ...window,
              excludeHomes,
              aliases,
            })) {
              const entry = repositories.get(row.key);
              entry.periods[period] = Object.fromEntries(fields.map(([field]) => [field, Number(row[field] || 0)]));
            }
          }
          return [...repositories.values()].sort(
            (left, right) =>
              right.periods.all.total - left.periods.all.total || compareSqliteText(left.name, right.name),
          );
        }
        return [];
      } catch (error) {
        if (error?.code !== "ROLLUP_DAYS_MISSING") throw error;
      } finally {
        this.database.exec("RELEASE period_repository_rollup");
      }
    }
    if (modelDimension && !hotAuthority) {
      this.database.exec("SAVEPOINT period_model_rollup");
      try {
        const bounds = this.eventBounds(excludeHomes);
        if (bounds.minimum === null) {
          this.database.exec("RELEASE period_model_rollup");
          return [];
        }

        const minimum = Number(bounds.minimum);
        const maximum = Number(bounds.maximum);
        const sourceEndMs = maximum + 1;
        const windows = {};
        let valid = Number.isSafeInteger(sourceEndMs);
        for (const period of COMPARISON_PERIOD_KEYS) {
          const range = ranges[period] || {};
          const startMs = range.start == null ? minimum : range.start instanceof Date ? range.start.getTime() : NaN;
          const endMs = range.end == null ? maximum : range.end instanceof Date ? range.end.getTime() : NaN;
          const endExclusiveMs = endMs + 1;
          if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endExclusiveMs) || startMs > endExclusiveMs) {
            valid = false;
            break;
          }
          windows[period] = periodRollupWindow(startMs, endExclusiveMs, minimum, maximum);
        }

        if (valid) {
          const models = new Map();
          const emptyPeriod = () => Object.fromEntries(fields.map(([field]) => [field, 0]));
          const modelResult = (model) => {
            let result = models.get(model);
            if (!result) {
              result = {
                key: model,
                name: model,
                periods: Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, emptyPeriod()])),
              };
              models.set(model, result);
            }
            return result;
          };
          // Seed models that the requested period windows do not touch.
          if (!windows.all || windows.all.startMs > minimum || windows.all.endMs < sourceEndMs) {
            const sourceRows = queryUsageRollupModelsWindow(this.database, {
              ...periodRollupWindow(minimum, sourceEndMs, minimum, maximum),
              excludeHomes,
              canonicalModels: true,
            });
            for (const row of sourceRows) modelResult(row.model);
          }
          for (const period of COMPARISON_PERIOD_KEYS) {
            const window = windows[period];
            if (!window) continue;
            const rows = queryUsageRollupModelsWindow(this.database, {
              ...window,
              excludeHomes,
              canonicalModels: true,
            });
            for (const row of rows) {
              const result = modelResult(row.model);
              result.periods[period] = Object.fromEntries(fields.map(([field]) => [field, Number(row[field] || 0)]));
            }
          }
          this.database.exec("RELEASE period_model_rollup");
          return [...models.values()].sort(
            (left, right) =>
              right.periods.all.total - left.periods.all.total ||
              (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
          );
        }
        this.database.exec("RELEASE period_model_rollup");
      } catch (error) {
        this.database.exec("ROLLBACK TO period_model_rollup");
        this.database.exec("RELEASE period_model_rollup");
        if (error?.code !== "ROLLUP_DAYS_MISSING") throw error;
      }
    }
    const scope = scopeFilterSql(excludeHomes);
    const where = scope.sql ? ` WHERE ${scope.sql}` : "";
    const groupBy = dimensionKey ? ` GROUP BY ${dimensionKey}` : "";
    const orderBy = dimensionKey ? " ORDER BY all__total DESC, dimension_name ASC" : "";
    let rows;
    this.database.exec("SAVEPOINT period_interval_pruning");
    try {
      const bounds = this.eventBounds(excludeHomes);
      const minimum = bounds.minimum === null ? null : Number(bounds.minimum);
      const maximum = bounds.maximum === null ? null : Number(bounds.maximum);
      const parameters = [];
      const measures = [];
      for (const period of COMPARISON_PERIOD_KEYS) {
        const range = ranges[period] || {};
        const start = range.start == null ? null : range.start instanceof Date ? range.start.getTime() : undefined;
        const end = range.end == null ? null : range.end instanceof Date ? range.end.getTime() : undefined;
        const empty =
          minimum === null ||
          (start !== undefined && end !== undefined && start !== null && end !== null && start > end) ||
          (start !== undefined && start !== null && start > maximum) ||
          (end !== undefined && end !== null && end < minimum);
        const coversAll =
          !empty &&
          start !== undefined &&
          end !== undefined &&
          (start === null || start <= minimum) &&
          (end === null || end >= maximum);
        for (const [field, expression] of fields) {
          if (empty) {
            measures.push(`COALESCE(SUM(0), 0) AS "${period}__${field}"`);
          } else if (coversAll) {
            measures.push(`COALESCE(SUM(${expression}), 0) AS "${period}__${field}"`);
          } else {
            measures.push(
              `COALESCE(SUM(CASE WHEN (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?) THEN ${expression} ELSE 0 END), 0) AS "${period}__${field}"`,
            );
            parameters.push(...rangeParameters(range));
          }
        }
      }
      const select = `SELECT ${dimensions} ${measures.join(", ")} FROM events`;
      rows = this.database.prepare(`${select}${where}${groupBy}${orderBy}`).all(...parameters, ...scope.params);
      this.database.exec("RELEASE period_interval_pruning");
    } catch (error) {
      this.database.exec("ROLLBACK TO period_interval_pruning");
      this.database.exec("RELEASE period_interval_pruning");
      throw error;
    }
    return rows.map((row) => {
      const result = {
        key: dimensionKey ? String(row.dimension_key) : "all",
        name: dimensionKey ? String(row.dimension_name) : "全部",
        periods: Object.fromEntries(
          COMPARISON_PERIOD_KEYS.map((period) => [
            period,
            Object.fromEntries(fields.map(([field]) => [field, Number(row[`${period}__${field}`] || 0)])),
          ]),
        ),
      };
      if (includeKind) {
        result.kind = row.dimension_kind;
        result.pathCount = Number(row.path_count || 0);
      }

      return result;
    });
  }
  close() {
    this.releaseReadFunctions?.();
    this.releaseReadFunctions = null;
    this.database = null;
  }
}

export class UsageReader extends UsageQueries {
  constructor(view) {
    if (!view?.database) throw new TypeError("A fixed usage database view is required");
    super(view);
  }
}
