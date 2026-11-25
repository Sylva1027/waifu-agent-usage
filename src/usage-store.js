import { WaifuUsageProjectionOwner, harnessModelName, canonicalizeKind } from "./waifu/usage-reader.js";
import { WaifuUsageReader } from "./waifu/usage-reader.js";
import { HISTORY_ARCHIVE_EVENT_AUTHORITY_META } from "./usage-sql.js";
import { statSync } from "node:fs";
import path from "node:path";

import { isQuotaPreset, summarizeUsage } from "./usage-core.js";
import { createEventCostMemo, estimateCostForEvents, getPricingCatalog } from "./pricing.js";
import { readWaifuUsageSourceInputs } from "./waifu/usage-source-inputs.js";
import { loadServiceTierEvidence, serviceTierEvidenceSnapshot } from "./service-tier-evidence.js";
import { isQuotaUsage } from "../public/quota-usage.js";
import { ensureUsageAllSummarySchema } from "./usage-all-summary-store.js";
import { ensureUsageRecordSchema, USAGE_RECORD_TABLE_NAMES } from "./usage-record-store.js";
import { buildModelActivity } from "../public/pricing-models.js";
import { sessionIdentity } from "../public/usage-fields.js";
import { sourceGroup, homeSourceKinds } from "../public/timeline-utils.js";
import { quotaRecordsForRange, quotaRecordValues } from "../public/waifu-timeline.js";

import { createUsageFactStoreClass } from "./usage-fact-store.js";
import { createEventPricing } from "./pricing.js";
import { createWaifuAllSummaryExtension, WAIFU_ALL_SUMMARY_TABLE_NAMES } from "./waifu/usage-all-summary.js";
export { STORE_SCHEMA_VERSION } from "./usage-fact-store.js";
const HARNESS_MODEL_NAMES = ["Codex", "ZCode", "DSH", "OpenCode", "Claude", "WorkBuddy", "Hermes", "Oh My Pi"];
function metadataFromHistoryEvents(events, carrier, asOf) {
  const asOfMs = asOf.getTime();
  const sessions = new Set();
  const homeRows = new Map();
  const harnessModels = Object.fromEntries(HARNESS_MODEL_NAMES.map((name) => [name, new Set()]));
  const observationRows = new Map();
  for (const event of events) {
    const sessionId = String(event.sessionId);
    sessions.add(sessionIdentity(event.homeId, sessionId));
    const homeId = String(event.homeId);
    const homeRow = homeRows.get(homeId) || { eventCount: 0, sessions: new Set() };
    homeRow.eventCount += 1;
    homeRow.sessions.add(sessionId);
    homeRows.set(homeId, homeRow);

    const model = String(event.model || "").trim();
    if (model && model.toLocaleLowerCase() !== "unknown model") {
      harnessModels[harnessModelName(event.channel)].add(model);
    }

    const timestampMs = Date.parse(event.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs > asOfMs) continue;
    const key = JSON.stringify([event.channel, event.model, homeId]);
    const observation = observationRows.get(key);
    if (observation) observation.lastSeen = Math.max(observation.lastSeen, timestampMs);
    else observationRows.set(key, { channel: event.channel, model: event.model, homeId, lastSeen: timestampMs });
  }

  const sourceKinds = homeSourceKinds(carrier.homes);
  const observations = [...observationRows.values()].map((row) => {
    const group = sourceGroup(row.channel, sourceKinds.get(row.homeId));
    return {
      model: row.model,
      timestamp: row.lastSeen,
      harness: HARNESS_MODEL_NAMES.includes(group) ? group : "Codex",
    };
  });
  return {
    generatedAt: carrier.generatedAt,
    eventCount: events.length,
    sessionCount: sessions.size,
    homeCount: carrier.homes.length,
    harnessModels: Object.fromEntries(
      HARNESS_MODEL_NAMES.map((name) => [name, [...harnessModels[name]].sort((a, b) => a.localeCompare(b))]),
    ),
    homes: carrier.homes.map((home) => {
      const row = homeRows.get(String(home.id));
      return {
        ...home,
        status: row ? "active" : "no-events",
        eventCount: row?.eventCount || 0,
        sessionCount: row?.sessions.size || 0,
      };
    }),
    warnings: carrier.warnings,
    ...buildModelActivity(observations, asOf),
  };
}
function withoutExcludedHistoryHomes(report, excludeHomes = []) {
  // The server helper cannot be imported here: server -> store would form a cycle.
  const excluded = new Set((excludeHomes || []).map(String));
  if (!excluded.size) return report;
  return {
    ...report,
    events: report.events.filter((event) => !excluded.has(String(event.homeId))),
    sessions: report.sessions.filter((session) => !excluded.has(String(session.homeId))),
  };
}
function summarizeQuotaRecordWindow(events, window, excludedHomeIds, usdToCnyRate, estimateEventCost) {
  const start = window.start instanceof Date ? window.start.getTime() : Date.parse(window.start);
  const end = window.end instanceof Date ? window.end.getTime() : Date.parse(window.end);
  const scoped = events.filter((event) => {
    const timestamp = Date.parse(event.timestamp);
    return (
      Number.isFinite(timestamp) &&
      timestamp >= start &&
      timestamp <= end &&
      !excludedHomeIds.has(String(event.homeId)) &&
      isQuotaUsage(event)
    );
  });
  const total = { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
  for (const event of scoped) {
    for (const field of Object.keys(total)) {
      total[field] += Number(event.total?.[field] || 0);
    }
  }
  return {
    eventCount: scoped.length,
    values: quotaRecordValues(
      total,
      estimateCostForEvents(scoped, { estimateEventCost }),
      new Set(scoped.map((event) => event.sessionId)).size,
      usdToCnyRate,
    ),
  };
}
export class UsageStore extends createUsageFactStoreClass(WaifuUsageProjectionOwner) {
  constructor(options = {}) {
    super(options);
    this.eventCostMemo = createEventCostMemo();
  }
  get sourceInputReader() {
    return readWaifuUsageSourceInputs;
  }
  get editionProjectionTables() {
    return [...USAGE_RECORD_TABLE_NAMES, ...WAIFU_ALL_SUMMARY_TABLE_NAMES];
  }
  prepareEditionSchema() {
    ensureUsageRecordSchema(this.database);
  }
  prepareEditionSummarySchema() {
    ensureUsageAllSummarySchema(this.database, {
      mode: "hot",
      extension: createWaifuAllSummaryExtension(createEventPricing()),
    });
  }
  loadHistoryProjectionModule() {
    return import("./waifu/usage-history-projection-store.js");
  }
  synchronizeEditionEvidence(homes) {
    const nextServiceTierEvidence = loadServiceTierEvidence(homes);
    let sameServiceTierEvidence = false;
    if (this.serviceTierEvidence) {
      try {
        sameServiceTierEvidence =
          JSON.stringify(serviceTierEvidenceSnapshot(this.serviceTierEvidence)) ===
          JSON.stringify(serviceTierEvidenceSnapshot(nextServiceTierEvidence));
      } catch {
        // Custom resolvers cannot be compared safely; replacing them is conservative.
      }
    }
    if (!sameServiceTierEvidence) this.serviceTierEvidence = nextServiceTierEvidence;
    const serviceTierSignature = this.serviceTierEvidenceSignature(homes);
    if (
      this.serviceTierEvidenceInput !== null &&
      (serviceTierSignature !== this.serviceTierEvidenceInput || !sameServiceTierEvidence)
    ) {
      this.commitStoreRevision("service-tier");
    }
    this.serviceTierEvidenceInput = serviceTierSignature;
  }
  clearEditionQueryCaches(reason) {
    this.metadataObservationCache = this.recordChampionCache = this.rangeMetricsCache = null;
    this.eventCostMemo?.clear(reason);
  }
  queryEvidenceGuard() {
    return { evidence: this.serviceTierEvidence };
  }
  historyEventEvidence() {
    return this.serviceTierEvidence;
  }
  editionQueryFilters(filters) {
    return { pricingModels: filters.pricingModels ?? getPricingCatalog().models };
  }
  editionReadContext() {
    return {
      serviceTierEvidence: this.serviceTierEvidence,
      serviceTierEvidenceInput: this.serviceTierEvidenceInput,
      key: this.serviceTierEvidenceInput,
    };
  }
  readerEditionContextMatches(reader) {
    return reader?.serviceTierEvidence === this.serviceTierEvidence;
  }
  applyReaderEditionContext(reader, context) {
    reader.serviceTierEvidence = context.serviceTierEvidence;
    reader.serviceTierEvidenceInput = context.serviceTierEvidenceInput;
  }
  createQueryOwner(view, context) {
    const reader = new WaifuUsageProjectionOwner(view, { ...context, eventCostMemo: createEventCostMemo() });
    reader.ownsEventCostMemo = true;
    return reader;
  }
  createPublishedReader(view, context) {
    const reader = new WaifuUsageReader(view, { ...context, eventCostMemo: createEventCostMemo() });
    reader.ownsEventCostMemo = true;
    return reader;
  }
  metadataFromHistoryEvents(events, carrier, asOf) {
    return metadataFromHistoryEvents(events, carrier, asOf);
  }
  transferPublishedProjection(reader, snapshot) {
    const current = snapshot && this.captureUsageProjection();
    if (
      current?.slot !== snapshot?.slot ||
      current?.guard.identity !== snapshot?.guard.identity ||
      this.usageProjectionDatabaseIdentity() !== snapshot?.guard.identity ||
      reader.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)
    )
      return;
    const context = structuredClone(snapshot.slot.context);
    const keys = reader.summaryProjectionKeys(
      context.range,
      context.bucket,
      context.excludeHomes,
      context.includeDetails,
      context.pricingModels,
    );
    if (keys.contextKey === snapshot.slot.contextKey)
      reader.summaryProjectionCache = {
        ...keys,
        context,
        evidence: this.serviceTierEvidence,
        projection: structuredClone(snapshot.slot.projection),
        quoteInputs: null,
      };
  }

  captureUsageProjection() {
    try {
      const slot = this.summaryProjectionCache;
      if (!slot?.context || !slot.guard || !this.database || this.database.isTransaction || this.writeTransactionDepth)
        return null;
      const guard = this.usageProjectionGuard();
      if (!guard || Object.keys(guard).some((key) => guard[key] !== slot.guard[key])) return null;
      const { range, bucket, excludeHomes, includeDetails, pricingModels } = slot.context;
      const keys = this.summaryProjectionKeys(range, bucket, excludeHomes, includeDetails, pricingModels);
      if (keys.key !== slot.key) return null;
      return { source: this, slot, guard };
    } catch {
      return null;
    }
  }

  adoptUsageProjection(snapshot) {
    try {
      if (!snapshot || snapshot.source === this || !this.database?.isTransaction || this.writeTransactionDepth)
        return false;
      // Only a fresh reader may receive the writer's payload; local writes are not a published view.
      const changes = Number(this.database.prepare("SELECT total_changes() AS value").get().value);
      if (changes !== this.openedUsageProjectionChanges + (this.usageProjectionTracker ? 1 : 0)) return false;
      this.database.prepare("SELECT id FROM events LIMIT 1").get();
      const current = snapshot.source.captureUsageProjection();
      if (
        !current ||
        current.slot !== snapshot.slot ||
        Object.keys(current.guard).some((key) => current.guard[key] !== snapshot.guard[key])
      )
        return false;
      if (
        this.usageProjectionDatabaseIdentity() !== snapshot.guard.identity ||
        this.serviceTierEvidence !== snapshot.guard.evidence
      )
        return false;
      if (this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META))
        return false;
      const context = structuredClone(snapshot.slot.context);
      const { range, bucket, excludeHomes, includeDetails, pricingModels } = context;
      const keys = this.summaryProjectionKeys(range, bucket, excludeHomes, includeDetails, pricingModels);
      if (keys.contextKey !== snapshot.slot.contextKey) return false;
      const projection = {};
      for (const key of [
        "timeline",
        "timelineError",
        "costEstimate",
        "channels",
        "models",
        "homes",
        "projects",
        "repositories",
      ]) {
        if (Object.hasOwn(snapshot.slot.projection, key)) projection[key] = snapshot.slot.projection[key];
      }
      this.summaryProjectionCache = {
        ...keys,
        context,
        evidence: this.serviceTierEvidence,
        projection: structuredClone(projection),
        quoteInputs: null,
      };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * D1：`service-tier evidence` 的**输入签名**（只读 `statSync`，不落盘、不进 report）。
   *
   * 证据来自各 home 的 `logs_2.sqlite`（`loadServiceTierEvidence`）；这里取主库 **+ `-wal`** 的
   * `size`/`mtimeMs`（与 `opencodeSourceStat` 同一手法：WAL 里的新行也算变化）。
   *
   * 为什么用**输入签名**而不是 resolver 身份：`loadServiceTierEvidence` **每轮**都返回一个新对象，
   * 拿身份当"变化"会让每个 no-op 轮都推进修订（违反卡面"无变化同步保留缓存"）。
   * @param {any[]} homes
   * @returns {string}
   */
  serviceTierEvidenceSignature(homes = []) {
    const files = [
      ...new Set(
        homes
          .filter((home) => home?.path && home.kind !== "project-log" && home.kind !== "zcode")
          .map((home) => path.join(String(home.path), "logs_2.sqlite")),
      ),
    ].sort();
    return files
      .map((filePath) => {
        let size = -1;
        let mtimeMs = -1;
        try {
          const main = statSync(filePath);
          size = main.size;
          mtimeMs = main.mtimeMs;
          try {
            const wal = statSync(`${filePath}-wal`);
            size += wal.size;
            mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
          } catch {
            // 没有 `-wal`（非 WAL 模式 / 已 checkpoint）⇒ 主库指纹即全部输入。
          }
        } catch {
          // 取不到指纹（文件不存在/不可读）同样是一个**输入状态**（用 -1 表示）⇒ 保持确定性。
        }
        return `${filePath}\u0000${size}\u0000${mtimeMs}`;
      })
      .join("\n");
  }

  // New Record：对日/周/月三种自然周期求各指标的历史最高期（严格新高、至少两期可比），
  // 只有纪录期完整落在所选范围内时才计为“在所选时间范围创下”。
  /**
   * D2：**完整 scope 的历史冠军**与“纪录期是否完整落在当前范围”**分离**。
   *
   * 为什么能分离：冠军只在**全历史**上选（SQL 的 `where` 只来自 `excludeHomes`，`range` **从不**
   * 进入 WHERE）⇒ 冠军选择与 `range` 无关；`range` 只参与 `recordsWithinRange()` 里的包含判定。
   *
   * memo = **一条**（单槽，不是 Map、不是框架、不落盘），键是**六项**输入的身份：
   *   ① 数据修订（D1 的 `storeRevision`，由 `syncDerivedRevision()` 对齐）
   *   ② 价目目录版本（`getPricingCatalog().version`）
   *   ③ `usdToCnyRate`
   *   ④ service-tier evidence 的输入签名（与 `serviceTierEvidenceInput` 同口径）
   *   ⑤ 时区（`range.calendarZone`：`local` / `utc`）
   *   ⑥ **规范化后的排除集合**（`excludeHomes` 去重 + 排序）
   * 改变任一项 ⇒ 键不等 ⇒ **立即重算**。失效**不靠 TTL、不靠新事件总线**：数据侧由 D1 的修订
   * 前进驱动，价目 / 汇率由 `getPricingCatalog()` 驱动。
   *
   * ⚠️ **遵守 D1 的写事务门**：`writeTransactionDepth > 0` 时读到的是**未提交**状态 ⇒
   * **不读也不写**这条 memo，只在本次调用内算局部值（与 `metadata()` / `periodComparison()` 同款）。
   * @param {import("./usage-types.js").UsageRange} range
   */
  recordsForRange(range, excludeHomes = []) {
    if (!this.database.isTransaction && !this.writeTransactionDepth && !this.summarySnapshotRead)
      this.prepareRecordProjection({ ...range, excludeHomes });
    return this.readRecordsForRange(range, excludeHomes);
  }

  /**
   * Build a cold-aware summary synchronously from an already prepared complete report.
   * @param {any} report
   * @param {object} [filters]
   * @param {{ includeDetails?: boolean }} [options]
   */
  summarizeHistoryReport(report, filters = {}, options = {}) {
    let scoped = report;
    if (filters.excludeHomes?.length) {
      scoped = withoutExcludedHistoryHomes(report, filters.excludeHomes);
    }
    const summary = summarizeUsage({ ...scoped, generatedAt: this.generatedAt, warnings: this.warnings }, filters);
    const summaryWithRecords = /** @type {any} */ (summary);
    const range = /** @type {any} */ (summary.range);
    if (range.preset === "all") {
      summaryWithRecords.records = {};
    } else if (range.quotaWindow) {
      const excludedHomeIds = new Set(
        (scoped.homes || []).filter((home) => canonicalizeKind(home.kind) !== "codex").map((home) => String(home.id)),
      );
      const rate = Number(getPricingCatalog().usdToCnyRate);
      const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
      summaryWithRecords.records = this.withEventCostMemoRound(() =>
        quotaRecordsForRange(range, summary.quota, scoped.rateLimitObservations, (window) =>
          summarizeQuotaRecordWindow(scoped.events, window, excludedHomeIds, usdToCnyRate, (event) =>
            this.eventCostMemo.estimate(event),
          ),
        ),
      );
    } else if (!isQuotaPreset(range.preset) && !range.quotaWindow) {
      summaryWithRecords.records = this.recordsForHistoryEvents(scoped.events, {
        ...range,
        start: range.start ? new Date(range.start) : null,
        end: range.end ? new Date(range.end) : null,
      });
    }
    if (options.includeDetails === false) {
      delete summary.homes;
      delete summary.projects;
      delete summary.repositories;
    }
    return summary;
  }
  readRecordsForRange(range, excludeHomes = []) {
    this.syncDerivedRevision();
    return super.readRecordsForRange(range, excludeHomes);
  }
  summaryProjectionKeys(...args) {
    if (!this.usageProjectionTracker && !this.verifiedHistorySqlRead) {
      this.installUsageProjectionTracker();
      this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
    }
    return super.summaryProjectionKeys(...args);
  }
}
