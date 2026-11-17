import { canonicalModelName } from "./pricing-models.js";
import {
  completedQuotaWindows,
  createTimelineAccumulator as createUsageTimelineAccumulator,
} from "./timeline-utils.js";
import { requireState, finiteStateNumber } from "./timeline-state.js";

function costFromState(value) {
  requireState(value && typeof value === "object" && !Array.isArray(value), "cost entry must be an object");
  const model = String(value.model ?? "");
  const currency = value.currency === "CNY" ? "CNY" : value.currency === "USD" ? "USD" : "";
  requireState(model, "cost.model is required");
  requireState(currency, "cost.currency must be USD or CNY");
  requireState(Array.isArray(value.pricingStatuses), "cost.pricingStatuses must be an array");
  return {
    model,
    currency,
    totalUsd: finiteStateNumber(value.totalUsd, "cost.totalUsd"),
    pricedTokens: finiteStateNumber(value.pricedTokens, "cost.pricedTokens"),
    unpricedTokens: finiteStateNumber(value.unpricedTokens, "cost.unpricedTokens"),
    minimumEstimatedTokens: finiteStateNumber(value.minimumEstimatedTokens, "cost.minimumEstimatedTokens"),
    serviceTierUnknownTokens: finiteStateNumber(value.serviceTierUnknownTokens, "cost.serviceTierUnknownTokens"),
    contextUnknownTokens: finiteStateNumber(value.contextUnknownTokens, "cost.contextUnknownTokens"),
    cacheWriteUnknownTokens: finiteStateNumber(value.cacheWriteUnknownTokens, "cost.cacheWriteUnknownTokens"),
    pricingStatuses: new Set(value.pricingStatuses.map(String)),
  };
}

function snapshotCost(cost) {
  return {
    model: cost.model,
    currency: cost.currency,
    totalUsd: cost.totalUsd,
    pricedTokens: cost.pricedTokens,
    unpricedTokens: cost.unpricedTokens,
    minimumEstimatedTokens: cost.minimumEstimatedTokens,
    serviceTierUnknownTokens: cost.serviceTierUnknownTokens,
    contextUnknownTokens: cost.contextUnknownTokens,
    cacheWriteUnknownTokens: cost.cacheWriteUnknownTokens,
    pricingStatuses: [...cost.pricingStatuses],
  };
}

function emptyCosts() {
  return {
    costByModel: {},
    pricedTokens: 0,
    unpricedTokens: 0,
    minimumEstimatedTokens: 0,
    serviceTierUnknownTokens: 0,
    contextUnknownTokens: 0,
    cacheWriteUnknownTokens: 0,
    pricingStatus: "no-data",
  };
}

function createCostExtension(options) {
  const estimateCost = options.estimateCost || ((event) => event.costEstimate || null);
  return {
    create: () => ({ ...emptyCosts(), modelCosts: new Map(), scenarioReasons: new Set(), estimatedRecords: 0 }),
    empty: emptyCosts,
    restore(row, value) {
      Object.assign(row, {
        estimatedRecords: finiteStateNumber(value.estimatedRecords ?? 0, "row.estimatedRecords"),
        pricedTokens: finiteStateNumber(value.pricedTokens ?? 0, "row.pricedTokens"),
        unpricedTokens: finiteStateNumber(value.unpricedTokens ?? 0, "row.unpricedTokens"),
        minimumEstimatedTokens: finiteStateNumber(value.minimumEstimatedTokens ?? 0, "row.minimumEstimatedTokens"),
        serviceTierUnknownTokens: finiteStateNumber(
          value.serviceTierUnknownTokens ?? 0,
          "row.serviceTierUnknownTokens",
        ),
        contextUnknownTokens: finiteStateNumber(value.contextUnknownTokens ?? 0, "row.contextUnknownTokens"),
        cacheWriteUnknownTokens: finiteStateNumber(value.cacheWriteUnknownTokens ?? 0, "row.cacheWriteUnknownTokens"),
      });
      requireState(Array.isArray(value.costs), "row.costs must be an array");
      requireState(Array.isArray(value.scenarioReasons), "row.scenarioReasons must be an array");
      for (const costValue of value.costs) {
        const cost = costFromState(costValue);
        const costKey = `${cost.model}\u0000${cost.currency}`;
        requireState(!row.modelCosts.has(costKey), `duplicate cost: ${costKey}`);
        row.modelCosts.set(costKey, cost);
      }
      row.scenarioReasons = new Set(value.scenarioReasons.map(String));
    },
    add(row, event, key, modelName, ...providedEstimates) {
      const estimate = providedEstimates.length ? providedEstimates[0] : estimateCost(event);
      if (estimate) {
        options.onEstimate?.(event, estimate, key);
        row.estimatedRecords += 1;
        const currency = estimate.currency === "CNY" ? "CNY" : "USD";
        const modelCostKey = `${modelName}\u0000${currency}`;
        const cost = row.modelCosts.get(modelCostKey) || {
          model: modelName,
          totalUsd: 0,
          currency,
          pricedTokens: 0,
          unpricedTokens: 0,
          minimumEstimatedTokens: 0,
          serviceTierUnknownTokens: 0,
          contextUnknownTokens: 0,
          cacheWriteUnknownTokens: 0,
          pricingStatuses: new Set(),
        };
        cost.totalUsd += Number(estimate.totalUsd || 0);
        cost.pricedTokens += Number(estimate.pricedTokens || 0);
        cost.unpricedTokens += Number(estimate.unpricedTokens || 0);
        cost.minimumEstimatedTokens += Number(estimate.minimumEstimatedTokens || 0);
        cost.serviceTierUnknownTokens += Number(estimate.serviceTierUnknownTokens || 0);
        cost.contextUnknownTokens += Number(estimate.contextUnknownTokens || 0);
        cost.cacheWriteUnknownTokens += Number(estimate.cacheWriteUnknownTokens || 0);
        if (estimate.pricingStatus) cost.pricingStatuses.add(estimate.pricingStatus);
        row.modelCosts.set(modelCostKey, cost);
        row.pricedTokens += Number(estimate.pricedTokens || 0);
        row.unpricedTokens += Number(estimate.unpricedTokens || 0);
        row.minimumEstimatedTokens += Number(estimate.minimumEstimatedTokens || 0);
        row.serviceTierUnknownTokens += Number(estimate.serviceTierUnknownTokens || 0);
        row.contextUnknownTokens += Number(estimate.contextUnknownTokens || 0);
        row.cacheWriteUnknownTokens += Number(estimate.cacheWriteUnknownTokens || 0);
        for (const reason of estimate.unpricedReasons || []) {
          if (/^(cache-write-ttl-|fast-pricing-unavailable-|legacy-context-pricing-unverified-)/.test(reason))
            row.scenarioReasons.add(reason);
        }
      }
    },
    result(row) {
      const modelCosts = [...row.modelCosts.values()];
      const currenciesByModel = new Map();
      for (const cost of modelCosts) {
        const currencies = currenciesByModel.get(cost.model) || new Set();
        currencies.add(cost.currency);
        currenciesByModel.set(cost.model, currencies);
      }
      const statusValues = [...row.modelCosts.values()].flatMap((entry) => [...entry.pricingStatuses]);
      let pricingStatus = "unavailable";
      if (row.estimatedRecords > 0) {
        pricingStatus =
          row.unpricedTokens > 0
            ? row.pricedTokens > 0
              ? "partial"
              : "unpriced"
            : row.minimumEstimatedTokens > 0
              ? "minimum-estimate"
              : "estimated";
        if (!row.pricedTokens && !row.unpricedTokens && statusValues.includes("unknown")) pricingStatus = "unknown";
      }
      return {
        costByModel: Object.fromEntries(
          modelCosts.map((cost) => {
            const mixed = currenciesByModel.get(cost.model).size > 1;
            return [
              mixed ? `${cost.model}\u0000${cost.currency}` : cost.model,
              {
                ...(mixed ? { model: cost.model } : {}),
                totalUsd: cost.totalUsd,
                currency: cost.currency || "USD",
                pricedTokens: cost.pricedTokens,
                unpricedTokens: cost.unpricedTokens,
                minimumEstimatedTokens: cost.minimumEstimatedTokens,
                serviceTierUnknownTokens: cost.serviceTierUnknownTokens,
                contextUnknownTokens: cost.contextUnknownTokens,
                cacheWriteUnknownTokens: cost.cacheWriteUnknownTokens,
                pricingStatus:
                  cost.unpricedTokens > 0
                    ? cost.pricedTokens > 0
                      ? "partial"
                      : "unpriced"
                    : cost.minimumEstimatedTokens > 0
                      ? "minimum-estimate"
                      : "estimated",
              },
            ];
          }),
        ),
        pricedTokens: row.pricedTokens,
        unpricedTokens: row.unpricedTokens,
        minimumEstimatedTokens: row.minimumEstimatedTokens,
        serviceTierUnknownTokens: row.serviceTierUnknownTokens,
        contextUnknownTokens: row.contextUnknownTokens,
        cacheWriteUnknownTokens: row.cacheWriteUnknownTokens,
        ...(row.scenarioReasons.size ? { scenarioReasons: [...row.scenarioReasons].sort() } : {}),
        pricingStatus,
      };
    },
    snapshot(row) {
      return {
        costs: [...row.modelCosts.values()].map(snapshotCost),
        estimatedRecords: row.estimatedRecords,
        pricedTokens: row.pricedTokens,
        unpricedTokens: row.unpricedTokens,
        minimumEstimatedTokens: row.minimumEstimatedTokens,
        serviceTierUnknownTokens: row.serviceTierUnknownTokens,
        contextUnknownTokens: row.contextUnknownTokens,
        cacheWriteUnknownTokens: row.cacheWriteUnknownTokens,
        scenarioReasons: [...row.scenarioReasons].sort(),
      };
    },
  };
}

/** @param {Record<string, any>} [range] @param {string} [bucket] @param {Record<string, any>} [options] */
export function createTimelineAccumulator(range = {}, bucket = "day", options = {}) {
  return createUsageTimelineAccumulator(range, bucket, {
    ...options,
    stateVersion: 1,
    modelName: options.modelName || ((value) => canonicalModelName(value, options.pricingModels)),
    extension: createCostExtension(options),
  });
}

/** @param {Iterable<any>} events @param {Record<string, any>} [range] @param {string} [bucket] @param {Record<string, any>} [options] */
export function buildTimelineRows(events = [], range = {}, bucket = "day", options = {}) {
  const accumulator = createTimelineAccumulator(range, bucket, options);
  for (const event of events) accumulator.add(event);
  return accumulator.result();
}

export function quotaRecordValues(total, cost, sessions, rate = 1) {
  const amount = (key) =>
    Number(cost?.[`${key}Usd`] || 0) + Number(cost?.[`${key}Cny`] || 0) / (Number(rate) > 0 ? Number(rate) : 1);
  return {
    totalTokens: total.total,
    inputTokens: total.input,
    cachedTokens: total.cached,
    outputTokens: total.output,
    reasoningTokens: total.reasoning,
    sessionCount: sessions,
    modelCount: cost?.modelCount,
    cacheHitRate: cost?.cacheHitRate,
    totalCost: amount("total"),
    inputCost: amount("input"),
    cachedCost: amount("cachedInput"),
    outputCost: amount("output"),
  };
}

export function quotaRecordsForRange(range, quota, observations, summarizeWindow) {
  if (!range?.quotaWindow || range.quotaState !== "available" || !quota?.limitId) return {};
  const mode = range.quotaPreset || range.preset;
  const minutes = mode === "quota_5h" ? 300 : mode === "quota_week" ? 10080 : 0;
  if (!minutes) return {};
  const start = new Date(range.start).getTime();
  const asOf = new Date(range.asOf || quota.asOf).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(asOf)) return {};
  const completed = completedQuotaWindows(observations, quota.limitId, asOf, minutes);
  if (completed === null) return {};
  const baselines = {};
  let hasPrevious = false;
  for (const window of completed) {
    if (Date.parse(window.windowEndExclusive) > start) continue;
    const previous = summarizeWindow({
      start: new Date(window.windowStart),
      end: new Date(Date.parse(window.windowEndExclusive) - 1),
      quotaWindow: true,
    });
    if (previous.eventCount <= 0) continue;
    hasPrevious = true;
    for (const [metric, value] of Object.entries(previous.values)) {
      if (!Number.isFinite(value)) continue;
      baselines[metric] ??= { count: 0, threshold: -Infinity };
      const entry = baselines[metric];
      entry.count += 1;
      entry.threshold = Math.max(entry.threshold, value + Math.max(1, Math.abs(value)) * 1e-10);
    }
  }
  if (!hasPrevious) return {};
  const current = summarizeWindow(range);
  if (!current.eventCount) return {};
  const titles = {
    totalTokens: "总 tokens",
    inputTokens: "总输入",
    cachedTokens: "缓存读取",
    outputTokens: "输出",
    reasoningTokens: "推理输出",
    sessionCount: "会话数",
    modelCount: "模型数量",
    cacheHitRate: "缓存命中率",
    totalCost: "估算花销",
    inputCost: "缓外输入花销",
    cachedCost: "缓存输入花销",
    outputCost: "输出花销",
  };
  const records = {};
  for (const [metric, title] of Object.entries(titles)) {
    const value = current.values[metric];
    const baseline = baselines[metric];
    if (!Number.isFinite(value) || value <= 0 || !baseline?.count || value <= baseline.threshold) continue;
    records[metric] = {
      title: `${title}最高的${minutes === 300 ? "5 小时限额窗口" : "每周限额窗口"}`,
      unit: minutes === 300 ? "5-hour window" : "weekly limit window",
      period: `${new Date(range.start).toISOString()} – ${new Date(range.windowEndExclusive || new Date(range.end).getTime() + 1).toISOString()}`,
      value,
      comparedWindowCount: baseline.count,
    };
  }
  return records;
}
