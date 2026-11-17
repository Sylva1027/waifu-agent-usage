import { queryUsageRollupsRange } from "./usage-rollups.js";
import { isQuotaPreset } from "./usage-query.js";

export const PERIOD_DETAIL_FIELDS = [
  ["total", "total"],
  ["input", "CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END"],
  ["inputUnavailableTokens", "CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END"],
  ["cached", "CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END"],
  ["cachedUnavailableTokens", "CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END"],
  ["uncachedInput", "CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END"],
  ["uncachedInputUnavailableTokens", "CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END"],
  ["cacheRateInput", "CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END"],
  ["cacheRateCached", "CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END"],
  ["output", "CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END"],
  ["outputUnavailableTokens", "CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END"],
  ["reasoning", "CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END"],
  ["reasoningUnavailableTokens", "CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END"],
  ["unattributedDetailTokens", "CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END"],
  ["inconsistentTokens", "CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END"],
  ["reconciliationGap", "reconciliation_gap"],
];
export const HISTORY_ARCHIVE_EVENT_AUTHORITY_META = "history_archive_event_authority";

export function canonicalFactPayload(row, excludedColumns = []) {
  const excluded = new Set(excludedColumns);
  if (
    Object.hasOwn(row, "timestamp_ms") &&
    Object.hasOwn(row, "session_id") &&
    !Object.hasOwn(row, "source_event_id")
  ) {
    row = { ...row, source_event_id: "" };
  }
  return Object.fromEntries(
    Object.keys(row)
      .filter((key) => !excluded.has(key))
      .sort()
      .map((key) => [key, row[key]]),
  );
}

export function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** @returns {import("./usage-types.js").UsageTotals} */
export function usageFromRow(row) {
  const values = row || {};
  return {
    total: Number(values.total || 0),
    input: Number(values.input || 0),
    cached: Number(values.cached || 0),
    output: Number(values.output || 0),
    reasoning: Number(values.reasoning || 0),
  };
}

export function compareSqliteText(left, right) {
  return left === right ? 0 : Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function rangeParameters(range) {
  const start = range.start ? range.start.getTime() : null;
  const end = range.end ? range.end.getTime() : null;
  return [start, start, end, end];
}

export function completeRollupDays(range) {
  const zone = range?.calendarZone;
  if (
    (zone !== "utc" && zone !== "local") ||
    isQuotaPreset(range?.preset) ||
    range?.quotaWindow ||
    range?.quotaPreset ||
    !(range?.start instanceof Date) ||
    !(range?.end instanceof Date)
  ) {
    return null;
  }
  const startMs = range.start.getTime();
  const endMs = range.end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (zone === "utc") {
    const dayMs = 86_400_000;
    const endExclusiveMs = endMs + 1;
    if (startMs % dayMs !== 0 || endExclusiveMs % dayMs !== 0) return null;
    return {
      calendarZone: zone,
      startDay: new Date(startMs).toISOString().slice(0, 10),
      endDay: new Date(endExclusiveMs - 1).toISOString().slice(0, 10),
    };
  }
  const start = new Date(startMs);
  const end = new Date(endMs);
  const localMidnight = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const nextLocalMidnight = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  if (localMidnight.getTime() !== startMs || nextLocalMidnight.getTime() - 1 !== endMs) return null;
  return {
    calendarZone: zone,
    startDay: localDateKey(start),
    endDay: localDateKey(end),
  };
}

export function eventRangeFilter(range) {
  if (!isQuotaPreset(range?.preset) && !range?.quotaWindow && !range?.quotaPreset) {
    return {
      sql: "(? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)",
      params: rangeParameters(range),
    };
  }
  const predicates = ["usage_quota_allowed(model, home_id, session_id, timestamp_ms) = 1"];
  const params = [];
  if (range.start) {
    predicates.push("timestamp_ms >= ?");
    params.push(range.start.getTime());
  }
  if (range.end) {
    predicates.push("timestamp_ms <= ?");
    params.push(range.end.getTime());
  }
  return { sql: predicates.length ? predicates.join(" AND ") : "1 = 1", params };
}

export function eventRangeScope(range, scope) {
  const filter = eventRangeFilter(range);
  return {
    sql: withScope(filter.sql, scope),
    params: [...filter.params, ...scope.params],
  };
}

export function periodRollupWindow(startMs, endMs, minimum, maximum) {
  if (startMs >= endMs || startMs > maximum || endMs <= minimum) return null;
  const dayMs = 86_400_000;
  // Outside the scoped fact bounds these prefixes and suffixes are empty.
  return {
    startMs: startMs <= minimum ? Math.floor(minimum / dayMs) * dayMs : startMs,
    endMs: endMs > maximum ? (Math.floor(maximum / dayMs) + 1) * dayMs : endMs,
  };
}

export function scopeFilterSql(excludeHomes = []) {
  const ids = [...new Set((excludeHomes || []).map((value) => String(value)).filter(Boolean))].sort();
  if (!ids.length) {
    return { sql: "", params: [] };
  }
  return { sql: `home_id NOT IN (${ids.map(() => "?").join(", ")})`, params: ids };
}

export function withScope(baseSql, scope) {
  return scope.sql ? `${baseSql} AND ${scope.sql}` : baseSql;
}

export function readMetadataUsageCounts(database, completeBounds = null) {
  database.exec("SAVEPOINT metadata_usage_counts_read");
  try {
    const hasAuthority = Boolean(
      database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META),
    );
    const bounds =
      completeBounds ??
      (hasAuthority
        ? { minimum: null, maximum: null }
        : database.prepare("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events").get());
    if ((!hasAuthority || completeBounds) && bounds.minimum !== null && bounds.maximum !== null) {
      const startDay = new Date(Number(bounds.minimum)).toISOString().slice(0, 10);
      const endDay = new Date(Number(bounds.maximum)).toISOString().slice(0, 10);
      try {
        const complete = queryUsageRollupsRange(database, {
          startDay,
          endDay,
          calendarZone: "utc",
          includeHomeCounts: true,
        });
        return {
          eventCount: complete.eventCount,
          sessionCount: complete.sessionCount,
          homeRows: new Map(
            (complete.homeCounts ?? []).map((row) => [
              row.homeId,
              { event_count: row.eventCount, session_count: row.sessionCount },
            ]),
          ),
        };
      } catch (error) {
        if (error?.code !== "ROLLUP_DAYS_MISSING") throw error;
      }
    }
    const totals = database
      .prepare(
        "SELECT COUNT(*) AS event_count, COUNT(DISTINCT json_array(home_id,session_id)) AS session_count FROM events",
      )
      .get();
    const homeRows = new Map(
      database
        .prepare(`
          SELECT home_id, COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count
          FROM events GROUP BY home_id
        `)
        .all()
        .map((row) => [row.home_id, row]),
    );
    return {
      eventCount: Number(totals.event_count || 0),
      sessionCount: Number(totals.session_count || 0),
      homeRows,
    };
  } catch (error) {
    database.exec("ROLLBACK TO metadata_usage_counts_read");
    throw error;
  } finally {
    database.exec("RELEASE metadata_usage_counts_read");
  }
}

export function currentLocalRollupZoneIdentity() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || `offset:${new Date().getTimezoneOffset()}`;
}
