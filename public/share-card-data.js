import { SHARE_METRIC_DEFINITIONS } from "./share-metrics.js";
import { coveredCalendarDays } from "./range-metrics.js";
import { resolvePricingModel, isCodexAutoReview } from "./pricing-models.js";
import { pricingProvider } from "./pricing-directory.js";
import { calendarParts, dateKey, rangeCalendarZone } from "./calendar.js";

export const SHARE_PERIODS = Object.freeze([
  "today",
  "week",
  "month",
  "quota_5h",
  "quota_week",
  "recent",
  "custom",
  "all",
]);
export const SHARE_METRICS = Object.freeze(SHARE_METRIC_DEFINITIONS.map((metric) => metric.id));

function numberOrNull(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shareSelectionMatches(range, selection = {}) {
  if (!range || (selection.preset && selection.preset !== range.preset)) return false;
  if (selection.calendarZone && selection.calendarZone !== range.calendarZone) return false;
  if (range.preset === "recent" && selection.recentValue !== undefined && selection.recentValue !== range.recentValue)
    return false;
  if (range.preset === "custom") {
    for (const [option, field] of [
      ["startDate", "start"],
      ["endDate", "end"],
    ]) {
      if (
        selection[option] !== undefined &&
        selection[option] !== (range[field] ? dateKey(new Date(range[field]), rangeCalendarZone(range)) : "")
      )
        return false;
    }
  }
  return true;
}

export function canShareSummary(summary, selection = {}) {
  const range = summary?.range;
  if (
    !SHARE_PERIODS.includes(range?.preset) ||
    !shareSelectionMatches(range, selection) ||
    numberOrNull(summary?.totals?.total) === null
  )
    return false;
  if ((range.quotaWindow || ["quota_5h", "quota_week"].includes(range.preset)) && range.quotaState !== "available")
    return false;
  const start = dateOrNull(range.start),
    end = dateOrNull(range.end);
  if ((range.start && !start) || (range.end && !end) || (start && end && start > end)) return false;
  return ["all", "custom"].includes(range.preset) || Boolean(start && end);
}

export function shareCardFilename(range) {
  if (!range) return null;
  const start = dateOrNull(range.start),
    end = dateOrNull(range.end);
  if ((range.start && !start) || (range.end && !end)) return null;
  const stamp = (date, time = false) => {
    const day = dateKey(date, rangeCalendarZone(range)).replaceAll("-", "");
    const { hour: hours, minute: minutes } = calendarParts(date, rangeCalendarZone(range));
    return day + (time ? `_${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}` : "");
  };
  if (range.quotaWindow && start && end) {
    const finish = new Date(end.getTime() + 1);
    return `usage_${range.quotaPreset || range.preset}_${stamp(start, true)}-${stamp(finish, true)}.png`;
  }
  if (!start && !end)
    return range.preset === "all" ? "usage_all.png" : range.preset === "custom" ? "usage_custom_all.png" : null;
  if (!start) return `usage_until_${stamp(end)}.png`;
  if (!end) return `usage_from_${stamp(start)}.png`;
  const first = stamp(start),
    last = stamp(end);
  return `usage_${first}${first === last ? "" : `-${last}`}.png`;
}

export function sharePeriodLabel(data, english = false) {
  const range = data.range;
  const labels = {
    today: ["今日", "Today"],
    week: ["本周", "This Week"],
    month: ["本月", "This Month"],
    quota_5h: ["5h", "5h"],
    quota_week: ["7d", "7d"],
    all: ["全部", "All Time"],
  };
  const named = { 上一个5h: ["上一5h", "Last 5h"], 上周: ["上一7d", "Last 7d"], 上个月: ["上个月", "Last Month"] };
  if (range.preset === "recent") {
    if (["今年", "去年"].includes(range.recentValue))
      return dateKey(new Date(range.start), rangeCalendarZone(range)).slice(0, 4);
    if (named[range.recentValue]) return named[range.recentValue][Number(english)];
  }
  if (labels[range.preset]) return labels[range.preset][Number(english)];
  const start = range.start && dateKey(new Date(range.start), rangeCalendarZone(range));
  const end = range.end && dateKey(new Date(range.end), rangeCalendarZone(range));
  if (start && end) return start === end ? start : `${start}–${end}`;
  if (start) return (english ? "From " : "自 ") + start;
  if (end) return (english ? "Until " : "截至 ") + end;
  return english ? "Custom · All" : "自定义 · 全部";
}

function matchingPeriodMetrics(periodComparison, range, total) {
  const bounds = periodComparison?.periods?.find((entry) => entry.key === range.preset);
  const metrics = periodComparison?.totals?.[range.preset];
  if (
    !bounds ||
    dateOrNull(bounds.start)?.toISOString() !== range.start ||
    dateOrNull(bounds.end)?.toISOString() !== range.end ||
    numberOrNull(metrics?.total) !== total
  ) {
    return null;
  }
  return metrics;
}

function displayCost(estimate, currency, rate) {
  const usd = numberOrNull(estimate?.totalUsd);
  const cny = numberOrNull(estimate?.totalCny);
  if (usd === null && cny === null) return null;
  // Match the homepage's native-currency buckets and display-time conversion.
  const safeRate = Number(rate) > 0 ? Number(rate) : 1;
  const amount = currency === "CNY" ? (usd ?? 0) * safeRate + (cny ?? 0) : (usd ?? 0) + (cny ?? 0) / safeRate;
  return Object.freeze({ amount, currency });
}

/**
 * Capture only displayable aggregates from the currently loaded dashboard response.
 * Pass periodComparison from the same response for trustworthy detail availability.
 * Unsupported or not-yet-loaded selections return null; rendering never reads page state.
 */
export function createShareCardData(summary, options = {}) {
  const period = options.preset ?? summary?.range?.preset;
  if (!canShareSummary(summary, options)) return null;
  const start = dateOrNull(summary.range.start);
  const end = dateOrNull(summary.range.end);
  const total = numberOrNull(summary.totals?.total);

  const range = Object.freeze({
    preset: period,
    start: start?.toISOString() || null,
    end: end?.toISOString() || null,
    recentValue: summary.range.recentValue || null,
    asOf: summary.range.asOf || null,
    quotaWindow: Boolean(summary.range.quotaWindow),
    quotaPreset: summary.range.quotaPreset || null,
    windowEndExclusive: summary.range.windowEndExclusive || null,
    calendarZone: summary.range.calendarZone === "utc" ? "utc" : "local",
    timeZone: summary.range.timeZone || null,
  });
  const detail =
    summary.details?.total === total ? summary.details : matchingPeriodMetrics(options.periodComparison, range, total);
  const totals = { total };
  const unavailableTokens = {};
  for (const key of ["input", "cached", "output", "reasoning", "uncached"]) {
    const field = key === "uncached" ? "uncachedInput" : key;
    const value = numberOrNull(detail?.[field] ?? (key === "uncached" ? null : summary.totals[key]));
    const unavailable = numberOrNull(detail?.[`${field}UnavailableTokens`]);
    totals[key] = value === 0 && unavailable > 0 ? null : value;
    unavailableTokens[key] = unavailable;
  }
  // Without the known-detail aggregate, input minus cached can invent uncached usage.
  if (!detail && total === 0) totals.uncached = 0;

  const models = (summary.models || [])
    .map((row) => ({ name: String(row.name || row.key || "Unknown model"), total: numberOrNull(row.total?.total) }))
    .filter((row) => row.total !== null)
    .sort((left, right) => right.total - left.total)
    .map(Object.freeze);
  const currency = options.currency === "CNY" ? "CNY" : "USD";
  const estimate = summary.costEstimate;
  const stats = summary.rangeMetrics;
  const providers = new Set(
    models
      .filter((row) => row.total > 0)
      .map((row) => pricingProvider(row.name).id)
      .filter((id) => id !== "other"),
  );
  const pricingModels = options.pricingModels || {};
  const free = models
    .filter((row) => !isCodexAutoReview(row.name) && resolvePricingModel(row.name, pricingModels).matchType === "free")
    .reduce((sum, row) => sum + row.total, 0);
  const review = models.filter((row) => isCodexAutoReview(row.name)).reduce((sum, row) => sum + row.total, 0);
  const cacheHitRate = detail
    ? detail.cacheRateInput > 0
      ? detail.cacheRateCached / detail.cacheRateInput
      : null
    : numberOrNull(estimate?.cacheHitRate);
  const previous =
    summary.comparison?.previousRange && summary.comparison.previousEventCount > 0
      ? numberOrNull(summary.comparison.previousTotals?.total)
      : null;
  const coveredDays = stats ? coveredCalendarDays(range, stats) : null;
  const ratio = (value, base) => (base > 0 ? value / base : null);
  const metricValues = Object.freeze({
    ...totals,
    cacheHit: cacheHitRate,
    sessions: numberOrNull(summary.sessionCount),
    models: numberOrNull(estimate?.modelCount),
    harnesses: stats ? stats.harnesses.length : null,
    providers: providers.size,
    repositories: stats?.repositoryCount ?? null,
    previous,
    delta: previous === null ? null : total - previous,
    growth: previous === null ? null : ratio(total - previous, previous),
    topModel: ratio(models[0]?.total || 0, total),
    topThree: ratio(
      models.slice(0, 3).reduce((sum, row) => sum + row.total, 0),
      total,
    ),
    activeDays: stats?.activeDays ?? null,
    dailyAverage: ratio(total, coveredDays),
    activeAverage: ratio(total, stats?.activeDays),
    peakDay: stats?.peakDay?.total ?? (stats ? 0 : null),
    peakHour: stats?.peakHour?.total ?? (stats ? 0 : null),
    maxSession: stats?.maxSessionTokens ?? null,
    free,
    freeShare: ratio(free, total),
    review,
  });
  const availableMetrics = SHARE_METRICS.filter(
    (id) =>
      !["topModel", "topThree", "free", "freeShare", "review"].includes(id) &&
      Number.isFinite(metricValues[id]) &&
      (!["activeDays", "dailyAverage", "activeAverage", "peakDay"].includes(id) ||
        (coveredDays > 1 && range.preset !== "quota_5h" && range.quotaPreset !== "quota_5h")),
  );
  const charts = stats
    ? Object.freeze({
        trend: Object.freeze(
          (summary.timeline || []).map((row) =>
            Object.freeze({ key: row.key, total: row.total.total, future: Boolean(row.future) }),
          ),
        ),
        harnesses: Object.freeze(
          stats.harnesses.map((row) => Object.freeze({ ...row, share: ratio(row.total, total) })),
        ),
        composition: Object.freeze({ ...stats.composition }),
      })
    : null;
  return Object.freeze({
    metricValues,
    availableMetrics: Object.freeze(availableMetrics),
    highlights: stats
      ? Object.freeze({
          peakDay: stats.peakDay && Object.freeze({ ...stats.peakDay }),
          peakHour: stats.peakHour && Object.freeze({ ...stats.peakHour }),
        })
      : null,
    charts,
    period,
    range,
    filename: shareCardFilename(range),
    totals: Object.freeze(totals),
    sessionCount: numberOrNull(summary.sessionCount),
    modelCount: numberOrNull(estimate?.modelCount),
    cacheHitRate,
    models: Object.freeze(models),
    cost: displayCost(estimate, currency, options.usdToCnyRate ?? estimate?.usdToCnyRate),
    unavailableTokens: Object.freeze(unavailableTokens),
  });
}
