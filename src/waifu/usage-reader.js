import {
  publishedUsageEventFromRow,
  publishedUsageHomesFromDatabase,
  quotaObservationsFromDatabase,
  publishedUsageSessionsFromEvents,
} from "../usage-published.js";
export {
  publishedUsageEventFromRow,
  publishedUsageHomesFromDatabase,
  quotaObservationsFromDatabase,
  publishedUsageSessionsFromEvents,
  canonicalizeKind,
} from "../usage-published.js";
import { createStoredQuotaSourceResolver } from "../usage-quota-source-store.js";
import {
  currentLocalRollupZoneIdentity,
  readMetadataUsageCounts,
  scopeFilterSql,
  localDateKey,
  eventRangeScope,
  usageFromRow,
  HISTORY_ARCHIVE_EVENT_AUTHORITY_META,
  compareSqliteText,
} from "../usage-sql.js";
import { createFusedSummaryGroups } from "../usage-summary-groups.js";
import { rangeMetricsFromGroups, usageHarness } from "../../public/range-metrics.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareStoredMetadata, readStoredMetadata } from "../usage-metadata-store.js";
import {
  isQuotaPreset,
  previousUsageRange,
  resolveDateRange,
  summaryRangeFields,
  usageComparisonFromAggregates,
} from "../usage-query.js";
import {
  createUsageRollups,
  listDirtyUsageRollupDays,
  localUsageRollupDaysForUtcDays,
  rebuildUsageRollups,
  tryAppendUsageRollups,
  tryInitializeUsageRollups,
  checkpointUsageRollups,
} from "../usage-rollups.js";
import {
  API_PRICING_VERSION,
  createCostEstimateAccumulator,
  createEventPricing,
  estimateEventCost,
  getPricingCatalog,
  estimateCostForEvents,
} from "../pricing.js";
import { HistoryQuoteInputs } from "../history-quote-inputs.js";
import {
  ensureUsageAllSummarySchema,
  buildStoredAllSummary,
  readStoredAllSummary,
} from "../usage-all-summary-store.js";
import {
  selectStoredQuotaWindows,
  readStoredQuotaWindows,
  readStoredCompletedQuotaWindows,
  quotaProjectionWork,
} from "../usage-quota-store.js";
import { buildStoredRecordChampions, readStoredRecordChampions } from "../usage-record-store.js";
import { buildModelActivity, canonicalModelName } from "../../public/pricing-models.js";
import { sessionIdentity } from "../../public/usage-fields.js";
import { cacheHitRate } from "../../public/usage-metrics.js";
import { COMPARISON_PERIOD_KEYS, addPeriodEvent, emptyPeriodMetrics } from "../../public/period-comparison.js";
import { createHash } from "node:crypto";
import { sourceGroup, homeSourceKinds, deriveTimelineBucket, previousQuotaRange } from "../../public/timeline-utils.js";
import { quotaRecordsForRange, quotaRecordValues, buildTimelineRows } from "../../public/waifu-timeline.js";
import { serviceTierEvidenceSnapshot } from "../service-tier-evidence.js";
import { UsageQueries } from "../usage-reader.js";
import { UsageSessionMembers } from "../usage-session-members.js";
import { createWaifuAllSummaryExtension } from "./usage-all-summary.js";
export function harnessModelName(channel) {
  const value = String(channel || "").toLowerCase();
  if (value === "oh my pi") return "Oh My Pi";
  return value.startsWith("zcode")
    ? "ZCode"
    : value.startsWith("dsh")
      ? "DSH"
      : value.startsWith("opencode")
        ? "OpenCode"
        : value.startsWith("claude")
          ? "Claude"
          : value.startsWith("hermes")
            ? "Hermes"
            : value.startsWith("workbuddy")
              ? "WorkBuddy"
              : "Codex";
}
export const DEFAULT_EVENT_COST_ESTIMATOR = estimateEventCost;
export function startOfLocalWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}
export function createFusedMetadataObservations() {
  const channels = new Map();
  return {
    add(event) {
      let models = channels.get(event.channel);
      if (!models) {
        models = new Map();
        channels.set(event.channel, models);
      }
      let homes = models.get(event.model);
      if (!homes) {
        homes = new Map();
        models.set(event.model, homes);
      }
      homes.set(event.homeId, Math.max(homes.get(event.homeId) ?? -Infinity, event.timestamp));
    },
    result() {
      const rows = [];
      for (const [channel, models] of channels) {
        for (const [model, homes] of models) {
          for (const [home_id, last_seen] of homes) rows.push({ channel, model, home_id, last_seen });
        }
      }
      rows.sort(
        (a, b) =>
          compareSqliteText(a.channel, b.channel) ||
          compareSqliteText(a.model, b.model) ||
          compareSqliteText(a.home_id, b.home_id),
      );
      return rows;
    },
  };
}
export function createFusedSummaryRepositories(periodRanges, aliases = null) {
  const groups = new Map();
  const windows = Object.entries(periodRanges).map(([key, range]) => [
    key,
    range.start?.getTime() ?? -Infinity,
    range.end?.getTime() ?? Infinity,
  ]);
  let safe = true;
  return {
    add(event) {
      const alias = aliases?.resolve(event.repositoryKey);
      const key = alias?.key ?? event.repositoryKey;
      const name = alias?.path ?? event.repositoryPath;
      const kind = alias?.kind ?? event.repositoryKind;
      const group = groups.get(key) || {
        key,
        name,
        kind,
        minimumKind: kind,
        paths: new Set(),
        firsts: new Map(),
        count: 0,
        magnitude: 0,
        periods: Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, emptyPeriodMetrics()])),
        total: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
      };
      if (compareSqliteText(name, group.name) < 0) group.name = name;
      if (compareSqliteText(kind, group.kind) > 0) group.kind = kind;
      if (compareSqliteText(kind, group.minimumKind) < 0) group.minimumKind = kind;
      if (event.cwd) group.paths.add(event.cwd);
      const member = sessionIdentity(event.homeId, event.sessionId);
      const first = group.firsts.get(member);
      if (first === undefined || event.timestamp < first) group.firsts.set(member, event.timestamp);
      group.count += 1;
      group.total.total += event.total.total;
      group.total.input += event.total.input;
      group.total.cached += event.total.cached;
      group.total.output += event.total.output;
      group.total.reasoning += event.total.reasoning;
      // Bound every subset metric too, so cancellation cannot hide an unsafe intermediate sum.
      group.magnitude +=
        Math.abs(event.total.total) +
        Math.abs(event.total.input) +
        Math.abs(event.total.cached) +
        Math.abs(event.total.output) +
        Math.abs(event.total.reasoning) +
        Math.abs(event.reconciliationGap || 0);
      safe &&= Number.isSafeInteger(group.magnitude);
      if (safe) {
        for (const [key, start, end] of windows) {
          if (event.timestamp >= start && event.timestamp <= end) addPeriodEvent(group.periods[key], event);
        }
      }
      groups.set(key, group);
    },
    result() {
      if (!safe) return null;
      const rows = [];
      const firsts = [];
      for (const { key, name, kind, paths, firsts: sessions, count, total } of groups.values()) {
        rows.push({ key, name, kind, pathCount: paths.size, count, sessions: sessions.size, total });
        for (const [member, first_ms] of sessions) {
          const [home_id, session_id] = JSON.parse(member);
          firsts.push({ repository_key: key, home_id, session_id, first_ms });
        }
      }
      rows.sort(
        (a, b) => b.total.total - a.total.total || compareSqliteText(a.name, b.name) || compareSqliteText(a.key, b.key),
      );
      firsts.sort((a, b) => compareSqliteText(a.repository_key, b.repository_key) || a.first_ms - b.first_ms);
      const periodRepositories = rows.map(({ key, name, pathCount }) => {
        const group = groups.get(key);
        return { key, name, kind: group.minimumKind, pathCount, periods: group.periods };
      });
      return { rows, firsts, periodRepositories };
    },
  };
}
export function periodComparisonKey(now, zone, excludeHomes, pricingModels) {
  const modelKeys = Object.keys(pricingModels).sort().join("\u0000");
  return `${modelKeys}|${zone}|${zone === "utc" ? now.toISOString().slice(0, 10) : localDateKey(now)}|${[...excludeHomes].map(String).sort().join(",")}`;
}
export const RECORD_METRICS = Object.freeze({
  totalTokens: { kind: "sum", field: "total", title: "总 tokens 最高" },
  inputTokens: { kind: "sum", field: "input", title: "总输入最高" },
  cachedTokens: { kind: "sum", field: "cached", title: "缓存读取最高" },
  outputTokens: { kind: "sum", field: "output", title: "输出最高" },
  reasoningTokens: { kind: "sum", field: "reasoning", title: "推理输出最高" },
  sessionCount: { kind: "count", field: "sessions", title: "会话最多" },
  modelCount: { kind: "count", field: "models", title: "模型数量最多" },
  cacheHitRate: { kind: "ratio", title: "缓存命中最高" },
  totalCost: { kind: "cost", field: "total", title: "估算花销最高" },
  inputCost: { kind: "cost", field: "input", title: "缓外输入花销最高" },
  cachedCost: { kind: "cost", field: "cached", title: "缓存输入花销最高" },
  outputCost: { kind: "cost", field: "output", title: "输出花销最高" },
});
export const RECORD_UNIT_LABELS = Object.freeze({ day: "一日", week: "一周", month: "一个月" });
export function emptyRecordPeriods() {
  return { day: new Map(), week: new Map(), month: new Map() };
}
export function recordPeriodKeys(timestampMs, zone, storedKeys = null) {
  const date = new Date(timestampMs);
  if (zone === "utc") {
    const day = date.toISOString().slice(0, 10);
    const week = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() || 7) - 1)),
    )
      .toISOString()
      .slice(0, 10);
    return { day, week, month: day.slice(0, 7) };
  }
  if (storedKeys) {
    return {
      day: String(storedKeys.day || ""),
      week: String(storedKeys.week || ""),
      month: String(storedKeys.month || ""),
    };
  }
  const day = localDateKey(date);
  return { day, week: localDateKey(startOfLocalWeek(date)), month: day.slice(0, 7) };
}
export function accumulateRecordEstimate(
  periods,
  { timestampMs, sessionId, homeId, model, total, estimate, storedKeys = null },
  zone,
  rate,
) {
  const keys = recordPeriodKeys(timestampMs, zone, storedKeys);
  const scale = estimate.currency === "CNY" ? 1 : rate;
  for (const unit of ["day", "week", "month"]) {
    const key = keys[unit];
    let slot = periods[unit].get(key);
    if (!slot) {
      slot = {
        key,
        total: 0,
        input: 0,
        cached: 0,
        output: 0,
        reasoning: 0,
        sessions: new Set(),
        models: new Set(),
        cost: { total: 0, input: 0, cached: 0, output: 0 },
      };
      periods[unit].set(key, slot);
    }
    slot.total += Number(total.total || 0);
    slot.input += Number(total.input || 0);
    slot.cached += Number(total.cached || 0);
    slot.output += Number(total.output || 0);
    slot.reasoning += Number(total.reasoning || 0);
    slot.sessions.add(sessionIdentity(homeId, sessionId));
    slot.models.add(model);
    slot.cost.total += Number(estimate.totalUsd || 0) * scale;
    slot.cost.input += Number(estimate.inputUsd || 0) * scale;
    slot.cost.cached += Number(estimate.cachedInputUsd || 0) * scale;
    slot.cost.output += Number(estimate.outputUsd || 0) * scale;
  }
}
export function rankRecordChampions(periods) {
  const slotValues = (slot) => ({
    totalTokens: slot.total,
    inputTokens: slot.input,
    cachedTokens: slot.cached,
    outputTokens: slot.output,
    reasoningTokens: slot.reasoning,
    sessionCount: slot.sessions.size,
    modelCount: slot.models.size,
    cacheHitRate: slot.input > 0 ? slot.cached / slot.input : null,
    totalCost: slot.cost.total,
    inputCost: slot.cost.input,
    cachedCost: slot.cost.cached,
    outputCost: slot.cost.output,
  });

  const champions = { day: {}, week: {}, month: {} };
  for (const metric of Object.keys(RECORD_METRICS)) {
    for (const unit of ["day", "week", "month"]) {
      const ranked = [...periods[unit].values()]
        .map((slot) => ({ key: slot.key, value: slotValues(slot)[metric] }))
        .filter((entry) => Number.isFinite(entry.value) && entry.value > 0)
        .sort((left, right) => right.value - left.value);
      // “至少两期可比”：少于两期无从比较；**并列**（前两名相等）不是新高 ⇒ 不点亮。
      if (ranked.length < 2 || ranked[0].value <= ranked[1].value) continue;
      champions[unit][metric] = { period: ranked[0].key, value: ranked[0].value };
    }
  }
  return champions;
}
export function recordUnitBoundaries(key, unit, zone = "local") {
  if (unit === "day") {
    const start = parseDateKey(key, zone);
    return start ? [start.getTime(), addDaysMs(start, 1)] : null;
  }
  if (unit === "week") {
    const start = parseDateKey(key, zone);
    return start ? [start.getTime(), addDaysMs(start, 7)] : null;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(key || "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  return zone === "utc"
    ? [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)]
    : [new Date(year, month, 1).getTime(), new Date(year, month + 1, 1).getTime()];
}
export function parseDateKey(key, zone = "local") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  return zone === "utc" ? new Date(Date.UTC(year, month, day)) : new Date(year, month, day);
}
export function addDaysMs(date, days) {
  return date.getTime() + days * 24 * 60 * 60 * 1000;
}

export const COST_EVENT_COLUMNS =
  "timestamp_ms, session_id, home_id, home_label, source_path, channel, model, project, detail_mask, cache_write_tokens, cache_write_known, request_input_tokens, context_level, service_tier, price_version, total, input, cached, output, reasoning";
export function costEventFromRow(row, tierEvidence, sourceKind) {
  const timestamp = Number(row.timestamp_ms);
  const sessionId = String(row.session_id);
  return {
    timestamp,
    sessionId,
    homeId: String(row.home_id),
    homeLabel: String(row.home_label),
    sourcePath: String(row.source_path),
    sourceKind,
    channel: String(row.channel),
    model: String(row.model),
    project: String(row.project),
    detailMask: Number(row.detail_mask || 0),
    cacheWriteTokens: Number(row.cache_write_tokens || 0),
    cacheWriteKnown: Boolean(row.cache_write_known),
    requestInputTokens: Number(row.request_input_tokens || 0),
    contextLevel: String(row.context_level),
    serviceTier:
      (!["hermes", "omp"].includes(sourceKind) &&
        tierEvidence?.resolve(sessionId, timestamp, String(row.service_tier))) ||
      String(row.service_tier),
    priceVersion: String(row.price_version),
    total: usageFromRow(row),
  };
}
export function costEventFromRowArray(row, tierEvidence, sourceKind) {
  const timestamp = Number(row[0]);
  const sessionId = String(row[1]);
  return {
    timestamp,
    sessionId,
    homeId: String(row[2]),
    homeLabel: String(row[3]),
    sourcePath: String(row[4]),
    sourceKind,
    channel: String(row[5]),
    model: String(row[6]),
    project: String(row[7]),
    detailMask: Number(row[8] || 0),
    cacheWriteTokens: Number(row[9] || 0),
    cacheWriteKnown: Boolean(row[10]),
    requestInputTokens: Number(row[11] || 0),
    contextLevel: String(row[12]),
    serviceTier:
      (!["hermes", "omp"].includes(sourceKind) && tierEvidence?.resolve(sessionId, timestamp, String(row[13]))) ||
      String(row[13]),
    priceVersion: String(row[14]),
    total: {
      total: Number(row[15] || 0),
      input: Number(row[16] || 0),
      cached: Number(row[17] || 0),
      output: Number(row[18] || 0),
      reasoning: Number(row[19] || 0),
    },
  };
}

export class WaifuUsageQueries extends UsageQueries {
  /** The first persistent path serves the hot, all-source dashboard only. @returns {any} */
  allSummaryOptions(filters = {}, options = {}, range = null, bucket = null) {
    const history = this.historyPersistentRead;
    if (
      this.deferredMetadataIndex ||
      filters.preset !== "all" ||
      options.includeDetails !== false ||
      (filters.excludeHomes || []).length ||
      this.writeTransactionDepth > 0 ||
      (this.verifiedHistorySqlRead && !history) ||
      this.serviceTierEvidenceInput === null ||
      (!history &&
        this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)) ||
      Number(this.database.prepare("PRAGMA reverse_unordered_selects").get().reverse_unordered_selects) !== 0 ||
      this.database
        .prepare("PRAGMA index_list(events)")
        .all()
        .some((row) => Number(row.unique) !== 0)
    )
      return null;
    let evidence;
    try {
      evidence = this.serviceTierEvidence ? serviceTierEvidenceSnapshot(this.serviceTierEvidence) : null;
    } catch {
      return null;
    }
    const sourceKinds = this.historySourceKinds ?? homeSourceKinds(this.homes);
    const sources = this.database.prepare("SELECT home_id,kind FROM source_files").all();
    if (
      sources.some((row) => sourceGroup("", String(row.kind)) !== sourceGroup("", sourceKinds.get(String(row.home_id))))
    )
      return null;
    if (!range) {
      const bounds = this.eventBounds();
      const events = [bounds.minimum, bounds.maximum]
        .filter((value) => value !== null)
        .map((value) => ({ timestamp: new Date(Number(value)).toISOString() }));
      range = resolveDateRange(filters, events);
    }
    bucket ||= deriveTimelineBucket(range, range.bucket || filters.bucket || "day");
    if (!["day", "week", "month"].includes(bucket)) return null;
    // Preserve the legacy rowid accumulation order, including floating-point tails.
    if (!history) {
      const legacyWhere = eventRangeScope(range, scopeFilterSql([]));
      const legacyPlan = this.database
        .prepare(`EXPLAIN QUERY PLAN SELECT ${COST_EVENT_COLUMNS} FROM events WHERE ${legacyWhere.sql}`)
        .all(...legacyWhere.params);
      if (legacyPlan.length !== 1 || legacyPlan[0].detail !== "SCAN events") return null;
    }
    const catalog = getPricingCatalog();
    const pricingModels = filters.pricingModels ?? catalog.models;
    const schema = history
      ? this.historyProjectionInput.schema
      : Number(this.database.prepare("PRAGMA main.schema_version").get().schema_version);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          history ? "history-all-summary-v1" : "all-summary-v3",
          schema,
          bucket,
          range.calendarZone || "local",
          currentLocalRollupZoneIdentity(),
          catalog.version,
          catalog.models,
          catalog.usdToCnyRate,
          pricingModels,
          this.serviceTierEvidenceInput,
          evidence,
          this.homes,
        ]),
      )
      .digest("hex");
    const store = this;
    const pricing = createEventPricing(pricingModels);
    return {
      database: this.database,
      ...(history ? { mode: "history" } : {}),
      key: `${API_PRICING_VERSION}:${key}`,
      range,
      bucket,
      requestedBucket: filters.bucket || "day",
      sourceKinds,
      pricingModels,
      pricing,
      extension: createWaifuAllSummaryExtension(pricing),
      *eventsAfter(position, limit) {
        const query = store.database.prepare(
          history
            ? `SELECT history_ordinal,${COST_EVENT_COLUMNS} FROM events
          WHERE (timestamp_ms,history_ordinal)>(?,?) ORDER BY timestamp_ms,history_ordinal LIMIT ?`
            : `SELECT id,${COST_EVENT_COLUMNS} FROM events WHERE id>? ORDER BY id LIMIT ?`,
        );
        query.setReturnArrays(true);
        for (const value of query.iterate(...(history ? [position.ms, position.id, limit] : [position.id, limit]))) {
          const row = /** @type {any[]} */ (/** @type {unknown} */ (value));
          const event = costEventFromRowArray(row.slice(1), store.serviceTierEvidence, sourceKinds.get(String(row[3])));
          yield { ...event, id: Number(row[0]) };
        }
      },
    };
  }
  /** @param {any} view @param {any} pricing */
  constructor(
    view = {},
    {
      eventCostMemo,
      serviceTierEvidence = null,
      serviceTierEvidenceInput = null,
      deferredMetadataIndex = false,
      writeTransactionDepth = 0,
    } = {},
  ) {
    super(view);
    this.eventCostMemo = eventCostMemo;
    this.serviceTierEvidence = serviceTierEvidence;
    this.serviceTierEvidenceInput = serviceTierEvidenceInput;
    this.deferredMetadataIndex = deferredMetadataIndex;
    this.writeTransactionDepth = writeTransactionDepth;
    this.storeRevision = view.revision ?? 0;
    this.derivedRevision = this.storeRevision;
    this.metadataCache = this.metadataObservationCache = this.recordChampionCache = null;
    this.quotaObservationCache = this.summaryProjectionCache = this.rangeMetricsCache = null;
    this.periodComparisonCache = new Map();
    this.ownsPeriodComparisonCache = true;
    this.usageProjectionTracker = null;
    this.businessProjectionIgnoredChanges = 0;
    this.summaryProjectionTransferableRead = false;
    this.summarySnapshotRead = this.metadataSnapshotRead = this.periodComparisonSnapshotRead = true;
    this.readPricingModels = null;
    this.ownsDatabase = false;
    this.ownsEventCostMemo = false;
    this.withVerifiedRead = null;
    this.registeredReadDatabase = null;
    this.quotaSourceLookup = this.quotaSourceDatabase = null;
    this.quotaSourceRevision = -1;
  }

  /** @param {import("../usage-types.js").UsageRange} range
   * @returns {Generator<import("../usage-types.js").IndexedCostEvent>}
   */
  *costEventsForRange(range, excludeHomes = [], includeRepositories = false) {
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const columns = includeRepositories
      ? `${COST_EVENT_COLUMNS}, repository_key, repository_path, repository_kind, cwd, reconciliation_gap`
      : COST_EVENT_COLUMNS;
    const statement = this.database.prepare(
      `SELECT ${columns} FROM events WHERE ${where.sql}${
        this.historyDiskRead ? ` ORDER BY ${this.historyPersistentRead ? "timestamp_ms,history_ordinal" : "id"}` : ""
      }`,
    );
    const sourceKinds = this.historySourceKinds ?? homeSourceKinds(this.homes);
    if (typeof statement.setReturnArrays === "function") {
      statement.setReturnArrays(true);
      for (const row of statement.iterate(...where.params)) {
        const event = costEventFromRowArray(row, this.serviceTierEvidence, sourceKinds.get(String(row[2])));
        if (includeRepositories) {
          event.repositoryKey = String(row[20]);
          event.repositoryPath = String(row[21]);
          event.repositoryKind = String(row[22]);
          event.cwd = String(row[23]);
          event.reconciliationGap = Number(row[24]);
        }
        yield event;
      }
      return;
    }
    for (const row of statement.iterate(...where.params)) {
      const event = costEventFromRow(row, this.serviceTierEvidence, sourceKinds.get(String(row.home_id)));
      if (includeRepositories) {
        event.repositoryKey = String(row.repository_key);
        event.repositoryPath = String(row.repository_path);
        event.repositoryKind = String(row.repository_kind);
        event.cwd = String(row.cwd);
        event.reconciliationGap = Number(row.reconciliation_gap);
      }
      yield event;
    }
  }

  /** @param {import("../usage-types.js").UsageRange} range */
  costEstimateRange(range, excludeHomes = []) {
    return this.withEventCostMemoRound(() =>
      estimateCostForEvents(this.costEventsForRange(range, excludeHomes), {
        estimateEventCost: (event) => this.eventCostMemo.estimate(event),
      }),
    );
  }

  /**
   * W4-b1 / D1：把一段"逐事件计价"包成 memo 的**一轮**。
   *
   * 轮内放宽到 `hardMaxBytes`（192 MiB），保证"本轮的中间结果"不会因为刚好越线而被立刻逐出；
   * 轮末收敛回 `maxBytes`（64 MiB）。可嵌套（深度计数）—— 一次 `summarize` 会同时进入
   * `buildRecordChampions` 与 `timelineRange`。
   * @template T
   * @param {() => T} run
   * @returns {T}
   */
  withEventCostMemoRound(run) {
    this.eventCostMemo.beginRound();
    try {
      return run();
    } finally {
      this.eventCostMemo.endRound();
    }
  }

  /** @param {import("../usage-types.js").UsageRange} range
   * @param {string} bucket
   * @param {{ onEstimate?: (event: any, estimate: any, bucketKey?: string) => void, excludeHomes?: string[], pricingModels?: Record<string, any>, factRows?: any[], includeRepositories?: boolean, pricing?: ReturnType<typeof import("../pricing.js").createEventPricing>, quoteInputs?: import("../history-quote-inputs.js").HistoryQuoteInputs }} [options]
   */
  timelineRange(
    range,
    bucket,
    { onEstimate, excludeHomes = [], pricingModels, factRows, includeRepositories = false, pricing, quoteInputs } = {},
  ) {
    // Quote replay uses the same price and timeline accumulators as the original streaming read.
    const members = new UsageSessionMembers();
    try {
      return this.withEventCostMemoRound(() =>
        buildTimelineRows(
          quoteInputs ? quoteInputs.events() : this.costEventsForRange(range, excludeHomes, includeRepositories),
          range,
          bucket,
          {
            sourceKinds: this.historySourceKinds ?? homeSourceKinds(this.homes),
            pricingModels,
            factRows,
            eventBucketKey: quoteInputs ? (event) => event.quoteBucketKey : undefined,
            modelName: pricing?.modelName,
            estimateCost: pricing?.estimate ?? estimateEventCost,
            onEstimate,
            createSessionSet: () => members.createSet(),
          },
        ),
      );
    } finally {
      members.close();
    }
  }

  /**
   * D3：**已提交 quota 观测的规范映射**（`rate_limit_observations` 行 ⇒ 规范对象，单槽复用）。
   *
   * 契约（本卡红线）：这里**只缓存静态输入**。返回对象里只有"已提交观测行"的字段
   * （`source_path` / `line_number` / `role` / `observed_at_ms` / `limit_id` / `limit_name` /
   * `plan_type` / `window_minutes` / `resets_at_ms` / `used_percent`），**没有任何时间派生字段**：
   * 窗口边界、`state`（available / waiting / missing / ambiguous）、`percentStale`、倒计时、reset
   * 语义一律由消费者**每次**用当前或冻结的 `asOf` 现算（`selectQuotaWindows(rows, asOf)`；
   * `resolveDateRange({ …filters, now: asOf, quota })`）。`resetsAtMs` 是**观测里的原始输入**，
   * 不是"相对现在的重置语义"。
   *
   * 为什么复用：同一次 `summarizeInReadTransaction` 里它被调用**两次**（`:4834` 选窗口 +
   * `:4918` 逐范围记录），而且每次 `summarize` 至少调用一次 ⇒ 缓存后
   * "**一次读取 + 一次规范映射，两个消费者共用**"（`selectQuotaWindows` 与
   * `quotaRecordsForRange` 都只读这份映射，不复制、不改写）。
   *
   * 失效（沿 D1 机制，不自建 TTL / 事件总线 / 计数表）：键 = `this.storeRevision`
   * （自身写入、外部提交 `PRAGMA data_version`、service-tier evidence 都会推进它）；
   * `syncDerivedRevision()` / `open()` / `close()` 复位；写事务内
   * （`writeTransactionDepth > 0`）读到的是**未提交**状态 ⇒ **不读也不写**（D1 的回滚语义）。
   * 调用方自有快照可传 `useCache: false`，复用同一 SELECT/codec 但绕过 memo。
   *
   * @param {{ useCache?: boolean }} [options]
   * @returns {object[]} 规范映射本身（**只读**；调用方不得就地改写）
   */
  quotaObservations({ useCache = true } = {}) {
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    // D1：写事务内**不读也不写**共享缓存（读到的是未提交状态 ⇒ 回滚后它会说谎）。
    const cacheable = useCache && this.writeTransactionDepth === 0;
    if (cacheable && this.quotaObservationCache?.revision === this.storeRevision) {
      return this.quotaObservationCache.rows;
    }
    const rows = quotaObservationsFromDatabase(this.database, this.verifiedHistorySqlRead && !this.historyDiskRead);
    if (cacheable) this.quotaObservationCache = { revision: this.storeRevision, rows };
    return rows;
  }

  nonCodexHomeIds() {
    // 限额窗口只衡量 Codex 用量：main/jetbrains/extra/codex 之外的目录（zcode、dsh、opencode、project-log）
    // 只在普通范围里计入统计，不能进入限额聚合。
    return this.database
      .prepare(
        "SELECT DISTINCT home_id AS id FROM source_files WHERE kind NOT IN ('main', 'jetbrains', 'extra', 'codex')",
      )
      .all()
      .map((row) => row.id)
      .filter((id) => typeof id === "string" && id.length > 0);
  }

  /** @param {Date | number} [asOf] */
  storedMetadata(asOf = new Date()) {
    if (
      this.writeTransactionDepth > 0 ||
      (this.verifiedHistorySqlRead && !this.historyPersistentRead) ||
      (!this.historyPersistentRead &&
        this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)) ||
      this.database
        .prepare("PRAGMA index_list(events)")
        .all()
        .some((row) => Number(row.unique) !== 0)
    )
      return null;
    this.database.exec("SAVEPOINT metadata_projection_read");
    try {
      return readStoredMetadata(this.database, typeof asOf === "number" ? asOf : asOf.getTime());
    } finally {
      this.database.exec("RELEASE metadata_projection_read");
    }
  }

  readMetadata(asOf = new Date()) {
    this.assertSourceRepairsComplete();
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    // D1：写事务内读到的是**未提交**状态 ⇒ 这一轮**不落**共享缓存（验收："事务内已读的派生缓存
    // 被安全清理" —— 预防 + 回滚时再清一次，见 `rollbackReplaceFileTransaction`）。
    const cacheable = this.writeTransactionDepth === 0;
    let persistedMetadata = null;
    if (cacheable && (!this.metadataCache || this.metadataObservationCache?.revision !== this.storeRevision)) {
      persistedMetadata = this.storedMetadata(Number.MAX_SAFE_INTEGER);
      if (persistedMetadata) {
        const rows = persistedMetadata.observationRows;
        this.metadataObservationCache = {
          revision: this.storeRevision,
          rows,
          maxTimestampMs: rows.reduce((n, row) => Math.max(n, Number(row.last_seen)), -Infinity),
        };
      }
    }
    /** D1：不可缓存时（写事务内）用的**本次调用**快照；绝不写回 `this.metadataCache`。 */
    let builtMetadata = null;
    if (!this.metadataCache) {
      const counts =
        persistedMetadata ??
        readMetadataUsageCounts(this.database, this.verifiedHistorySqlRead ? this.eventBounds() : null);
      // 按实际使用记录给出各 harness（Codex / ZCode / DSH / OpenCode / Claude / WorkBuddy）用到的模型名称。
      const harnessModels = {
        Codex: new Set(),
        ZCode: new Set(),
        DSH: new Set(),
        OpenCode: new Set(),
        Claude: new Set(),
        WorkBuddy: new Set(),
        Hermes: new Set(),
        "Oh My Pi": new Set(),
      };
      const modelRows =
        persistedMetadata?.modelRows ??
        (cacheable && this.metadataObservationCache?.revision === this.storeRevision
          ? this.metadataObservationCache.rows
          : this.database.prepare("SELECT DISTINCT channel, model FROM events").all());
      for (const row of modelRows) {
        const model = String(row.model || "").trim();
        if (!model || model.toLocaleLowerCase() === "unknown model") continue;
        harnessModels[harnessModelName(row.channel)].add(model);
      }
      builtMetadata = {
        generatedAt: this.generatedAt,
        eventCount: counts.eventCount,
        sessionCount: counts.sessionCount,
        homeCount: this.homes.length,
        harnessModels: {
          Codex: [...harnessModels.Codex].sort((a, b) => a.localeCompare(b)),
          ZCode: [...harnessModels.ZCode].sort((a, b) => a.localeCompare(b)),
          DSH: [...harnessModels.DSH].sort((a, b) => a.localeCompare(b)),
          OpenCode: [...harnessModels.OpenCode].sort((a, b) => a.localeCompare(b)),
          Claude: [...harnessModels.Claude].sort((a, b) => a.localeCompare(b)),
          WorkBuddy: [...harnessModels.WorkBuddy].sort((a, b) => a.localeCompare(b)),
          Hermes: [...harnessModels.Hermes].sort((a, b) => a.localeCompare(b)),
          "Oh My Pi": [...harnessModels["Oh My Pi"]].sort((a, b) => a.localeCompare(b)),
        },
        homes: this.homes.map((home) => {
          const row = counts.homeRows.get(home.id);
          return {
            ...home,
            status: row ? "active" : "no-events",
            eventCount: Number(row?.event_count || 0),
            sessionCount: Number(row?.session_count || 0),
          };
        }),
        warnings: this.warnings,
      };
      // D1：写事务内**不落**共享缓存；正常路径（深度 0）才把它提升为实例级派生缓存。
      if (cacheable) this.metadataCache = builtMetadata;
    }
    // Re-evaluate time even without new files; exclude future events before MAX.
    //
    // D4：观测聚合按**实际变更**复用（键 = D1 的 `storeRevision`）。缓存里只有**静态输入**
    // ——`events` 的原始分组行 `{channel, model, home_id, last_seen}`（未过滤）——而 `asOf`
    // 的时间语义仍**每次现算**：
    //   * `asOf >= 全表最大 timestamp`（不存在未来事件）⇒ `timestamp_ms <= asOf` 是**恒等**过滤
    //     ⇒ 直接复用未过滤行（该次请求 0 次查询、0 行映射）；
    //   * `asOf < 全表最大 timestamp`（确有未来事件）⇒ "哪些事件算未来"随 `asOf` 变化 ⇒ **必须**
    //     每次按当前 `asOf` 现算，**绝不**使用缓存（未来事件过滤语义不得被缓存吃掉）。
    const asOfMs = asOf.getTime();
    const sourceKinds = homeSourceKinds(this.homes);
    /** `timestamp_ms <= cutoffMs` 的分组 MAX；`cutoffMs === null` 表示未过滤（用于静态输入）。 */
    const queryObservationRows = (cutoffMs) => {
      const sql = `SELECT channel, model, home_id, MAX(timestamp_ms) AS last_seen FROM events${
        cutoffMs === null ? "" : " WHERE timestamp_ms <= ?"
      } GROUP BY channel, model, home_id`;
      return cutoffMs === null ? this.database.prepare(sql).all() : this.database.prepare(sql).all(cutoffMs);
    };
    let observationRows = null;
    if (cacheable) {
      const cached = this.metadataObservationCache;
      if (!cached || cached.revision !== this.storeRevision) {
        const rows = queryObservationRows(null);
        this.metadataObservationCache = {
          revision: this.storeRevision,
          rows,
          maxTimestampMs: rows.reduce((max, row) => Math.max(max, Number(row.last_seen)), -Infinity),
        };
      }
      const memo = this.metadataObservationCache;
      observationRows =
        asOfMs >= memo.maxTimestampMs
          ? memo.rows
          : (this.storedMetadata(asOf)?.observationRows ?? queryObservationRows(asOfMs));
    } else {
      // D1：写事务内读到的是**未提交**状态 ⇒ 不读也不写共享缓存，用本次调用快照。
      observationRows = queryObservationRows(asOfMs);
    }
    const observations = observationRows.map((row) => {
      const group = sourceGroup(row.channel, sourceKinds.get(String(row.home_id)));
      return {
        model: row.model,
        timestamp: Number(row.last_seen),
        harness: ["ZCode", "DSH", "OpenCode", "Claude", "WorkBuddy", "Hermes", "Oh My Pi"].includes(group)
          ? group
          : "Codex",
      };
    });
    // D1：可缓存时用实例级缓存（同一对象、可被 C5 用例按引用断言）；写事务内用本次快照。
    return {
      ...structuredClone(this.metadataCache ?? builtMetadata),
      generatedAt: this.generatedAt,
      ...buildModelActivity(observations, asOf),
    };
  }

  rangeMetrics(range, excludeHomes = []) {
    const kinds = this.historySourceKinds ?? homeSourceKinds(this.homes);
    const where = eventRangeScope(range, scopeFilterSql(excludeHomes));
    const key = JSON.stringify([
      this.storeRevision,
      this.usageProjectionChangeKey(),
      where,
      range.calendarZone,
      [...kinds],
    ]);
    if (
      !this.writeTransactionDepth &&
      this.rangeMetricsCache?.database === this.database &&
      this.rangeMetricsCache.key === key
    )
      return structuredClone(this.rangeMetricsCache.value);
    const query = (sql) => this.database.prepare(sql).all(...where.params);
    const positive = `FROM events WHERE (${where.sql}) AND total > 0`;
    const day = range.calendarZone === "utc" ? "date(timestamp_ms/1000.0,'unixepoch')" : "usage_day_key(timestamp_ms)";
    const hour =
      range.calendarZone === "utc"
        ? "timestamp_ms - ((timestamp_ms % 3600000) + 3600000) % 3600000"
        : "usage_hour_start(timestamp_ms)";
    const days = query(`SELECT ${day} AS key, TOTAL(total) AS total ${positive} GROUP BY 1`);
    const hours = query(`SELECT ${hour} AS key, TOTAL(total) AS total ${positive} GROUP BY 1`);
    const sessions = query(
      `SELECT MAX(total) AS total FROM (SELECT TOTAL(total) AS total ${positive} GROUP BY home_id,session_id)`,
    );
    const rawHarnesses = query(`SELECT home_id,channel,TOTAL(total) AS total ${positive} GROUP BY home_id,channel`);
    const harnesses = new Map();
    for (const row of rawHarnesses) {
      const name = usageHarness(row.channel, kinds.get(String(row.home_id)));
      if (name && name !== "Unknown") harnesses.set(name, (harnesses.get(name) || 0) + row.total);
    }
    const repo = this.repositoryAliases().sql(
      "events.repository_key",
      "events.repository_path",
      "events.repository_kind",
    );
    const row = query(`SELECT MIN(timestamp_ms) AS first,MAX(timestamp_ms) AS last,
      COUNT(DISTINCT CASE WHEN repository_kind!='unknown' AND repository_key NOT LIKE 'unknown:%' THEN NULLIF(${repo.key},'') END) AS repositoryCount,
      TOTAL(CASE WHEN (detail_mask & 7)=7 THEN MAX(input-cached,0) ELSE 0 END) AS uncached,
      TOTAL(CASE WHEN (detail_mask & 7)=7 THEN cached ELSE 0 END) AS cached,
      TOTAL(CASE WHEN (detail_mask & 7)=7 THEN output ELSE 0 END) AS output,
      TOTAL(CASE WHEN (detail_mask & 7)=7 THEN total ELSE 0 END) AS total ${positive}`)[0];
    const value = rangeMetricsFromGroups({
      days,
      hours,
      sessions: sessions[0].total === null ? [] : sessions,
      harnesses: [...harnesses].map(([name, total]) => ({ name, total })),
      repositoryCount: Number(row.repositoryCount),
      first: row.first === null ? null : Number(row.first),
      last: row.last === null ? null : Number(row.last),
      composition: {
        uncached: Number(row.uncached || 0),
        cached: Number(row.cached || 0),
        output: Number(row.output || 0),
        total: Number(row.total || 0),
      },
    });
    if (!this.writeTransactionDepth) this.rangeMetricsCache = { database: this.database, key, value };
    return structuredClone(value);
  }

  /**
   * Read every complete published usage event. Source kind comes from the
   * joined source row rather than a caller-supplied home projection.
   * @returns {import("../usage-types.js").UsageEvent[]}
   */
  publishedUsageEvents() {
    if (!this.database) throw new TypeError("UsageStore is not open");
    this.assertSourceRepairsComplete();
    this.quotaSourceLookup?.clearCache();
    const rows = this.database
      .prepare(
        `SELECT e.*, sf.kind AS source_kind
         FROM events e
         JOIN source_files sf ON sf.path = e.source_path
         ORDER BY e.timestamp_ms, e.id`,
      )
      .all();
    const aliases = this.repositoryAliases();
    return rows.map((row) =>
      publishedUsageEventFromRow(
        row,
        row.source_kind,
        this.serviceTierEvidence,
        this.quotaSourceFor.bind(this),
        aliases,
      ),
    );
  }

  /**
   * Read the persistent source identity for every published home.
   * @returns {Array<{id: string, label: string, path: string, kind: string}>}
   */
  publishedUsageHomes() {
    if (!this.database) throw new TypeError("UsageStore is not open");
    return publishedUsageHomesFromDatabase(this.database);
  }

  /**
   * Read one session carrier per (home_id, session_id) from published facts.
   * The last event in timestamp/id order supplies channel, cwd, and model.
   * @returns {Array<{
   *   id: string,
   *   homeId: string,
   *   homeLabel: string,
   *   homePath: string,
   *   firstAt: string,
   *   lastAt: string,
   *   eventCount: number,
   *   total: import("../usage-types.js").UsageTotals,
   *   channel: string,
   *   cwd: string,
   *   model: string
   * }>}
   */
  publishedUsageSessions() {
    if (!this.database) throw new TypeError("UsageStore is not open");
    return publishedUsageSessionsFromEvents(this.publishedUsageEvents(), this.publishedUsageHomes());
  }

  /**
   * Read the complete published carrier under one SAVEPOINT snapshot.
   * @returns {{
   *   events: import("../usage-types.js").UsageEvent[],
   *   homes: Array<{ id: string, label: string, path: string, kind: string }>,
   *   sessions: ReturnType<WaifuUsageQueries["publishedUsageSessions"]>,
   *   rateLimitObservations: import("../usage-types.js").RateLimitObservation[]
   * }}
   */
  publishedUsageReport() {
    if (!this.database) throw new TypeError("UsageStore is not open");
    this.database.exec("SAVEPOINT published_usage_report_read");
    try {
      const report = {
        events: this.publishedUsageEvents(),
        homes: this.publishedUsageHomes(),
        sessions: this.publishedUsageSessions(),
        rateLimitObservations: this.quotaObservations({ useCache: false }),
      };
      this.database.exec("RELEASE published_usage_report_read");
      return report;
    } catch (error) {
      this.database.exec("ROLLBACK TO published_usage_report_read");
      this.database.exec("RELEASE published_usage_report_read");
      throw error;
    }
  }

  periodAggregate(groupColumn, nameColumn, _now, ranges, options = {}) {
    const pricingModels = options.pricingModels ?? getPricingCatalog().models;
    const previousPricingModels = this.readPricingModels;
    this.readPricingModels = pricingModels;
    this.database.exec("SAVEPOINT period_aggregate_read");
    try {
      return this.periodAggregateCore(groupColumn, nameColumn, _now, ranges, options);
    } finally {
      this.database.exec("RELEASE period_aggregate_read");
      this.readPricingModels = previousPricingModels;
    }
  }

  readPeriodComparison(options = {}) {
    this.assertSourceRepairsComplete();
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    const _snapshotRead = this.periodComparisonSnapshotRead;
    // D1：写事务内**不读也不写**共享缓存（读到的是未提交状态 ⇒ 回滚后它会说谎）。
    const cacheable = this.writeTransactionDepth === 0;
    const now = options.now ? new Date(options.now) : new Date();
    const excludeHomes = options.excludeHomes || [];
    const zone = options.calendarZone === "utc" ? "utc" : "local";
    const pricingModels = options.pricingModels ?? getPricingCatalog().models;
    const cacheKey = periodComparisonKey(now, zone, excludeHomes, pricingModels);
    const cached = cacheable ? this.periodComparisonCache.get(cacheKey) : undefined;
    if (cached) return { ...structuredClone(cached), asOf: now.toISOString() };
    const bounds = this.eventBounds(excludeHomes);
    const timestamps =
      bounds.minimum === null
        ? []
        : [
            { timestamp: new Date(Number(bounds.minimum)).toISOString() },
            { timestamp: new Date(Number(bounds.maximum)).toISOString() },
          ];
    const ranges = Object.fromEntries(
      COMPARISON_PERIOD_KEYS.map((key) => [
        key,
        resolveDateRange({ preset: key, now, calendarZone: zone }, timestamps),
      ]),
    );
    const models = this.periodAggregate("model", "model", now, ranges, { excludeHomes, pricingModels });
    const totals = models.length
      ? Object.fromEntries(
          COMPARISON_PERIOD_KEYS.map((period) => {
            const periodTotals = {};
            for (const model of models) {
              for (const [field, value] of Object.entries(model.periods[period])) {
                periodTotals[field] = (periodTotals[field] || 0) + value;
              }
            }
            return [period, periodTotals];
          }),
        )
      : this.periodAggregate(null, null, now, ranges, { excludeHomes, pricingModels })[0].periods;
    // shortcut: a new calendar scope uses SQL until facts rebuild; fuse it only if that fallback becomes costly.
    const repositoryProjection = cacheable ? this.summaryProjectionCache?.projection.repositoryPeriods : null;
    const value = {
      periods: COMPARISON_PERIOD_KEYS.map((key) => ({
        key,
        start: ranges[key].start?.toISOString() || null,
        end: ranges[key].end?.toISOString() || null,
      })),
      totals,
      models,
      repositories:
        repositoryProjection?.key === cacheKey
          ? repositoryProjection.rows
          : this.periodAggregate("repository_key", "repository_path", now, ranges, {
              includeKind: true,
              excludeHomes,
              pricingModels,
            }),
    };
    // D1：只有**不在写事务里**才写共享缓存（写事务内的结果只用于本次调用）。
    if (cacheable) {
      this.periodComparisonCache.clear();
      this.periodComparisonCache.set(cacheKey, value);
    }
    return { ...structuredClone(value), asOf: now.toISOString() };
  }

  readRecordsForRange(range, excludeHomes = []) {
    if (this.historyPersistentRead && !this.recordRangeHasEvents(range)) return {};
    // D2：读路径先对齐修订（外部提交在这里被检出 ⇒ 数据侧输入立即失效），与 metadata()/periodComparison() 同款。
    // D2 复用 D1 的门：写事务内不读也不写共享 memo。
    const cacheable = this.writeTransactionDepth === 0;
    const zone = range.calendarZone === "utc" ? "utc" : "local";
    const scope = scopeFilterSql(excludeHomes);
    const where = scope.sql ? `WHERE ${scope.sql}` : "";
    const catalog = getPricingCatalog();
    const rate = Number(catalog.usdToCnyRate);
    const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    // ⑥ 规范排除集合：`NOT IN (…)` 与顺序、重复无关 ⇒ 去重 + 排序后作为 memo 键的一部分。
    const canonicalExcludedHomes = [...new Set((excludeHomes || []).map((value) => String(value)).filter(Boolean))]
      .sort()
      .join("\u0000");
    const memoKey = [
      `data-revision\u0000${this.storeRevision}`,
      `pricing-catalog\u0000${String(catalog.version ?? "")}`,
      `usd-to-cny-rate\u0000${usdToCnyRate}`,
      `service-tier-evidence\u0000${this.serviceTierEvidenceInput === null ? "<unsynced>" : this.serviceTierEvidenceInput}`,
      `calendar-zone\u0000${zone}`,
      `excluded-homes\u0000${canonicalExcludedHomes}`,
    ].join("\u0001");
    const memoized = cacheable && this.recordChampionCache?.key === memoKey ? this.recordChampionCache.champions : null;
    // Price the full-history scan through one request-local model dictionary.
    // This keeps the estimator and unknown-value semantics unchanged while
    // avoiding per-row model normalization and event-memo key construction.
    const champions =
      memoized ??
      (() => {
        if (!this.verifiedHistorySqlRead || this.historyDiskRead) {
          const projection = this.recordProjectionOptions(zone, excludeHomes);
          const stored = readStoredRecordChampions(projection);
          if (stored) return stored;
          const temporary = new DatabaseSync("");
          try {
            temporary.exec("PRAGMA cache_size = -2048");
            return buildStoredRecordChampions({ ...projection, database: temporary, sourceDatabase: this.database });
          } finally {
            temporary.close();
          }
        }
        const eventPricing = createEventPricing();
        return this.buildRecordChampions(zone, where, scope.params, usdToCnyRate, (event) =>
          eventPricing.estimate(event),
        );
      })();
    if (cacheable && memoized === null) this.recordChampionCache = { key: memoKey, champions };
    return this.recordsWithinRange(champions, range, zone);
  }

  recordProjectionOptions(calendarZone, excludeHomes = []) {
    const zone = calendarZone === "utc" ? "utc" : "local";
    const scope = scopeFilterSql(excludeHomes);
    const catalog = getPricingCatalog();
    const rate = Number(catalog.usdToCnyRate);
    const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const sourceKinds = this.historySourceKinds ?? homeSourceKinds(this.homes);
    const pricing = createEventPricing();
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          "record-view-v2",
          catalog.version,
          usdToCnyRate,
          this.serviceTierEvidenceInput,
          zone,
          currentLocalRollupZoneIdentity(),
          [...sourceKinds].sort(),
          [...new Set(excludeHomes.map(String))].sort(),
        ]),
      )
      .digest("hex");
    return {
      database: this.database,
      ...(this.historyPersistentRead ? { mode: "history" } : {}),
      key: `${API_PRICING_VERSION}:${key}`,
      factsKey: String(
        this.database.prepare("SELECT revision FROM usage_business_revision WHERE singleton = 1").get().revision,
      ),
      zone,
      where: scope.sql ? `WHERE ${scope.sql}` : "",
      params: scope.params,
      usdToCnyRate,
      estimateRow: (row) =>
        pricing.estimate(costEventFromRow(row, this.serviceTierEvidence, sourceKinds.get(String(row.home_id)))),
    };
  }

  recordRangeHasEvents(range) {
    const scope = eventRangeScope(range, scopeFilterSql([]));
    return Boolean(this.database.prepare(`SELECT 1 FROM events WHERE ${scope.sql} LIMIT 1`).get(...scope.params));
  }

  /**
   * D2：`recordsForRange` 的**与 `range` 无关**的那一半 —— 全历史扫描（逐事件计价 + 日/周/月
   * 三种自然周期的槽位累加）与**冠军选择**（“至少两期可比” + **严格**新高）。
   *
   * 返回值：`{ day|week|month: { [metric]: { period, value } } }`。某个指标在该周期单位上
   * **没有**严格新高（含**并列**、期数不足两期）时该键**缺失** —— 即“平局不点亮”。
   * 冠军期的**范围包含判定不在这里**（见 `recordsWithinRange`）。
   */
  buildRecordChampions(zone, where, params, usdToCnyRate, estimateEventCost = DEFAULT_EVENT_COST_ESTIMATOR) {
    const periods = emptyRecordPeriods();

    // Record ranking scans the full scoped history. Its pricing projection is
    // intentionally smaller: estimates use the active catalog and do not read
    // stored price_version or repository display fields. session_id remains
    // necessary to resolve service-tier evidence.
    const statement = this.database.prepare(`
      SELECT timestamp_ms, day_key, week_key, month_key, session_id, model, channel, home_id,
        total, input, cached, output, reasoning, detail_mask, cache_write_tokens,
        cache_write_known, request_input_tokens, context_level, service_tier
      FROM events ${where}
    `);
    // W4-b1 / D1：逐行计价走**注入**的 `estimateEventCost`（默认仍是模块函数；`recordsForRange`
    // 注入 memo）。为什么用注入而不是在这里直接写 `this.eventCostMemo.estimate`：**不改变**共享门禁
    // （`tools/lib/instrument.mjs`）锚定的那两行源码形状 —— 锚点是"共享期望值文件"，改它要单列一节
    // 并做双向失败语义证明（见 W4-b1 报告 §共享门禁）；注入式改动**零锚点变更**。
    const sourceKinds = homeSourceKinds(this.homes);
    for (const row of statement.iterate(...params)) {
      const estimate = estimateEventCost({
        timestamp: Number(row.timestamp_ms),
        model: String(row.model),
        sourceKind: sourceKinds.get(String(row.home_id)),
        channel: String(row.channel),
        detailMask: Number(row.detail_mask || 0),
        cacheWriteTokens: Number(row.cache_write_tokens || 0),
        cacheWriteKnown: Boolean(row.cache_write_known),
        requestInputTokens: Number(row.request_input_tokens || 0),
        contextLevel: row.context_level,
        serviceTier:
          (!["hermes", "omp"].includes(sourceKinds.get(String(row.home_id))) &&
            this.serviceTierEvidence?.resolve(
              String(row.session_id),
              Number(row.timestamp_ms),
              String(row.service_tier),
            )) ||
          String(row.service_tier),
        total: {
          total: Number(row.total || 0),
          input: Number(row.input || 0),
          cached: Number(row.cached || 0),
          output: Number(row.output || 0),
          reasoning: Number(row.reasoning || 0),
        },
      });
      accumulateRecordEstimate(
        periods,
        {
          timestampMs: Number(row.timestamp_ms),
          sessionId: row.session_id,
          homeId: row.home_id,
          model: row.model,
          total: usageFromRow(row),
          estimate,
          storedKeys: {
            day: row.day_key,
            week: row.week_key,
            month: row.month_key,
          },
        },
        zone,
        usdToCnyRate,
      );
    }

    // ── 冠军选择（**与 `range` 无关**）：严格新高 + 至少两期可比 ─────────────────────────────
    return rankRecordChampions(periods);
  }

  buildRecordChampionsFromEvents(events, zone, usdToCnyRate) {
    const periods = emptyRecordPeriods();
    for (const event of events) {
      const timestampMs = Date.parse(event.timestamp);
      if (!Number.isFinite(timestampMs)) continue;
      accumulateRecordEstimate(
        periods,
        {
          timestampMs,
          sessionId: event.sessionId,
          homeId: event.homeId,
          model: event.model,
          total: event.total,
          estimate: this.eventCostMemo.estimate(event),
        },
        zone,
        usdToCnyRate,
      );
    }
    return rankRecordChampions(periods);
  }

  recordsForHistoryEvents(events, range) {
    const zone = range.calendarZone === "utc" ? "utc" : "local";
    const rate = Number(getPricingCatalog().usdToCnyRate);
    const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const champions = this.withEventCostMemoRound(() =>
      this.buildRecordChampionsFromEvents(events, zone, usdToCnyRate),
    );
    return this.recordsWithinRange(champions, range, zone);
  }

  /**
   * D2：`recordsForRange` 的**与 `range` 有关**的那一半 —— 只做“冠军期是否**完整**落在所选
   * 范围内”的包含判定（日/周/月的边界由 `recordUnitBoundaries` 给出），并按
   * `day → week → month` 取**第一个**被包含的单位（逐字保持原先的优先级与 `break`）。
   */
  recordsWithinRange(champions, range, zone) {
    const rangeStartMs = range?.start ? range.start.getTime() : null;
    const rangeEndMs = range?.end ? range.end.getTime() : null;
    const records = {};
    for (const [metric, definition] of Object.entries(RECORD_METRICS)) {
      for (const unit of ["day", "week", "month"]) {
        const champion = champions[unit][metric];
        if (!champion) continue;
        const boundaries = recordUnitBoundaries(champion.period, unit, zone);
        if (!boundaries) continue;
        const [periodStart, periodEnd] = boundaries;
        if (rangeStartMs !== null && periodStart < rangeStartMs) continue;
        if (rangeEndMs !== null && periodEnd - 1 > rangeEndMs) continue;
        records[metric] = {
          title: `${definition.title}的${RECORD_UNIT_LABELS[unit]}`,
          unit,
          period: champion.period,
          value: champion.value,
        };
        break;
      }
    }
    return records;
  }

  summaryProjectionKeys(range, bucket, excludeHomes, includeDetails, pricingModels) {
    const catalog = getPricingCatalog();
    const rate = Number(catalog.usdToCnyRate);
    const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const totalChanges = Number(this.database.prepare("SELECT total_changes() AS value").get()?.value ?? -1);
    const canonicalExcludedHomes = [...new Set((excludeHomes || []).map(String).filter(Boolean))].sort();
    const pricingModelKeys =
      pricingModels && typeof pricingModels === "object" && !Array.isArray(pricingModels)
        ? JSON.stringify(Object.keys(pricingModels).sort())
        : "";
    const contextKey = [
      `pricing-model-keys\u0000${pricingModelKeys}`,
      `service-tier-evidence\u0000${this.serviceTierEvidenceInput === null ? "<unsynced>" : this.serviceTierEvidenceInput}`,
      `homes\u0000${JSON.stringify(this.homes)}`,
      // Clock fields refresh per request; static facts depend on the resolved bounds.
      `resolved-range\u0000${JSON.stringify({ ...range, asOf: undefined })}`,
      `bucket\u0000${bucket}`,
      `excluded-homes\u0000${canonicalExcludedHomes.join("\u0000")}`,
      `include-details\u0000${includeDetails ? "1" : "0"}`,
    ].join("\u0001");
    const factsKey = [
      `usage-changes\u0000${this.usageProjectionChangeKey(totalChanges)}`,
      `data-version\u0000${this.readDataVersion()}`,
      contextKey,
    ].join("\u0001");
    const pricingKey = `pricing-catalog\u0000${String(catalog.version ?? "")}\u0001usd-to-cny-rate\u0000${usdToCnyRate}`;
    return {
      factsKey,
      key: `${factsKey}\u0001${pricingKey}`,
      contextKey: `${contextKey}\u0001${pricingKey}`,
      publicationKey: `${this.storeRevision}:${this.derivedRevision}:${totalChanges}:${this.readDataVersion()}`,
    };
  }

  summarizeInReadTransaction(filters = {}, options = {}) {
    if (this.registeredReadDatabase !== this.database) this.registerReadFunctions();
    this.quotaSourceLookup?.clearCache();
    const previousPricingModels = this.readPricingModels;
    const pricingModels = filters.pricingModels ?? getPricingCatalog().models;
    this.readPricingModels = pricingModels;
    try {
      return this.summarizeInReadTransactionCore(filters, options, pricingModels);
    } finally {
      this.readPricingModels = previousPricingModels;
    }
  }

  summarizeInReadTransactionCore(filters = {}, { includeDetails = true } = {}, pricingModels) {
    const excludeHomes = filters.excludeHomes || [];
    const asOf = filters.now ? new Date(filters.now) : new Date();
    const officialQuota = JSON.parse(this.readMetaRaw("official_quota_observations") || "[]");
    const quota = this.withBusinessProjection(() => readStoredQuotaWindows(this.database, asOf, officialQuota));
    const quotaObservations = {
      completedQuotaWindows: (limitId, time, minutes) => {
        const windows = this.withBusinessProjection(() =>
          readStoredCompletedQuotaWindows(this.database, limitId, time, minutes, officialQuota),
        );
        if (windows === null) return null;
        const iterator = windows[Symbol.iterator]();
        return {
          [Symbol.iterator]() {
            return this;
          },
          next: () => this.withBusinessProjection(() => iterator.next()),
          return: () => this.withBusinessProjection(() => iterator.return?.() ?? { done: true }),
        };
      },
    };
    const bounds = this.eventBounds(excludeHomes);
    const boundaryEvents = [];
    if (bounds.minimum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.minimum)).toISOString() });
    }
    if (bounds.maximum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.maximum)).toISOString() });
    }
    const range = resolveDateRange({ ...filters, now: asOf, quota }, boundaryEvents);
    const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
    const scopeExclusions = quotaPreset ? [...new Set([...excludeHomes, ...this.nonCodexHomeIds()])] : excludeHomes;
    const bucket = deriveTimelineBucket(
      range,
      range.bucket ||
        (quotaPreset ? (range.preset === "quota_5h" ? "quota_30m" : "quota_24h") : filters.bucket || "day"),
    );
    const groupingEligible =
      !quotaPreset &&
      this.writeTransactionDepth === 0 &&
      (this.verifiedHistorySqlRead ||
        !this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META));
    const persistentOptions = this.allSummaryOptions(filters, { includeDetails }, range, bucket);
    const persistentProjection = persistentOptions ? readStoredAllSummary(persistentOptions) : null;
    if (persistentProjection && this.summaryProjectionCache?.quoteInputs) {
      this.summaryProjectionCache.quoteInputs.discard();
      this.summaryProjectionCache.quoteInputs = null;
    }
    const projectionCacheable =
      range.preset === "all" && groupingEligible && !persistentProjection && !this.historyDiskRead;
    const projectionKeys = projectionCacheable
      ? this.summaryProjectionKeys(range, bucket, scopeExclusions, includeDetails, pricingModels)
      : null;
    const factProjection =
      projectionKeys &&
      this.summaryProjectionCache?.factsKey === projectionKeys.factsKey &&
      this.summaryProjectionCache.evidence === this.serviceTierEvidence
        ? structuredClone(this.summaryProjectionCache.projection)
        : null;
    const projection =
      persistentProjection ||
      (factProjection && this.summaryProjectionCache.key === projectionKeys.key ? factProjection : null);
    let quoteInputs = factProjection ? this.summaryProjectionCache.quoteInputs : null;
    if (projectionCacheable && !factProjection && this.summaryProjectionCache?.quoteInputs) {
      this.summaryProjectionCache.quoteInputs.discard();
      this.summaryProjectionCache.quoteInputs = null;
    }
    const aggregate = persistentProjection?.aggregate ?? this.aggregateRange(range, scopeExclusions);
    const totals = usageFromRow(aggregate);
    const previousRange = quotaPreset ? previousQuotaRange(range, quota, quotaObservations) : previousUsageRange(range);
    const previousAggregate = previousRange ? this.aggregateRange(previousRange, scopeExclusions) : null;
    const comparison = usageComparisonFromAggregates({
      range,
      currentTotals: totals,
      previousRange,
      previousTotals: usageFromRow(previousAggregate),
      previousEventCount: Number(previousAggregate?.event_count || 0),
      previousSessionCount: Number(previousAggregate?.session_count || 0),
      now: asOf,
    });
    let timeline = projection?.timeline ?? [];
    let timelineError = projection?.timelineError ?? null;
    let costEstimate = projection?.costEstimate;
    let fusedGroups = persistentProjection;
    let fusedRepositories = null;
    if (!projection) {
      const quoteCapture = projectionCacheable && !factProjection ? new HistoryQuoteInputs() : null;
      const pricing = createEventPricing(pricingModels);
      const costAccumulator = createCostEstimateAccumulator({ modelName: pricing.costModelName });
      const sourceKindsByPath =
        groupingEligible && !factProjection
          ? new Map(
              this.database
                .prepare("SELECT path, kind FROM source_files")
                .all()
                .map((row) => [String(row.path), String(row.kind)]),
            )
          : null;
      const groupAccumulator = sourceKindsByPath
        ? createFusedSummaryGroups(sourceKindsByPath, pricing.modelName, { includeDetails })
        : null;
      // shortcut: hot-only repository session order stays on SQL; this collector serves the verified cold reader.
      const repositoryAccumulator =
        projectionCacheable && this.verifiedHistorySqlRead && includeDetails && sourceKindsByPath
          ? createFusedSummaryRepositories(
              Object.fromEntries(
                COMPARISON_PERIOD_KEYS.map((key) => [
                  key,
                  resolveDateRange({ preset: key, now: asOf, calendarZone: range.calendarZone }, boundaryEvents),
                ]),
              ),
              this.repositoryAliases(),
            )
          : null;
      const observationAccumulator =
        projectionCacheable &&
        this.verifiedHistorySqlRead &&
        scopeExclusions.length === 0 &&
        sourceKindsByPath &&
        this.metadataObservationCache?.revision !== this.storeRevision
          ? createFusedMetadataObservations()
          : null;
      try {
        timeline = this.timelineRange(range, bucket, {
          onEstimate: (event, estimate, bucketKey) => {
            quoteCapture?.append(event, bucketKey);
            costAccumulator.add(event, estimate);
            groupAccumulator?.add(event);
            repositoryAccumulator?.add(event);
            observationAccumulator?.add(event);
          },
          excludeHomes: scopeExclusions,
          pricingModels,
          pricing,
          quoteInputs,
          factRows: factProjection?.timelineError ? undefined : factProjection?.timeline,
          includeRepositories: Boolean(repositoryAccumulator),
        });
        costEstimate = costAccumulator.result();
        quoteInputs = quoteInputs ?? quoteCapture?.finish() ?? null;
        fusedGroups = factProjection ?? groupAccumulator?.result() ?? null;
        fusedRepositories = repositoryAccumulator?.result() ?? null;
        if (observationAccumulator) {
          const rows = observationAccumulator.result();
          this.metadataObservationCache = {
            revision: this.storeRevision,
            rows,
            maxTimestampMs: rows.reduce((max, row) => Math.max(max, row.last_seen), -Infinity),
          };
        }
      } catch (error) {
        quoteCapture?.discard();
        quoteInputs = null;
        fusedGroups = null;
        if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
        timelineError = error.message;
        costEstimate = this.costEstimateRange(range, scopeExclusions);
      }
    }
    const details = this.rangeDetails(range, scopeExclusions);
    const summary = {
      generatedAt: this.generatedAt,
      range: summaryRangeFields(range, bucket),
      totals,
      details,
      cacheHitRate: cacheHitRate(details),
      comparison,
      costEstimate,
      rangeMetrics: this.rangeMetrics(range, scopeExclusions),
      records:
        range.preset === "all"
          ? {}
          : quotaPreset
            ? quotaRecordsForRange(range, quota, quotaObservations, (window) => {
                const row = window === range ? aggregate : this.aggregateRange(window, scopeExclusions);
                const cost = window === range ? costEstimate : this.costEstimateRange(window, scopeExclusions);
                return {
                  eventCount: Number(row.event_count),
                  values: quotaRecordValues(
                    usageFromRow(row),
                    cost,
                    Number(row.session_count),
                    getPricingCatalog().usdToCnyRate,
                  ),
                };
              })
            : this.readRecordsForRange(range, scopeExclusions),
      eventCount: Number(aggregate.event_count || 0),
      sessionCount: Number(aggregate.session_count || 0),
      homeCount: Number(aggregate.home_count || 0),
      timeline,
      timelineError,
      quota,
      channels:
        projection?.channels ??
        fusedGroups?.channels ??
        this.groupedRange("channel", range, "total DESC", scopeExclusions),
      models:
        projection?.models ?? fusedGroups?.models ?? this.groupedRange("model", range, "total DESC", scopeExclusions),
    };

    if (includeDetails) {
      summary.homes =
        projection?.homes ??
        fusedGroups?.homes ??
        this.groupedRange("home_label", range, "total DESC", scopeExclusions);
      summary.projects =
        projection?.projects ??
        fusedGroups?.projects ??
        this.groupedRange("project", range, "total DESC", scopeExclusions);
      const repositorySessions = fusedRepositories
        ? this.historyRepositorySessionOrder(
            eventRangeScope(range, scopeFilterSql(scopeExclusions)),
            fusedRepositories.firsts,
          )
        : null;
      summary.repositories =
        factProjection?.repositories ??
        fusedRepositories?.rows.map((row) => ({ ...row, sessionIds: repositorySessions.get(row.key) })) ??
        this.repositoriesRange(range, scopeExclusions);
    }
    if (projectionCacheable && !projection) {
      const cachedProjection = {
        timeline,
        timelineError,
        costEstimate,
        channels: summary.channels,
        models: summary.models,
      };
      if (includeDetails) {
        cachedProjection.homes = summary.homes;
        cachedProjection.projects = summary.projects;
        cachedProjection.repositories = summary.repositories;
        const repositoryPeriods =
          factProjection?.repositoryPeriods ??
          (fusedRepositories
            ? {
                key: periodComparisonKey(
                  asOf,
                  range.calendarZone === "utc" ? "utc" : "local",
                  scopeExclusions,
                  pricingModels,
                ),
                rows: fusedRepositories.periodRepositories,
              }
            : null);
        if (repositoryPeriods) cachedProjection.repositoryPeriods = repositoryPeriods;
      }
      this.summaryProjectionCache = {
        ...projectionKeys,
        context: { range, bucket, excludeHomes: scopeExclusions, includeDetails, pricingModels },
        evidence: this.serviceTierEvidence,
        // Reusing facts must retain their original certification, including a refused transaction build.
        guard: factProjection
          ? this.summaryProjectionCache.guard
          : this.summaryProjectionTransferableRead
            ? this.usageProjectionGuard()
            : null,
        projection: structuredClone(cachedProjection),
        quoteInputs,
      };
    }
    if (projectionKeys && projection && this.summaryProjectionCache.publicationKey !== projectionKeys.publicationKey) {
      this.summaryProjectionCache = { ...this.summaryProjectionCache, publicationKey: projectionKeys.publicationKey };
    }
    return summary;
  }

  quotaSourceFor(homeId, sessionId, time) {
    if (
      this.quotaSourceDatabase !== this.database ||
      this.quotaSourceRevision !== this.storeRevision ||
      !this.quotaSourceLookup
    ) {
      this.quotaSourceLookup = createStoredQuotaSourceResolver(this.database, this.quotaSourceEvidence);
      this.quotaSourceDatabase = this.database;
      this.quotaSourceRevision = this.storeRevision;
    }
    const writing = this.writeTransactionDepth > 0;
    if (writing) this.quotaSourceLookup.clearCache();
    try {
      return this.quotaSourceLookup(homeId, sessionId, time);
    } finally {
      if (writing) this.quotaSourceLookup.clearCache();
    }
  }
  readMetaRaw(key) {
    return this.database.prepare("SELECT value FROM store_meta WHERE key=?").get(key)?.value;
  }
  readDataVersion() {
    return Number(this.database.prepare("PRAGMA data_version").get().data_version);
  }
  usageProjectionChangeKey(
    totalChanges = Number(this.database.prepare("SELECT total_changes() AS value").get().value),
  ) {
    return `fixed:${this.storeRevision}:${totalChanges}`;
  }
  usageProjectionGuard() {
    return null;
  }
  withBusinessProjection(work) {
    return work();
  }
  registerReadFunctions() {
    super.registerReadFunctions();
    this.database.function("usage_model_group", (model) =>
      canonicalModelName(String(model ?? ""), this.readPricingModels ?? getPricingCatalog().models),
    );
    this.registeredReadDatabase = this.database;
  }
  modelName(model) {
    return canonicalModelName(model, this.readPricingModels ?? getPricingCatalog().models);
  }
  metadata(asOf = new Date()) {
    return this.readMetadata(asOf);
  }
  periodComparison(options = {}) {
    return this.readPeriodComparison(options);
  }
  summarize(filters = {}, options = {}) {
    return this.summarizeInReadTransaction(filters, options);
  }
  async dashboardHistory(filters = {}, options = {}) {
    const read = () => ({
      summary: this.summarizeInReadTransaction(filters, options),
      metadata: this.readMetadata(filters.now ? new Date(filters.now) : new Date()),
      periodComparison: this.readPeriodComparison({ ...filters }),
    });
    return this.withVerifiedRead ? this.withVerifiedRead(read) : read();
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
    this.quotaSourceLookup = this.quotaSourceDatabase = null;
    this.quotaSourceRevision = -1;
  }
  borrowPeriodComparisonCache(cache) {
    if (this.periodComparisonCache.size) throw new Error("Cannot replace an active period cache");
    this.periodComparisonCache = cache;
    this.ownsPeriodComparisonCache = false;
  }
  close() {
    let failure;
    const release = (fn) => {
      try {
        fn();
      } catch (error) {
        failure ??= error;
      }
    };
    release(() => this.summaryProjectionCache?.quoteInputs?.discard());
    this.summaryProjectionCache = null;
    if (this.ownsPeriodComparisonCache) release(() => this.periodComparisonCache.clear());
    const database = this.database;
    release(() => super.close());
    if (this.ownsDatabase) release(() => database?.close());
    if (this.ownsEventCostMemo) release(() => this.eventCostMemo.clear("close"));
    if (failure) throw failure;
  }
}

export class WaifuUsageProjectionOwner extends WaifuUsageQueries {
  prepareMetadataProjection() {
    if (this.deferredMetadataIndex || this.database.isTransaction || this.writeTransactionDepth > 0) return;
    if (this.storedMetadata(Number.MAX_SAFE_INTEGER)) {
      this.lastMetadataWork = { readEvents: 0, rebuilt: false, reused: true };
      return;
    }
    if (
      (this.verifiedHistorySqlRead && !this.historyPersistentRead) ||
      (!this.historyPersistentRead &&
        this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)) ||
      this.database
        .prepare("PRAGMA index_list(events)")
        .all()
        .some((row) => Number(row.unique) !== 0)
    )
      return;
    this.lastMetadataWork = this.withBusinessProjection(() => prepareStoredMetadata(this.database));
  }

  prepareRecordProjection(filters, { force = false } = {}) {
    if (
      this.database.isTransaction ||
      this.writeTransactionDepth > 0 ||
      (this.verifiedHistorySqlRead && !this.historyPersistentRead) ||
      (filters.preset === "all" && !(this.historyPersistentRead && force)) ||
      isQuotaPreset(filters.preset) ||
      filters.quotaWindow ||
      (!this.historyPersistentRead &&
        this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META))
    )
      return;
    if (this.historyPersistentRead && !force) {
      const bounds = this.eventBounds();
      const markers = [bounds.minimum, bounds.maximum]
        .filter((value) => value !== null)
        .map((value) => ({ timestamp: new Date(Number(value)).toISOString() }));
      if (!this.recordRangeHasEvents(resolveDateRange(filters, markers))) {
        this.lastRecordWork = { pricedEvents: 0, emptyRange: true };
        return;
      }
    }
    const input = this.recordProjectionOptions(filters.calendarZone, filters.excludeHomes || []);
    if (this.historyPersistentRead) {
      let pricedEvents = 0;
      const estimate = input.estimateRow;
      input.estimateRow = (row) => {
        pricedEvents++;
        return estimate(row);
      };
      buildStoredRecordChampions(input);
      this.lastRecordWork = { pricedEvents };
    } else buildStoredRecordChampions(input);
  }

  prepareQuotaProjection(filters) {
    if (
      this.database.isTransaction ||
      this.writeTransactionDepth > 0 ||
      (this.verifiedHistorySqlRead && !this.historyPersistentRead)
    )
      return;
    const official = JSON.parse(this.readMetaRaw("official_quota_observations") || "[]");
    this.withBusinessProjection(() =>
      selectStoredQuotaWindows(this.database, filters.now ? new Date(filters.now) : new Date(), official),
    );
    this.lastQuotaWork = quotaProjectionWork(this.database);
  }

  prepareHotRollups() {
    if (
      this.database.isTransaction ||
      this.writeTransactionDepth > 0 ||
      (this.verifiedHistorySqlRead && !this.historyPersistentRead) ||
      (!this.historyPersistentRead &&
        this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META))
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
      const dirtyDays = listDirtyUsageRollupDays(this.database);
      for (const day of dirtyDays) {
        this.database.exec("SAVEPOINT business_rollup_day");
        try {
          rebuildUsageRollups(this.database, { days: [day], calendarZone: "utc" });
          rebuildUsageRollups(this.database, {
            days: localUsageRollupDaysForUtcDays([day]),
            calendarZone: "local",
          });
          this.database.exec("RELEASE business_rollup_day");
        } catch (error) {
          this.database.exec("ROLLBACK TO business_rollup_day; RELEASE business_rollup_day");
          throw error;
        }
      }
      const checkpoint = checkpointUsageRollups(this.database, { zoneIdentity });
      this.lastRollupWork = { ...work, fallbackDays: dirtyDays.length, checkpoint };
    });
  }

  prepareAllSummaryProjection(filters, options) {
    if (this.database.isTransaction || this.writeTransactionDepth > 0) return;
    const input = this.allSummaryOptions(filters, options);
    if (!input) return;
    if (this.historyPersistentRead)
      ensureUsageAllSummarySchema(this.database, { mode: "history", extension: input.extension });
    input.contextKey = () => this.allSummaryOptions(filters, options)?.key;
    try {
      this.lastAllSummaryWork = this.withBusinessProjection(() => buildStoredAllSummary(input));
    } catch (error) {
      if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
      this.lastAllSummaryWork = { fallbackReason: error.code };
    }
  }
}

export class WaifuUsageReader extends WaifuUsageQueries {
  constructor(view, pricing) {
    if (!view?.database || !pricing?.eventCostMemo)
      throw new TypeError("A fixed database and owned pricing memo are required");
    super(view, pricing);
  }
}
