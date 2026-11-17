import { isQuotaUsage } from "../public/quota-usage.js";
import { canonicalModelName } from "../public/model-identity.js";
import { emptyUsage, sessionIdentity } from "../public/usage-fields.js";
import {
  channelForRange,
  homeSourceKinds,
  deriveTimelineBucket,
  createTimelineAccumulator,
} from "../public/timeline-utils.js";
import { emptyPeriodMetrics, addPeriodEvent } from "../public/period-comparison.js";
import { cacheHitRate } from "../public/usage-metrics.js";
import {
  isQuotaPreset,
  addUsage,
  resolveDateRange,
  groupByUsage,
  groupRepositories,
  indexDateRange,
  addIndexedUsage,
  groupIndexedEvents,
  groupIndexedRepositories,
  usageComparison,
  summaryQuotaContext,
  sourceGroupForQuota,
  summaryRangeFields,
} from "./usage-query.js";

function buildTimelineRowsWithLimit(events, range, bucket, options) {
  try {
    const timeline = options.createTimeline
      ? options.createTimeline()
      : createTimelineAccumulator(range, bucket, options);
    for (const event of events()) timeline.add(event);
    return { timeline: timeline.result(), timelineError: null };
  } catch (error) {
    if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
    return { timeline: [], timelineError: error.message };
  }
}

export function summarizeUsageIndex(index, filters = {}, options = {}) {
  const strings = index.strings;
  const modelName = options.modelName || canonicalModelName;
  const sourceKinds = homeSourceKinds(index.homes);
  const { quota, asOf } = summaryQuotaContext(index.rateLimitObservations, filters);
  const excluded = new Set((filters.excludeHomes || []).map(String));
  const range = indexDateRange(
    { ...filters, quota, now: asOf },
    index.events.filter((event) => !excluded.has(String(strings[event.h]))),
  );
  const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
  const bucket = deriveTimelineBucket(
    range,
    range.bucket || (quotaPreset ? (range.preset === "quota_5h" ? "quota_30m" : "quota_24h") : filters.bucket || "day"),
  );
  const now = range.asOf || asOf;
  const allEvents = index.events.filter(
    (event) =>
      !excluded.has(String(strings[event.h])) &&
      (!quotaPreset ||
        (sourceGroupForQuota(sourceKinds.get(String(strings[event.h]))) &&
          isQuotaUsage({ model: strings[event.m], quotaSource: event.quotaSource }))),
  );
  const events = allEvents.filter((event) => {
    if (!Number.isFinite(event.t)) {
      return false;
    }
    if (range.start && event.t < range.start.getTime()) {
      return false;
    }
    if (range.end && event.t > range.end.getTime()) {
      return false;
    }
    return true;
  });

  const sessionIds = new Set(events.map((event) => sessionIdentity(event.h, event.s)));
  const totals = events.reduce((sum, event) => addIndexedUsage(sum, event), emptyUsage());
  const comparison = usageComparison({
    range,
    allEvents,
    eventTime: (event) => event.t,
    eventSession: (event) => sessionIdentity(event.h, event.s),
    addEventUsage: addIndexedUsage,
    currentTotals: totals,
    now,
    quota,
    observations: index.rateLimitObservations,
  });
  function* timelineEvents() {
    for (const event of events) {
      yield {
        timestamp: event.t,
        sessionId: strings[event.s] || String(event.s),
        channel: strings[event.c] || "Unknown",
        homeId: strings[event.h],
        sourceKind: sourceKinds.get(String(strings[event.h])),
        model: strings[event.m] || "Unknown model",
        repositoryKey: strings[event.rk],
        repositoryKind: strings[event.rt],
        total: {
          total: event.total,
          input: event.input,
          cached: event.cached,
          output: event.output,
          reasoning: event.reasoning,
        },
        detailMask: event.detailMask,
        cacheWriteTokens: event.cacheWriteTokens,
        cacheWriteKnown: Boolean(event.cacheWriteKnown),
        contextLevel: strings[event.contextLevel] || event.contextLevel,
        requestInputTokens: event.requestInputTokens,
        serviceTier: strings[event.serviceTier] || event.serviceTier,
        priceVersion: strings[event.priceVersion] || event.priceVersion,
      };
    }
  }
  const extension = options.createExtension?.(range, bucket, sourceKinds, modelName);
  const { timeline, timelineError } = buildTimelineRowsWithLimit(timelineEvents, range, bucket, {
    sourceKinds,
    modelName,
    createTimeline: extension?.createTimeline,
  });
  const details = events.reduce((detail, event) => {
    addPeriodEvent(detail, typeof event.total === "object" ? event : { ...event, total: event });
    return detail;
  }, emptyPeriodMetrics());
  const extensionFields = extension?.result(timelineError, timelineEvents);

  return {
    generatedAt: index.generatedAt,
    range: summaryRangeFields(range, bucket),
    totals,
    details,
    cacheHitRate: cacheHitRate(details),
    comparison,
    quota,
    ...extensionFields,
    eventCount: events.length,
    sessionCount: sessionIds.size,
    homeCount: new Set(events.map((event) => event.h)).size,
    timeline,
    timelineError,
    channels: groupIndexedEvents(index, events, (event) =>
      channelForRange(strings[event.c], range, sourceKinds.get(String(strings[event.h]))),
    ),
    homes: groupIndexedEvents(index, events, (event) => strings[event.l]),
    models: groupIndexedEvents(index, events, (event) => modelName(strings[event.m] || "Unknown model")),
    projects: groupIndexedEvents(index, events, (event) => strings[event.p] || "Unknown cwd"),
    repositories: groupIndexedRepositories(index, events),
  };
}

/** @param {import("./usage-types.js").UsageReport} report
 * @param {any} [filters]
 * @param {any} [options]
 * @returns {import("./usage-types.js").UsageSummary}
 */
export function summarizeUsage(report, filters = {}, options = {}) {
  const modelName = options.modelName || canonicalModelName;
  const sourceKinds = homeSourceKinds(report.homes);
  const { quota, asOf } = summaryQuotaContext(report.rateLimitObservations, filters);
  const excluded = new Set((filters.excludeHomes || []).map(String));
  const range = resolveDateRange(
    { ...filters, quota, now: asOf },
    report.events.filter((event) => !excluded.has(String(event.homeId))),
  );
  const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
  const bucket = deriveTimelineBucket(
    range,
    range.bucket || (quotaPreset ? (range.preset === "quota_5h" ? "quota_30m" : "quota_24h") : filters.bucket || "day"),
  );
  const now = range.asOf || asOf;
  const allEvents = report.events.filter(
    (event) =>
      !excluded.has(String(event.homeId)) &&
      (!quotaPreset || (sourceGroupForQuota(sourceKinds.get(String(event.homeId))) && isQuotaUsage(event))),
  );
  const events = allEvents.filter((event) => {
    const date = new Date(event.timestamp);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    if (range.start && date < range.start) {
      return false;
    }
    if (range.end && date > range.end) {
      return false;
    }
    return true;
  });

  const sessionIds = new Set(events.map((event) => sessionIdentity(event.homeId, event.sessionId)));
  const totals = events.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const comparison = usageComparison({
    range,
    allEvents,
    eventTime: (event) => Date.parse(event.timestamp),
    eventSession: (event) => sessionIdentity(event.homeId, event.sessionId),
    addEventUsage: (sum, event) => addUsage(sum, event.total),
    currentTotals: totals,
    now,
    quota,
    observations: report.rateLimitObservations,
  });
  const extension = options.createExtension?.(range, bucket, sourceKinds, modelName);
  const { timeline, timelineError } = buildTimelineRowsWithLimit(() => events, range, bucket, {
    sourceKinds,
    modelName,
    createTimeline: extension?.createTimeline,
  });
  const details = events.reduce((detail, event) => {
    addPeriodEvent(detail, typeof event.total === "object" ? event : { ...event, total: event });
    return detail;
  }, emptyPeriodMetrics());
  const extensionFields = extension?.result(timelineError, () => events);

  /** @type {import("./usage-types.js").UsageSummary} */
  const summary = {
    generatedAt: report.generatedAt,
    range: summaryRangeFields(range, bucket),
    totals,
    details,
    cacheHitRate: cacheHitRate(details),
    comparison,
    quota,
    ...extensionFields,
    eventCount: events.length,
    sessionCount: sessionIds.size,
    homeCount: new Set(events.map((event) => event.homeId)).size,
    timeline,
    timelineError,
    channels: groupByUsage(events, (event) =>
      channelForRange(event.channel, range, sourceKinds.get(String(event.homeId))),
    ),
    homes: groupByUsage(events, (event) => event.homeLabel),
    models: groupByUsage(events, (event) => modelName(event.model || "Unknown model")),
    projects: groupByUsage(events, (event) => event.cwd || "Unknown cwd"),
    repositories: groupRepositories(events),
  };

  return summary;
}
