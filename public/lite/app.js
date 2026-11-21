import {
  drawTimelineCanvas,
  tokenTimelineSeries,
  timelineTokenAriaLabel,
  renderTokenMetricHtml,
  usageTooltipPosition,
  parseRecentValue,
  nextQuotaPresetState,
  nextRecentState,
  timelineSlotRangeTitle,
  nextPresetState as nextSharedPresetState,
  renderComparisonHtml as renderSharedComparisonHtml,
} from "../dashboard-view-utils.js";

import { createSourceManager, homeRowsFromMetadata } from "../source-view.js";
import {
  formatTokenMillions,
  formatUsageTooltip,
  renderBarListHtml,
  filterPeriodComparisonRows,
  nextComparisonSort,
  renderPeriodComparisonTableHtml,
  rangeLabel,
  QUOTA_MODE_LABELS,
  usageValue,
  formatTokens,
  displayModelName,
  quotaWindowBounds,
  asDate,
  COMPARISON_PERIOD_LABELS,
  QUOTA_PRESETS,
} from "../dashboard-render.js";
import {
  MAX_TIMELINE_SLOTS,
  isPreviousWeeklyRange,
  isPreviousQuotaRange,
  hasSelectedCodexSource,
} from "../timeline-utils.js";
import {
  displayRecentValue,
  formatLocalDateTime,
  getLocale,
  initializeLocale,
  localizeQuotaReason,
  localizeText,
  setLocale,
  translatePage,
} from "../locale.js";
import { escapeHtml } from "../html-utils.js";
import {
  calendarParts,
  rangeCalendarZone,
  dateKey,
  monthStart,
  parseLocalDate,
  renderDatePickerHtml,
  selectDateRange,
} from "../calendar.js";
import { state } from "./app-state.js";
import { createDashboardRuntime } from "../dashboard-runtime.js";
const $ = (selector) => document.querySelector(selector);
let quotaNoticeTimer = null;
const sourceManager = createSourceManager({
  state,
  beginRuntimeTask: (...a) => runtime.beginRuntimeTask(...a),
  updateRuntimeTask: (...a) => runtime.updateRuntimeTask(...a),
  runtimeRequestHeaders: (...a) => runtime.runtimeRequestHeaders(...a),
  finishRuntimeTask: (...a) => runtime.finishRuntimeTask(...a),
  loadUsage: (...a) => runtime.loadUsage(...a),
  currentMetadata,
  reconcileQuotaSourceSelection,
});
const { view: importView, renderHomes, readExcludedHomes, renderSourceOptions } = sourceManager;
const QUOTA_UI_COPY = Object.freeze({
  unavailable: "此限额窗口当前不可用。",
  missingSnapshot: "尚无限额快照，请等待 Codex 写入限额记录。",
  waiting: "等待新的限额记录。",
  invalidBoundaries: "限额窗口边界无效。",
  asOf: "统计数据截至",
});

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

const tooltipRows = new WeakMap();

const timelineBars = new WeakMap();

const timelineFocusIndex = new WeakMap();

const drawnChartBox = new WeakMap();

function isChartBoxDrawn(canvas) {
  if (!canvas.clientWidth || !canvas.clientHeight) return true;
  const drawn = drawnChartBox.get(canvas);
  return Boolean(drawn && drawn.width === canvas.clientWidth && drawn.height === canvas.clientHeight);
}

function translateRenderedDashboard() {
  translatePage(document.querySelector("main.shell") || document.body);
}

function updateLanguageButton() {
  const button = $("#languageToggle");
  if (!button) return;
  const english = getLocale() === "en-US";
  button.classList.toggle("active", english);
  button.setAttribute("aria-pressed", String(english));
  button.setAttribute("aria-label", english ? "English interface. Switch to Chinese" : "当前中文界面，点击切换到英文");
  button.title = english ? "Switch to Chinese" : "切换到 English";
  button.querySelector("[data-language='zh-CN']")?.classList.toggle("is-selected", !english);
  button.querySelector("[data-language='en-US']")?.classList.toggle("is-selected", english);
}

function setTokenMetric(selector, value) {
  const element = $(selector);
  if (!element) return;
  element.innerHTML = renderTokenMetricHtml(value);
  element.title = formatTokens(value);
}

function formatCompact(value) {
  return compactFormatter.format(Math.round(value || 0));
}

function usageTooltip() {
  return $("#usageTooltip");
}

const publishedTooltipBodies = new WeakMap();

function publishUsageTooltipBody(tooltip, html) {
  const published = publishedTooltipBodies.get(tooltip);
  if (published && published.html === html && published.dom === tooltip.innerHTML) return false;
  tooltip.innerHTML = html;
  publishedTooltipBodies.set(tooltip, { html, dom: tooltip.innerHTML });
  return true;
}

function hideUsageTooltip() {
  const tooltip = usageTooltip();
  if (tooltip && !tooltip.hidden) {
    tooltip.hidden = true;
  }
}

function positionUsageTooltip(anchor) {
  const tooltip = usageTooltip();
  if (!tooltip || tooltip.hidden) {
    return;
  }
  const rect = anchor?.getBoundingClientRect?.();
  const anchorX = Number.isFinite(anchor?.clientX) ? anchor.clientX : rect?.left || 8;
  const anchorY = Number.isFinite(anchor?.clientY) ? anchor.clientY : rect?.bottom || 8;
  const position = usageTooltipPosition(
    anchorX,
    anchorY,
    tooltip.offsetWidth,
    tooltip.offsetHeight,
    window.innerWidth,
    window.innerHeight,
  );
  tooltip.style.left = `${position.left}px`;
  tooltip.style.top = `${position.top}px`;
}

function scrollUsageTooltip(deltaY) {
  const tooltip = usageTooltip();
  if (!tooltip || tooltip.hidden || !deltaY) return false;
  const maxScroll = tooltip.scrollHeight - tooltip.clientHeight;
  const nextScroll = Math.min(maxScroll, Math.max(0, tooltip.scrollTop + deltaY));
  if (maxScroll <= 0 || nextScroll === tooltip.scrollTop) return false;
  tooltip.scrollTop = nextScroll;
  return true;
}

function showUsageTooltip(row, anchor, options = null) {
  const tooltip = usageTooltip();
  if (!tooltip || !row) {
    hideUsageTooltip();
    return;
  }
  // A pointermove that keeps hitting the same row only has to reposition the tooltip; the body is
  // rewritten only when the hit's content differs from what the node already shows.
  publishUsageTooltipBody(tooltip, formatUsageTooltip(row, null, options || undefined));
  if (tooltip.hidden) tooltip.hidden = false;
  positionUsageTooltip(anchor);
}

function showTimelineTooltip(row, anchor) {
  const tooltip = usageTooltip();
  if (!tooltip || !row) {
    hideUsageTooltip();
    return;
  }
  const range = currentSummary()?.range || null;
  publishUsageTooltipBody(tooltip, formatTimelineTooltip(row, state.timelineMode, range));
  if (tooltip.hidden) tooltip.hidden = false;
  positionUsageTooltip(anchor);
  const chart = document.querySelector("#timelineChart");
  if (chart && document.activeElement === chart) {
    const label = localizeText(timelineAccessibleLabel(row, state.timelineMode, range));
    // Re-writing an unchanged aria-label still emits a mutation record (and a translation round),
    // so the value the chart already carries is compared before writing.
    if (chart.getAttribute?.("aria-label") !== label) chart.setAttribute("aria-label", label);
  }
}

function isQuotaPreset(preset = state.preset) {
  return QUOTA_PRESETS.includes(preset);
}

function quotaWindowAvailability(quotaSnapshot, preset) {
  const window = quotaSnapshot?.windows?.[preset];
  if (window?.state === "available") return { available: true, reason: "" };
  return {
    available: false,
    reason:
      (window?.reason ? localizeQuotaReason(window) : "") ||
      (quotaSnapshot ? QUOTA_UI_COPY.unavailable : QUOTA_UI_COPY.missingSnapshot),
  };
}

function formatLocalClock(date, zone = state.metadata?.calendarContext?.timeZone || "local") {
  const parts = calendarParts(date, zone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function formatLocalDateTimeWithZone(value) {
  const date = asDate(value);
  if (!date || Number.isNaN(date.getTime())) return "未知时间";
  const timeZone = state.metadata?.calendarContext?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const seconds = String(calendarParts(date, timeZone).second).padStart(2, "0");
  const zoneName = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName").value;
  const offset = zoneName.replace("GMT", "UTC");
  const timestamp =
    getLocale() === "en-US"
      ? formatLocalDateTime(date, getLocale(), timeZone)
      : `${dateKey(date, timeZone)} ${formatLocalClock(date, timeZone)}:${seconds}`;
  return `${timestamp} (${timeZone}, ${offset})`;
}

function quotaRangeAccessibleLabel(range) {
  const { start, end } = quotaWindowBounds(range);
  const mode = range?.quotaPreset || range?.preset;
  const name = range?.recentValue ? displayRecentValue(range.recentValue) : QUOTA_MODE_LABELS[mode] || "限额窗口";
  const interval =
    start && end
      ? `[${formatLocalDateTimeWithZone(start)}, ${formatLocalDateTimeWithZone(end)})`
      : localizeText("限额窗口边界不可用");
  if (getLocale() === "en-US") {
    const asOf = range?.asOf ? `; data as of ${formatLocalDateTimeWithZone(range.asOf)}` : "";
    const weekNote = isPreviousWeeklyRange(range)
      ? `; ${localizeText("仅显示有用量的日期")}`
      : isPreviousQuotaRange(range)
        ? `; ${localizeText("仅显示有用量的半小时")}`
        : "";
    return `${localizeText(name)} ${interval}${asOf}${weekNote}`;
  }
  const asOf = range?.asOf ? `；${QUOTA_UI_COPY.asOf} ${formatLocalDateTimeWithZone(range.asOf)}` : "";
  const weekNote = isPreviousWeeklyRange(range)
    ? "；仅显示有用量的日期"
    : isPreviousQuotaRange(range)
      ? "；仅显示有用量的半小时"
      : "";
  return `${name} ${interval}${asOf}${weekNote}`;
}

function quotaTimelineSlotInfo(row) {
  if (!isQuotaPreset() && !(state.preset === "recent" && ["上一个5h", "上周"].includes(state.recentValue))) return null;
  const startMs = Number(row?.slotStartMs ?? row?.key);
  const endMs = Number(row?.slotEndExclusiveMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const start = new Date(startMs);
  const end = new Date(endMs);
  const title = `${formatLocalDateTime(start)} – ${formatLocalDateTime(end)}`;
  const asOf = asDate(state.summary?.range?.asOf || state.quotaSnapshot?.asOf);
  const note =
    asOf && asOf.getTime() > startMs && asOf.getTime() < endMs
      ? localizeText(`统计截至 ${formatLocalDateTime(asOf)}`)
      : "";
  return { title, note };
}

function nextPresetState(currentState = {}, preset = "today") {
  return nextSharedPresetState(currentState, preset, state.preset);
}

function renderMetrics(summary) {
  setTokenMetric("#totalTokens", summary.totals.total);
  setTokenMetric("#inputTokens", summary.totals.input);
  setTokenMetric("#cachedTokens", summary.totals.cached);
  setTokenMetric("#outputTokens", summary.totals.output);
  setTokenMetric("#reasoningTokens", summary.totals.reasoning);
  $("#cacheHitRate").innerHTML =
    summary.cacheHitRate == null
      ? "—"
      : `${(summary.cacheHitRate * 100).toFixed(2)}<small class="metric-unit">%</small>`;
  $("#cacheHitRate").title = $("#cacheHitRate").textContent;
}

function renderTimelineDetails(summary) {
  const mode = state.timelineMode;
  const label = mode === "model" ? "按模型" : "按渠道";
  $("#detailModeLabel").textContent = label;
  const container = $("#detailList");
  if (summary.timelineError) {
    container.innerHTML = '<div class="empty">时间范围过大，无法生成时间分布。</div>';
    return;
  }
  if (!timelineBreakdownReady(summary.timeline || [], mode)) {
    container.innerHTML = `<div class="empty">模型明细不可用，请刷新数据。</div>`;
    return;
  }
  const rows = timelineDetailRows(summary, mode);

  const options = { modelNames: mode === "model" };
  container.innerHTML = renderBarListHtml(rows, null, options);
  container.querySelectorAll(".bar-row").forEach((element, index) => {
    const row = rows[index];
    tooltipRows.set(element, { row, options });
    element.querySelector(".bar-fill").style.background = chartPattern(row.name, mode).css;
    element.classList.toggle("series-muted", Boolean(highlightedSeries && highlightedSeries !== row.name));
  });
}

const periodComparisonTables = new Map();

function periodComparisonTableSignature(rows, options) {
  return JSON.stringify([
    options.kind,
    options.query ?? "",
    options.expanded ?? null,
    options.sort ?? null,
    options.totals ?? null,
    rows,
  ]);
}

function publishPeriodComparisonTable(target, rows, options) {
  const kind = options.kind;
  const signature = periodComparisonTableSignature(rows, options);
  const published = periodComparisonTables.get(kind);
  if (published && published.signature === signature) return;
  const html = renderPeriodComparisonTableHtml(rows, options);
  // A changed signature can still render to the same markup (a query that filters nothing, a
  // sort that is already in effect), so the produced output is compared as well: the DOM write
  // itself stays at zero whenever the markup would not change.
  if (!published || published.html !== html) target.innerHTML = html;
  periodComparisonTables.set(kind, { signature, html });
}

function renderPeriodComparisons(comparison) {
  const expanded = state.expandedPeriodCell;
  const models = filterPeriodComparisonRows(comparison?.models || []);
  const repositories = filterPeriodComparisonRows(comparison?.repositories || []);
  publishPeriodComparisonTable($("#modelComparisonTable"), models, {
    kind: "model",
    query: state.modelComparisonQuery,
    expanded,
    totals: comparison?.totals,
    sort: state.modelComparisonSort,
  });
  publishPeriodComparisonTable($("#repositoryComparisonTable"), repositories, {
    kind: "repository",
    query: state.repositoryComparisonQuery,
    expanded,
    totals: comparison?.totals,
    sort: state.repositoryComparisonSort,
  });
}

function renderComparisonHtml(comparison, range = null) {
  return renderSharedComparisonHtml(comparison, range, state.preset);
}

function renderComparison(summary) {
  const container = $("#comparisonSummary");
  if (!container) return;
  container.hidden = false;
  container.innerHTML = renderComparisonHtml(summary?.comparison, summary?.range);
}

function updateTimelineModeButtons() {
  for (const button of document.querySelectorAll("[data-timeline-mode]")) {
    const selected = button.dataset.timelineMode === state.timelineMode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function timelineRowAt(canvas, event) {
  const bars = timelineBars.get(canvas) || [];
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = bars.find((bar) => x >= bar.x && x <= bar.x + bar.width && y >= bar.y && y <= bar.y + bar.height);
  return hit?.row || null;
}

function setupUsageTooltip() {
  const timelineChart = $("#timelineChart");
  timelineChart.addEventListener("pointermove", (event) => {
    const row = timelineRowAt(timelineChart, event);
    if (row) {
      showTimelineTooltip(row, event);
      return;
    }
    hideUsageTooltip();
  });
  timelineChart.addEventListener("pointerleave", hideUsageTooltip);
  timelineChart.addEventListener("focus", () => {
    const bars = timelineBars.get(timelineChart) || [];
    if (!bars.length) return;
    timelineFocusIndex.set(timelineChart, 0);
    showTimelineTooltip(bars[0].row, timelineChart);
  });
  timelineChart.addEventListener("keydown", (event) => {
    const bars = timelineBars.get(timelineChart) || [];
    if (!bars.length) return;
    let index = timelineFocusIndex.get(timelineChart) || 0;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") index = Math.min(bars.length - 1, index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") index = Math.max(0, index - 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = bars.length - 1;
    else if (event.key === "Escape") {
      hideUsageTooltip();
      return;
    } else return;
    event.preventDefault();
    timelineFocusIndex.set(timelineChart, index);
    showTimelineTooltip(bars[index].row, timelineChart);
  });
  timelineChart.addEventListener("blur", () => {
    timelineChart.setAttribute("aria-label", timelineChart.dataset.chartAriaLabel || "時間分布圖");
    hideUsageTooltip();
  });

  document.addEventListener("pointermove", (event) => {
    if (event.target === timelineChart) {
      return;
    }
    const target = event.target.closest?.("[data-usage-tooltip]");
    if (!target) {
      hideUsageTooltip();
      return;
    }
    const bound = tooltipRows.get(target);
    showUsageTooltip(bound?.row, event, bound?.options);
  });
  document.addEventListener("pointerleave", hideUsageTooltip);
  document.addEventListener("focusin", (event) => {
    const target = event.target.closest?.("[data-usage-tooltip]");
    if (!target) {
      return;
    }
    const bound = tooltipRows.get(target);
    showUsageTooltip(bound?.row, target, bound?.options);
  });
  document.addEventListener("focusout", (event) => {
    if (event.target.closest?.("[data-usage-tooltip]")) {
      hideUsageTooltip();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !event.target.closest?.("[data-usage-tooltip]") ||
      (event.key !== "PageDown" && event.key !== "PageUp")
    ) {
      return;
    }
    const delta = (event.key === "PageDown" ? 1 : -1) * (usageTooltip()?.clientHeight || 0) * 0.75;
    if (scrollUsageTooltip(delta)) event.preventDefault();
  });
  document.addEventListener(
    "wheel",
    (event) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !event.target.closest?.("[data-usage-tooltip]")
      )
        return;
      if (scrollUsageTooltip(event.deltaY)) event.preventDefault();
    },
    { passive: false },
  );
}

function currentSummary() {
  return state.summary;
}

function currentMetadata() {
  return state.metadata;
}

function renderUnavailableQuota(reason, range = null) {
  hideUsageTooltip();
  const message = reason || QUOTA_UI_COPY.waiting;
  const unavailableRange = range || {
    preset: state.preset,
    quotaState: "waiting",
    quotaReason: message,
    asOf: state.quotaSnapshot?.asOf || state.now,
    bucket: state.preset === "quota_5h" ? "quota_30m" : "quota_24h",
  };
  unavailableRange.quotaReason = message;
  state.emptySummaryMessage = message;
  state.emptySummaryRange = unavailableRange;
  const rangeNode = $("#rangeLabel");
  if (rangeNode) {
    rangeNode.textContent = rangeLabel({ range: unavailableRange });
    rangeNode.title = quotaRangeAccessibleLabel(unavailableRange);
  }
  for (const selector of [
    "#totalTokens",
    "#inputTokens",
    "#cachedTokens",
    "#outputTokens",
    "#reasoningTokens",
    "#cacheHitRate",
  ]) {
    const node = $(selector);
    if (node) {
      node.textContent = "—";
      node.title = "";
    }
  }

  renderComparison({ comparison: null, range: unavailableRange });
  const warning = $("#timelineRangeWarning");
  if (warning) {
    warning.hidden = true;
    warning.textContent = "";
  }
  const legend = $("#timelineLegend");
  if (legend) legend.innerHTML = "";
  const detailList = $("#detailList");
  if (detailList) detailList.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  updateTimelineModeButtons();
  drawTimeline($("#timelineChart"), [], [], unavailableRange);
  updateQuotaPresetButton();
  updateDateRangeControl();
}

function renderEmptySummaryState() {
  hideUsageTooltip();
  updateTimelineModeButtons();
  renderComparison({ comparison: null, range: state.emptySummaryRange });
  const message = state.emptySummaryMessage || "用量摘要暂不可用。";
  const warning = $("#timelineRangeWarning");
  if (warning) {
    warning.hidden = true;
    warning.textContent = "";
  }
  const legend = $("#timelineLegend");
  if (legend) legend.innerHTML = "";
  const details = $("#detailList");
  if (details) details.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  drawTimeline($("#timelineChart"), [], [], state.emptySummaryRange);
}

function render() {
  const summary = currentSummary();
  const metadata = currentMetadata();
  if (!summary || !metadata) {
    renderEmptySummaryState();
    return;
  }
  const quotaWindow = summary.quota?.windows?.[state.preset];
  const quotaState = summary.range?.quotaState ?? quotaWindow?.state;
  const quotaReason =
    quotaWindow?.reason && getLocale() === "en-US"
      ? localizeQuotaReason(quotaWindow)
      : (summary.range?.quotaReason ?? quotaWindow?.reason);
  if (isQuotaPreset(state.preset) && quotaState !== "available") {
    renderUnavailableQuota(quotaReason || QUOTA_UI_COPY.waiting, {
      ...summary.range,
      quotaState: quotaState || "missing",
      quotaReason: quotaReason || QUOTA_UI_COPY.waiting,
    });
    renderPeriodComparisons(state.periodComparison);
    renderHomes(homeRowsFromMetadata(metadata), { canModify: true, excludedIds: state.excludedHomes });
    // Every region written above (metrics, comparison tables, homes) is inside <main>.
    translateRenderedDashboard();
    return;
  }
  hideUsageTooltip();
  renderMetrics(summary);
  const quotaMode = isQuotaPreset(summary.range?.preset || state.preset) || Boolean(summary.range?.quotaWindow);
  renderComparison(summary);
  renderPeriodComparisons(state.periodComparison);
  const rangeNode = $("#rangeLabel");
  rangeNode.textContent = rangeLabel(summary);
  const rangeStart = asDate(summary.range.start);
  const rangeEnd = asDate(summary.range.end);
  rangeNode.title = quotaMode
    ? quotaRangeAccessibleLabel(summary.range)
    : rangeStart && rangeEnd
      ? rangeCalendarZone(summary.range) === "utc"
        ? `${rangeStart.toISOString()} 至 ${rangeEnd.toISOString()}`
        : `${rangeStart.toLocaleString(getLocale())} 至 ${rangeEnd.toLocaleString(getLocale())}`
      : rangeNode.textContent;
  const timelineWarning = $("#timelineRangeWarning");
  if (timelineWarning) {
    timelineWarning.hidden = !summary.timelineError;
    timelineWarning.textContent = summary.timelineError
      ? `此范围超过 ${MAX_TIMELINE_SLOTS.toLocaleString(getLocale())} 个时间槽，无法生成时间分布。请缩短日期范围。`
      : "";
  }
  updateTimelineModeButtons();
  renderTimelinePanels(summary);
  renderHomes(homeRowsFromMetadata(metadata), { canModify: true, excludedIds: state.excludedHomes });
  if (!$("#importDialog")?.hidden) {
    // 数据先于弹窗就绪时，让弹窗里的来源多选同步最新列表。
    renderSourceOptions();
  }
  updateQuotaPresetButton();
  translateRenderedDashboard();
  if (!$("#importDialog")?.hidden) translatePage($("#importDialog"));
}

function updatePresetButtons() {
  for (const button of document.querySelectorAll("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === state.preset);
  }
  updateQuotaPresetButton();
}

function clearQuotaNotice() {
  if (quotaNoticeTimer !== null) {
    window.clearTimeout(quotaNoticeTimer);
    quotaNoticeTimer = null;
  }
  state.quotaNotice = "";
  updateQuotaPresetButton();
}

function showQuotaNotice(message) {
  clearQuotaNotice();
  if (!message) return;
  state.quotaNotice = message;
  updateQuotaPresetButton();
  quotaNoticeTimer = window.setTimeout(() => {
    quotaNoticeTimer = null;
    state.quotaNotice = "";
    updateQuotaPresetButton();
  }, 5000);
}

function updateQuotaPresetButton() {
  const button = $("#quotaPresetToggle");
  if (!button) return;
  const enabled = selectedCodexAvailable();
  button.disabled = !enabled;
  const quotaSnapshot = state.quotaSnapshot || state.summary?.quota || null;
  const quotaActive = isQuotaPreset(state.preset);
  const currentStatus = quotaActive ? quotaWindowAvailability(quotaSnapshot, state.preset) : null;
  const preferred = QUOTA_PRESETS.includes(state.lastQuotaPreset) ? state.lastQuotaPreset : "quota_5h";
  const target = quotaActive ? (state.preset === "quota_5h" ? "quota_week" : "quota_5h") : preferred;
  const targetName = QUOTA_MODE_LABELS[target] || "限额窗口";
  const currentName = quotaActive
    ? QUOTA_MODE_LABELS[state.preset]
    : state.preset === "recent"
      ? displayRecentValue(state.recentValue)
      : state.preset === "week"
        ? "本周"
        : COMPARISON_PERIOD_LABELS[state.preset] || state.preset;
  const currentReason = currentStatus && !currentStatus.available ? `；${currentStatus.reason}` : "";
  const label = `当前范围为${currentName}${currentReason}；点击切换到${targetName}`;
  button.classList.toggle("active", quotaActive);
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(quotaActive));
  button.title = enabled ? label : "";
  for (const mode of button.querySelectorAll("[data-quota-mode]")) {
    mode.classList.toggle("is-selected", quotaActive && mode.dataset.quotaMode === state.preset);
  }
  const status = $("#quotaPresetStatus");
  if (status) {
    status.textContent = state.quotaNotice;
    status.hidden = !enabled || !state.quotaNotice;
  }
  updateRecentControls();
}

function selectedCodexAvailable() {
  return hasSelectedCodexSource(homeRowsFromMetadata(currentMetadata() || {}), state.excludedHomes);
}

function reconcileQuotaSourceSelection() {
  if (!selectedCodexAvailable()) {
    if (
      isQuotaPreset(state.preset) ||
      (state.preset === "recent" && ["上一个5h", "上周"].includes(state.recentValue))
    ) {
      state.preset = "today";
      state.bucket = "hour";
    }
    if (["上一个5h", "上周"].includes(state.recentValue)) state.recentValue = "上个月";
    state.quotaNotice = "";
  }
  updatePresetButtons();
  updateRecentControls();
}

function updateRecentControls() {
  const recentValue = $("#recentValue");
  const display = displayRecentValue(state.recentValue);
  if (recentValue && recentValue.value !== display) {
    recentValue.value = display;
  }
  for (const option of document.querySelectorAll("[data-recent-option]")) {
    const mode = { 上一个5h: "quota_5h", 上周: "quota_week" }[option.dataset.recentOption];
    const quota = state.quotaSnapshot || state.summary?.quota;
    option.disabled = Boolean(
      mode && (!selectedCodexAvailable() || quota?.previousWindows?.[mode]?.state !== "available"),
    );
    option.setAttribute("aria-selected", String(option.dataset.recentOption === state.recentValue));
  }
}

function datePickerViewDate() {
  return state.datePickerView || parseLocalDate(state.startDate) || serviceCalendarDate();
}

function serviceCalendarDate() {
  return parseLocalDate(dateKey(new Date(), state.metadata?.calendarContext?.timeZone || "local"));
}

function updateDateRangeControl() {
  const button = $("#dateRangeButton");
  if (!button) return;
  // 只展示正在生效或正在挑选的范围；切回预设后旧的自定义日期保留在 state 里供下次预填，但不再显示。
  const range = state.datePickerDraft || (state.preset === "custom" ? state : { startDate: "", endDate: "" });
  $("#dateRangeStart").textContent = range.startDate || localizeText("年/月/日");
  $("#dateRangeEnd").textContent = range.endDate || "";
  $("#dateRangeEnd").hidden = !range.endDate;
  $("#dateRangeSeparator").hidden = !range.endDate;
  button.classList.toggle("has-range", Boolean(range.startDate));
  button.classList.toggle("active", state.preset === "custom");
  const label = [localizeText("打开日期范围日历"), range.startDate, range.endDate].filter(Boolean).join(" · ");
  button.setAttribute("aria-label", label);
  button.title = label;
}

function renderDatePicker(field) {
  const picker = $("#dateRangePicker");
  if (!picker) {
    return;
  }
  const range = state.datePickerDraft || state;
  picker.innerHTML = renderDatePickerHtml({
    field,
    viewDate: datePickerViewDate(),
    startDate: range.startDate,
    endDate: range.endDate,
  });
  updateDateRangeControl();
}

function closeDatePickers() {
  state.datePickerField = "";
  state.datePickerDraft = null;
  $("#dateRangePicker").hidden = true;
  $("#dateRangeButton").setAttribute("aria-expanded", "false");
  updateDateRangeControl();
}

function setDatePickerOpen(open) {
  if (!open) {
    closeDatePickers();
    return;
  }
  setRecentMenuOpen(false);
  state.datePickerDraft = { startDate: state.startDate, endDate: state.endDate };
  state.datePickerView = monthStart(parseLocalDate(state.startDate) || serviceCalendarDate());
  state.datePickerField = "start";
  renderDatePicker("start");
  $("#dateRangePicker").hidden = false;
  $("#dateRangeButton").setAttribute("aria-expanded", "true");
}

function applyDateRangeValues(startDate, endDate) {
  state.startDate = startDate;
  state.endDate = endDate;
  Object.assign(state, nextPresetState(state, "custom"));
  clearQuotaNotice();
  updatePresetButtons();
  refreshViewForFilters();
}

function clearDateRangeSelection() {
  // 清空正在挑选的草稿与已保存的自定义日期；若自定义范围已生效，过滤也一并撤掉，回到默认“今日”（与刷新页面等效）。
  state.datePickerDraft = { startDate: "", endDate: "" };
  state.datePickerField = "start";
  state.startDate = "";
  state.endDate = "";
  if (state.preset === "custom") {
    Object.assign(state, nextPresetState(state, "today"));
    clearQuotaNotice();
    updatePresetButtons();
    updateRecentControls();
    refreshViewForFilters();
  }
  renderDatePicker("start");
  $("#dateRangeButton").focus({ preventScroll: true });
}

function selectDatePickerDate(field, value) {
  const next = selectDateRange({ ...state.datePickerDraft, field }, value);
  if (!next) return;
  state.datePickerDraft = { startDate: next.startDate, endDate: next.endDate };
  if (next.complete) {
    applyDateRangeValues(next.startDate, next.endDate);
    closeDatePickers();
    $("#dateRangeButton").focus({ preventScroll: true });
    return;
  }
  state.datePickerField = next.field;
  renderDatePicker(next.field);
  $("#dateRangePicker").querySelector(`[data-date="${next.startDate}"]`)?.focus({ preventScroll: true });
}

function shiftDatePickerMonth(field, offset) {
  const current = datePickerViewDate();
  state.datePickerView = new Date(current.getFullYear(), current.getMonth() + offset, 1);
  renderDatePicker(field);
}

function setRecentMenuOpen(open) {
  const menu = $("#recentRangeMenu");
  const input = $("#recentValue");
  const button = $("#recentMenuButton");
  const segment = document.querySelector(".recent-segment");
  if (!menu || !input || !button || !segment) {
    return;
  }
  if (open) {
    closeDatePickers();
  }
  menu.hidden = !open;
  input.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-expanded", String(open));
  segment.classList.toggle("menu-open", open);
}

function activateRecentValue(value) {
  const next = nextRecentState(state, value);
  const option = [...document.querySelectorAll("[data-recent-option]")].find(
    (node) => node.dataset.recentOption === next.recentValue,
  );
  if (option?.disabled) return;
  if (!parseRecentValue(next.recentValue)) {
    runtime.runtimeNotice("最近范围格式无效。请使用数字和天、周、月或年。");
    updateRecentControls();
    setRecentMenuOpen(false);
    return;
  }
  state.recentValue = next.recentValue;
  state.preset = next.preset;
  state.bucket = next.bucket;
  clearQuotaNotice();
  updatePresetButtons();
  updateRecentControls();
  updateDateRangeControl();
  setRecentMenuOpen(false);
  refreshViewForFilters();
}

function toggleQuotaPreset() {
  if (!selectedCodexAvailable()) return;
  const quotaSnapshot = state.quotaSnapshot || state.summary?.quota || null;
  const next = nextQuotaPresetState(state);
  state.preset = next.preset;
  state.bucket = next.bucket;
  state.lastQuotaPreset = next.lastQuotaPreset;
  clearQuotaNotice();
  updatePresetButtons();
  updateRecentControls();
  const availability = quotaWindowAvailability(quotaSnapshot, next.preset);
  const reason = availability.available ? "正在加载限额窗口…" : availability.reason;
  state.summary = null;
  renderUnavailableQuota(reason);
  if (!availability.available) showQuotaNotice(`${QUOTA_MODE_LABELS[next.preset]}：${reason}`);
  refreshViewForFilters();
}
function setLanguage(locale) {
  state.locale = setLocale(locale);
  updateLanguageButton();
  updateRecentControls();
  updateDateRangeControl();
  if (state.datePickerField) renderDatePicker(state.datePickerField);
  render();
  runtime.renderAutoRefreshControls();
  translatePage();
}
// A six-pixel repeat remains recognizable inside both a narrow hour column and a detail bar.
const TILE_SIZE = 6;
const TILE_MARKS = [
  "", // solid
  "M-3 3L3 -3 M-3 9L9 -3 M3 9L9 3", // diagonal
  "M2.9 3h0.2", // dot (round caps)
  "M0 3h6", // horizontal
  "M1.5 0v6 M0 1.5h6", // grid
  "M3 0v6", // vertical
  "M-3 3l6 6 M-3 -3l12 12 M3 -3l6 6", // reverse diagonal
  "M0 1.5h3 M3 4.5h3", // check
];
const chartPatternSlots = { channel: new Map(), model: new Map() };
const chartPatterns = [];
let highlightedSeries = null;

// Reserve remembered patterns for visible names before assigning free ones to newcomers.
export function assignChartPatternSlots(names, slots) {
  const palette = Array.from({ length: TILE_MARKS.length * 2 }, (_, index) => index);
  for (let start = 0; start < names.length; start += palette.length) {
    const free = new Set(palette);
    const pending = names.slice(start, start + palette.length).filter((name) => !free.delete(slots.get(name)));
    const available = [...free];
    for (const [index, name] of pending.entries()) slots.set(name, available[index]);
  }
}

function chartPattern(name, mode) {
  const slot = chartPatternSlots[mode].get(name) ?? 0;
  if (chartPatterns[slot]) return chartPatterns[slot];
  const mark = slot % TILE_MARKS.length;
  const dark = Boolean((slot + Math.floor(slot / TILE_MARKS.length)) % 2);
  const base = dark ? "#737373" : "#dedede";
  let css = base;
  let paint = base;
  if (mark) {
    const tile = document.createElement("canvas");
    tile.width = tile.height = TILE_SIZE * 2;
    const ctx = tile.getContext("2d");
    ctx.scale(2, 2);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    ctx.strokeStyle = dark ? "#f5f5f5" : "#404040";
    ctx.lineWidth = mark === 2 || mark === 7 ? 3 : 1.5;
    if (mark === 2) ctx.lineCap = "round";
    ctx.stroke(new Path2D(TILE_MARKS[mark]));
    paint = ctx.createPattern(tile, "repeat");
    paint.setTransform(new DOMMatrix().scale(0.5));
    css = `url(${tile.toDataURL()}) 0 0 / ${TILE_SIZE}px ${TILE_SIZE}px repeat`;
  }
  chartPatterns[slot] = { css, paint };
  return chartPatterns[slot];
}
function timelineBreakdownReady(rows, mode) {
  return (
    mode === "channel" ||
    rows
      .filter((r) => usageValue(r.total, "total") > 0)
      .every(
        (r) =>
          Array.isArray(r.models) &&
          Math.abs(r.models.reduce((s, m) => s + usageValue(m.total, "total"), 0) - usageValue(r.total, "total")) <
            1e-6,
      )
  );
}
function timelineDetailRows(summary, mode) {
  return summary.timelineError ? [] : (mode === "model" ? summary.models : summary.channels) || [];
}
function formatTimelineTooltip(row, mode = "channel", range = null) {
  const info = quotaTimelineSlotInfo(row);
  const note = info?.note ? `<div class="usage-tooltip-note">${escapeHtml(info.note)}</div>` : "";
  const title = info?.title || timelineSlotRangeTitle(row, range) || row.key;
  if (mode === "channel") return formatUsageTooltip(row, title, { compactTokens: true }) + note;
  return (
    '<div class="usage-tooltip-title">' +
    escapeHtml(title) +
    "</div>" +
    note +
    '<div class="usage-tooltip-grid"><span>总 tokens</span><span>' +
    formatTokenMillions(usageValue(row.total, "total")) +
    '</span></div><div class="usage-tooltip-subtitle">模型</div><div class="usage-tooltip-grid">' +
    [...(row.models || [])]
      .sort((a, b) => usageValue(a.total, "total") - usageValue(b.total, "total") || a.name.localeCompare(b.name))
      .map(
        (m) =>
          '<span class="usage-tooltip-label">' +
          escapeHtml(displayModelName(m.name)) +
          '</span><span class="usage-tooltip-value">' +
          formatTokenMillions(usageValue(m.total, "total")) +
          "</span>",
      )
      .join("") +
    "</div>"
  );
}
function timelineAccessibleLabel(row, mode, range) {
  const info = quotaTimelineSlotInfo(row);
  const title = info
    ? [info.title, info.note].filter(Boolean).join(", ")
    : timelineSlotRangeTitle(row, range) || row.key;
  return (
    title +
    ", " +
    formatTokenMillions(usageValue(row.total, "total")) +
    " tokens, " +
    (mode === "model" ? row.models : row.channels || [])
      .map((r) => `${r.name} ${formatTokenMillions(usageValue(r.total, "total"))}`)
      .join(", ")
  );
}
function renderTimelinePanels(summary) {
  const mode = state.timelineMode;
  const groups = timelineDetailRows(summary, mode);
  const names = groups.filter((row) => usageValue(row.total) > 0).map((row) => row.name);
  assignChartPatternSlots(names, chartPatternSlots[mode]);
  if (!names.includes(highlightedSeries)) highlightedSeries = null;
  renderTimelineDetails(summary);
  const legend = $("#timelineLegend");
  const focusedName = legend.contains(document.activeElement) ? document.activeElement.dataset.series : null;
  legend.innerHTML = names
    .map((name) => {
      const label = escapeHtml(mode === "model" ? displayModelName(name) : name);
      return `<span role="listitem"><button type="button" class="timeline-legend-item" data-series="${escapeHtml(name)}" aria-pressed="${name === highlightedSeries}">
      <span class="timeline-legend-swatch" aria-hidden="true" style="background:${chartPattern(name, mode).css}"></span>
      <span>${label}</span></button></span>`;
    })
    .join("");
  if (focusedName)
    [...legend.querySelectorAll("button")]
      .find((button) => button.dataset.series === focusedName)
      ?.focus({ preventScroll: true });
  drawTimeline($("#timelineChart"), summary.timeline, groups, summary.range);
}
function drawTimeline(canvas, rows, groups, range) {
  const mode = state.timelineMode;
  const styles = getComputedStyle(document.documentElement);
  const unavailableQuota = isQuotaPreset(range?.preset) && range?.quotaState !== "available";
  const messages = {
    aria: localizeText(timelineTokenAriaLabel(range, mode)),
    empty: localizeText(unavailableQuota ? range?.quotaReason || QUOTA_UI_COPY.waiting : "没有匹配的用量记录"),
    emptyAria: unavailableQuota,
    unavailable: rows.length && !timelineBreakdownReady(rows, mode) ? localizeText("模型明细不可用，请重启服务") : null,
  };
  const paint = (name) =>
    highlightedSeries && name !== highlightedSeries ? "#404040" : chartPattern(name, mode).paint;
  const fills = new Map(groups.map(({ name }) => [name, paint(name)]));
  const series = tokenTimelineSeries(mode, {
    channelRows: groups,
    channelColors: fills,
    modelRows: groups,
    modelColorsByName: fills,
    modelColor: paint,
    channelColor: "#aaaaaa",
    formatAxis: formatCompact,
  });
  series.sortStacks = false; // Keep layers in detail/legend order across every interval.
  return drawTimelineCanvas(canvas, rows, {
    styles,
    palette: { line: "#777777", text: "#cccccc", fallback: "#cccccc" },
    outline: { roleId: "chart.axis-line", lineWidth: 1 },
    ratio: window.devicePixelRatio || 1,
    range,
    bucket: range?.bucket || state.bucket,
    series,
    messages,
    timelineBars,
    drawnChartBox,
  });
}
function refreshViewForFilters() {
  runtime.refreshViewForFilters();
}
const runtime = createDashboardRuntime({
  state,
  render,
  reconcileQuotaSourceSelection,
  clearQuotaNotice,
  updateQuotaPresetButton,
  renderUnavailableQuota,
  quotaWindowAvailability,
  isQuotaPreset,
  pollImportTask: (...a) => sourceManager.pollImportTask(...a),
});
initializeLocale();
state.locale = getLocale();
async function bootDashboard() {
  updateDateRangeControl();
  setupUsageTooltip();
  updateLanguageButton();
  $("#languageToggle").addEventListener("click", () => {
    setLanguage(getLocale() === "en-US" ? "zh-CN" : "en-US");
  });

  $("#quotaPresetToggle").addEventListener("click", toggleQuotaPreset);
  $("#dateRangeButton").addEventListener("click", () => setDatePickerOpen(!state.datePickerField));

  $("#presetButtons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) {
      return;
    }
    closeDatePickers();
    const next = nextPresetState(state, button.dataset.preset);
    state.preset = next.preset;
    state.bucket = next.bucket;
    if (next.lastQuotaPreset) state.lastQuotaPreset = next.lastQuotaPreset;
    clearQuotaNotice();
    updatePresetButtons();
    updateRecentControls();
    updateDateRangeControl();
    refreshViewForFilters();
  });

  $("#bucketSelect")?.remove(); // 粒度选择已移除，粒度随范围自动推导。

  $("#dateRangePicker").addEventListener("click", (event) => {
    const clear = event.target.closest("[data-date-picker-clear]");
    if (clear) {
      event.stopPropagation();
      if (!clear.disabled) {
        clearDateRangeSelection();
      }
      return;
    }
    const field = state.datePickerField || "start";
    const nav = event.target.closest("[data-date-picker-action]");
    if (nav) {
      event.stopPropagation();
      shiftDatePickerMonth(field, nav.dataset.datePickerAction === "next" ? 1 : -1);
      $("#dateRangePicker")
        .querySelector(`[data-date-picker-action="${nav.dataset.datePickerAction}"]`)
        ?.focus({ preventScroll: true });
      return;
    }
    const day = event.target.closest("[data-date]");
    if (!day) return;
    event.stopPropagation();
    selectDatePickerDate(field, day.dataset.date);
  });
  $(".toolbar").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.datePickerField) {
      closeDatePickers();
      $("#dateRangeButton").focus({ preventScroll: true });
    }
  });

  $("#recentValue").addEventListener("change", (event) => {
    activateRecentValue(event.target.value);
  });

  $("#recentValue").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    activateRecentValue(event.target.value);
  });

  $("#recentValue").addEventListener("focus", () => {
    setRecentMenuOpen(true);
  });

  $("#recentMenuButton").addEventListener("click", (event) => {
    event.stopPropagation();
    const shouldOpen = $("#recentRangeMenu").hidden;
    $("#recentValue").focus();
    setRecentMenuOpen(shouldOpen);
  });

  $("#recentRangeMenu").addEventListener("click", (event) => {
    const option = event.target.closest("[data-recent-option]");
    if (!option || option.disabled) {
      return;
    }
    event.stopPropagation();
    activateRecentValue(option.dataset.recentOption);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".recent-segment")) {
      setRecentMenuOpen(false);
    }
    if (!event.target.closest("#dateRangePicker, #dateRangeButton")) {
      closeDatePickers();
    }
  });

  $("#autoRefreshToggle").addEventListener("click", () => runtime.setAutoRefreshEnabled(!state.autoRefreshEnabled));
  $("#autoRefreshError").addEventListener("click", () => runtime.setAutoRefreshErrorDetails(true));
  $("#autoRefreshErrorBack").addEventListener("click", () => runtime.setAutoRefreshErrorDetails(false));
  $("#autoRefreshErrorDetails").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    runtime.setAutoRefreshErrorDetails(false);
  });
  $("#timelineModes").addEventListener("click", (event) => {
    const button = event.target.closest("[data-timeline-mode]");
    if (!button || button.dataset.timelineMode === state.timelineMode) return;
    highlightedSeries = null;
    state.timelineMode = button.dataset.timelineMode;
    render();
  });
  $("#timelineLegend").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-series]");
    if (!button || !state.summary) return;
    highlightedSeries = button.dataset.series === highlightedSeries ? null : button.dataset.series;
    renderTimelinePanels(state.summary);
  });

  $("#addImportButton").addEventListener("click", sourceManager.openImportDialog);
  $("#repositoryComparisonSearch").addEventListener("input", (event) => {
    state.repositoryComparisonQuery = event.target.value;
    renderPeriodComparisons(state.periodComparison);
  });
  $("#modelComparisonSearch").addEventListener("input", (event) => {
    state.modelComparisonQuery = event.target.value;
    renderPeriodComparisons(state.periodComparison);
  });
  for (const selector of ["#repositoryComparisonTable", "#modelComparisonTable"]) {
    $(selector).addEventListener("click", (event) => {
      const sortButton = event.target.closest("[data-comparison-sort]");
      if (sortButton) {
        const { kind, period } = sortButton.dataset;
        const stateKey = kind === "repository" ? "repositoryComparisonSort" : "modelComparisonSort";
        state[stateKey] = nextComparisonSort(state[stateKey], period);
        renderPeriodComparisons(state.periodComparison);
        document
          .querySelector(
            `#${kind === "repository" ? "repositoryComparisonTable" : "modelComparisonTable"} [data-comparison-sort][data-period="${period}"]`,
          )
          ?.focus({ preventScroll: true });
        return;
      }
      const button = event.target.closest("[data-period-expand]");
      if (!button) return;
      const next = { kind: button.dataset.kind, key: button.dataset.key, period: button.dataset.period };
      const current = state.expandedPeriodCell;
      state.expandedPeriodCell =
        current?.kind === next.kind && current?.key === next.key && current?.period === next.period ? null : next;
      renderPeriodComparisons(state.periodComparison);
      const restoredButton = [...document.querySelectorAll("[data-period-expand]")].find(
        (candidate) =>
          candidate.dataset.kind === next.kind &&
          candidate.dataset.key === next.key &&
          candidate.dataset.period === next.period,
      );
      restoredButton?.focus({ preventScroll: true });
    });
  }
  $("#homeList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-import-action='remove']");
    if (!button) {
      return;
    }
    button.disabled = true;
    sourceManager.removeImportDirectory(button.dataset.importPath).catch(() => {
      button.disabled = false;
    });
  });
  $("#importForm").addEventListener("submit", sourceManager.submitImportDirectory);
  $("#rescanImportsButton").addEventListener("click", () => void sourceManager.scanImportDirectories());
  $("#manualImportButton").addEventListener("click", () => {
    sourceManager.showManualImport($("#manualImportArea").hidden);
  });
  $("#importCandidates").addEventListener("change", sourceManager.updateImportButton);
  $("#importPath").addEventListener("input", sourceManager.updateImportButton);
  $("#pickImportDirectoryButton").addEventListener("click", sourceManager.pickImportDirectory);
  $("#sourcePicker").addEventListener("change", (event) => {
    const input = event.target.closest("input[data-source-id]");
    if (!input) {
      return;
    }
    sourceManager.setSourceOption(input.dataset.sourceId, input.checked);
  });
  $("#cancelImportButton").addEventListener("click", sourceManager.closeImportDialog);
  $("#importDialog").addEventListener("click", (event) => {
    if (event.target.id === "importDialog") {
      sourceManager.closeImportDialog();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !$("#importDialog").hidden) sourceManager.trapDialogFocus(event, $("#importDialog"));
    if (event.key === "Escape") {
      setRecentMenuOpen(false);
      if (!$("#importDialog").hidden) sourceManager.closeImportDialog();
    }
  });
  let resizeRenderQueued = false;
  const scheduleResizeRender = () => {
    if (resizeRenderQueued) return;
    resizeRenderQueued = true;
    requestAnimationFrame(() => {
      resizeRenderQueued = false;
      render();
    });
  };
  window.addEventListener("resize", scheduleResizeRender);
  // 图表高度随容器（右侧详情行数、窗口/面板拖拽）变化：只有出现「还没在这个尺寸上画过」的盒子才重绘。
  // 一次窗口缩放会同时惊动上面的 window 监听和这个 observer；render() 自己又会改变图表井的高度，
  // 所以按「已画过的盒子」判定，才能让同一手势只跑一轮整页 render，而不是两轮。
  const chartCanvas = $("#timelineChart");
  if (chartCanvas && typeof ResizeObserver !== "undefined") {
    let chartResizeTimer = null;
    const chartResizeObserver = new ResizeObserver(() => {
      if (isChartBoxDrawn(chartCanvas)) return;
      clearTimeout(chartResizeTimer);
      chartResizeTimer = setTimeout(() => {
        chartResizeTimer = null;
        // A render may have painted at this size while the debounce was pending (the window
        // resize path runs on rAF), which makes this observation redundant too.
        if (!isChartBoxDrawn(chartCanvas)) render();
      }, 60);
    });
    chartResizeObserver.observe(chartCanvas);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) runtime.renderRelativeCheckTime();
    if (!document.hidden && state.autoRefreshEnabled) {
      runtime.startAutoRefresh();
      void runtime.checkForUpdates();
    }
  });
  window.addEventListener("pagehide", () => {
    runtime.dispose();
    window.clearInterval(importView.timer);
  });
  state.excludedHomes = readExcludedHomes();
  runtime.initializeAutoRefresh();
  updateRecentControls();
  void sourceManager.pollImportTask(true);
  void runtime.loadUsage().then(() => runtime.startAutoRefresh());
}

if (typeof document !== "undefined") void bootDashboard();
