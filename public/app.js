import {
  drawTimelineCanvas,
  tokenTimelineSeries,
  timelineTokenAriaLabel,
  renderTokenMetricHtml,
  usageTooltipPosition,
  normalizeRecentValue,
  parseRecentValue,
  nextQuotaPresetState,
  nextRecentState,
  timelineSlotRangeTitle,
  timelineAxisLabels,
  nextPresetState as nextSharedPresetState,
  renderComparisonHtml as renderSharedComparisonHtml,
} from "./dashboard-view-utils.js";
export {
  usageTooltipPosition,
  normalizeRecentValue,
  nextQuotaPresetState,
  nextRecentState,
  timelineSlotRangeTitle,
  timelineAxisLabels,
};

import { createDashboardRuntime } from "./dashboard-runtime.js";
import { setupMotionGlass } from "./waifu-motion.js";
import { createSourceManager, homeRowsFromMetadata } from "./source-view.js";
export { renderSourceOptionsHtml, renderHomesHtml } from "./source-view.js";
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
} from "./dashboard-render.js";
export {
  renderPeriodComparisonTableHtml,
  nextComparisonSort,
  filterPeriodComparisonRows,
  renderBarListHtml,
  rangeLabel,
  timelineChannelSegments,
  formatUsageTooltip,
  formatTokenMillions,
} from "./dashboard-render.js";
import { canShareSummary } from "./share-card-data.js";
import {
  MAX_TIMELINE_SLOTS,
  isPreviousWeeklyRange,
  isPreviousQuotaRange,
  hasSelectedCodexSource,
} from "./timeline-utils.js";
import {
  displayRecentValue,
  formatLocalDateTime,
  getLocale,
  initializeLocale,
  localizeQuotaReason,
  localizeServerError,
  localizeText,
  setLocale,
  translatePage,
} from "./i18n.js";
import { CODEX_GPT_61_CONTEXT_WINDOW, resolvePricingModel } from "./pricing-models.js";
import { PRICING_PROVIDERS, pricingProvider, pricingReleaseDate } from "./pricing-directory.js";
import { state } from "./app-state.js";
import { escapeHtml, externalHttpUrl, safeChartColor } from "./html-utils.js";
import {
  calendarParts,
  rangeCalendarZone,
  dateKey,
  datePickerMonthModel,
  monthStart,
  parseLocalDate,
  renderDatePickerHtml,
  selectDateRange,
} from "./calendar.js";

export { datePickerMonthModel, renderDatePickerHtml };

if (typeof document !== "undefined" && document.body) initializeLocale();
state.locale = getLocale();
let quotaNoticeTimer = null;
let achievementDialog = null;
let achievementUnread = null;
let achievementNotice = null;
let motionGlass;
function refreshAchievements() {
  void achievementUnread?.refresh().catch(() => {});
}

const AUTO_REFRESH_INTERVAL_MS = 60_000;
const QUOTA_UI_COPY = Object.freeze({
  unavailable: "此限额窗口当前不可用。",
  missingSnapshot: "尚无限额快照，请等待 Codex 写入限额记录。",
  waiting: "等待新的限额记录。",
  invalidBoundaries: "限额窗口边界无效。",
  asOf: "统计数据截至",
});
const THEME_STORAGE_KEY = "codexUsageTheme";
const paletteStudioPreview = globalThis.window?.frameElement?.id === "studioFrame";
const AUTO_REFRESH_STORAGE_KEY = "codexUsageAutoRefresh";
const DISPLAY_CURRENCY_STORAGE_KEY = "codexUsageDisplayCurrency";
const PRICING_SEEN_MODELS_STORAGE_KEY = "codexUsagePricingSeenModelsV1";
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const cnyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const tooltipRows = new WeakMap();
const timelineBars = new WeakMap();
const timelineFocusIndex = new WeakMap();
// CSS-pixel box the canvas backing store was last sized for. The chart ResizeObserver compares
// against it so a render that changed the chart well height (and then painted at the new size)
// does not schedule a second whole-page render for a box that is already on screen.
const drawnChartBox = new WeakMap();

// True when repainting the chart for the current box would repeat the last draw: either the
// canvas is not laid out (hidden view — nothing to paint, and the view toggle renders anyway) or
// the box is the one the last draw already sized the backing store for.
function isChartBoxDrawn(canvas) {
  if (!canvas.clientWidth || !canvas.clientHeight) return true;
  const drawn = drawnChartBox.get(canvas);
  return Boolean(drawn && drawn.width === canvas.clientWidth && drawn.height === canvas.clientHeight);
}

const $ = (selector) => document.querySelector(selector);
const {
  view: importView,
  renderHomes,
  pickImportDirectory,
  readExcludedHomes,
  updateImportButton,
  showManualImport,
  scanImportDirectories,
  pollImportTask,
  openImportDialog,
  renderSourceOptions,
  setSourceOption,
  closeImportDialog,
  trapDialogFocus,
  submitImportDirectory,
  removeImportDirectory,
} = createSourceManager({
  state,
  beginRuntimeTask,
  updateRuntimeTask,
  runtimeRequestHeaders,
  finishRuntimeTask,
  loadUsage,
  currentMetadata,
  reconcileQuotaSourceSelection,
  fetch: (...args) => fetch(...args),
});

// Every region render() rewrites lives inside <main class="shell">. The dialogs, the tooltip and
// the skin decoration are siblings of that subtree and are re-rendered (and translated) by their
// own renderers, so a render pass only has to re-translate the dashboard subtree instead of
// walking the whole document again. Falls back to the page root if the shell is ever absent.
function translateRenderedDashboard() {
  translatePage(document.querySelector("main.shell") || document.body);
}

function preferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") {
      return saved;
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
  return "light";
}

function updateThemeButtons() {
  const button = $("#themeToggle");
  if (!button) return;
  const isDark = state.theme === "dark";
  button.classList.toggle("active", isDark);
  button.setAttribute("aria-pressed", String(isDark));
  button.setAttribute("aria-label", isDark ? "当前深色主题，点击切换到浅色主题" : "当前浅色主题，点击切换到深色主题");
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

function setLanguage(locale) {
  state.locale = setLocale(locale);
  achievementDialog?.localize();
  achievementNotice?.localize();
  updateLanguageButton();
  updateThemeButtons();
  updateRecentControls();
  updateDateRangeControl();
  renderAutoRefreshControls();
  const errorText = $("#autoRefreshErrorText");
  errorText.value = localizeText(errorText.dataset.message || "", getLocale());
  if (state.datePickerField) renderDatePicker(state.datePickerField);
  if (!$("#pricingDialog")?.hidden) renderPricingModelList();
  if (!$("#pricingDialog")?.hidden) renderAutomaticPricingStatus(state.pricingCatalog?.automatic);
  render();
  // Whole-page on purpose: render() rewrites the dashboard subtree, but this path also re-renders
  // the pricing dialog (:161-162) and the import dialog's source list, which are siblings of
  // <main>. A language switch is a rare user action, so the extra walk is not a refresh cost.
  translatePage();
}

function setTheme(theme, { persist = true } = {}) {
  state.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  if (persist && !paletteStudioPreview) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }
  updateThemeButtons();
  state.skinRuntime?.handleThemeChange();
  render();
}

async function toggleTheme() {
  const button = $("#themeToggle");
  if (button.disabled) return;
  const root = document.documentElement;
  const theme = state.theme === "dark" ? "light" : "dark";
  button.disabled = true;
  root.dataset.themeTransition = "running";
  let overlay;
  try {
    if (document.startViewTransition) {
      await document.startViewTransition(() => setTheme(theme)).finished;
    } else {
      // Preserve the old canvas pixels as well as the old palette during the fade.
      overlay = document.createElement("div");
      const snapshot = root.cloneNode(true);
      snapshot.querySelectorAll("script").forEach((script) => {
        script.remove();
      });
      const colors = getComputedStyle(root);
      for (const property of colors) {
        if (property.startsWith("--")) snapshot.style.setProperty(property, colors.getPropertyValue(property));
      }
      snapshot.style.colorScheme = colors.colorScheme;
      const canvases = root.querySelectorAll("canvas");
      snapshot.querySelectorAll("canvas").forEach((canvas, index) => {
        canvas.getContext("2d")?.drawImage(canvases[index], 0, 0);
      });
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        pointerEvents: "none",
        overflow: "hidden",
        opacity: "0",
      });
      snapshot.style.width = `${root.clientWidth}px`;
      // A transform would move fixed character artwork to the bottom of the full document.
      Object.assign(snapshot.querySelector("body").style, {
        position: "relative",
        left: `${-window.scrollX}px`,
        top: `${-window.scrollY}px`,
      });
      overlay.inert = true;
      overlay.setAttribute("aria-hidden", "true");
      const stylesReady = Array.from(
        snapshot.querySelectorAll('link[rel="stylesheet"]'),
        (link) =>
          new Promise((resolve) => {
            link.onload = resolve;
            link.onerror = resolve;
          }),
      );
      overlay.attachShadow({ mode: "closed" }).append(snapshot);
      const frozenStyles = document.createElement("style");
      frozenStyles.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
      snapshot.append(frozenStyles);
      document.body.append(overlay);
      await Promise.all(stylesReady);
      overlay.style.opacity = "1";
      setTheme(theme);
      const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1000;
      await overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: "linear" }).finished;
    }
  } finally {
    overlay?.remove();
    delete root.dataset.themeTransition;
    button.disabled = false;
  }
}

function setMetric(selector, value) {
  const element = $(selector);
  if (!element) return;
  const formatted = formatTokens(value);
  element.textContent = formatted;
  element.title = formatted;
}

function setTokenMetric(selector, value) {
  const element = $(selector);
  if (!element) return;
  element.innerHTML = renderTokenMetricHtml(value);
  element.title = formatTokens(value);
}

function setCurrencyMetric(selector, usd, cny = null) {
  const element = $(selector);
  if (!element) return;
  const hasUsd = usd !== null && usd !== undefined && Number.isFinite(Number(usd));
  const hasCny = cny !== null && cny !== undefined && Number.isFinite(Number(cny));
  if (!hasUsd && !hasCny) {
    element.textContent = "—";
    element.title = "";
    return;
  }
  const usdValue = hasUsd ? Number(usd) : 0;
  const cnyValue = hasCny ? Number(cny) : 0;
  const total = scaledCost(usdValue, "USD") + scaledCost(cnyValue, "CNY");
  const formatted = formatCostAmount(total, state.costScaleTarget);
  element.innerHTML = escapeHtml(formatted).replace(
    /[$¥]/u,
    '<small class="metric-unit metric-unit-prefix">$&</small>',
  );
  element.title = formatted;
  // Keep monetary values at the same typographic scale as the token row.
  // Very long amounts retain the full value in their existing title tooltip.
  element.style.fontSize = "";
}

function formatCompact(value) {
  return compactFormatter.format(Math.round(value || 0));
}

function usageTooltip() {
  return $("#usageTooltip");
}

// Body last published to a tooltip node, kept next to the value the node reported right after the
// write (innerHTML is re-serialized, so the markup that was written is not always what the DOM
// returns). A skip only happens while the node still reports that exact value, so an external
// change to the tooltip invalidates the shortcut and the body is re-asserted on the next hit.
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

function timelineAccessibleLabel(row, mode, range = null) {
  if (!["channel", "model", "cost"].includes(mode)) throw new TypeError(`unsupported timeline mode: ${mode}`);
  const quotaInfo = quotaTimelineSlotInfo(row);
  const english = getLocale() === "en-US";
  const key = quotaInfo
    ? [quotaInfo.title, quotaInfo.note].filter(Boolean).join(english ? ". " : "，")
    : timelineSlotRangeTitle(row, range) || String(row?.key || row?.name || localizeText("未知时间"));
  if (mode === "cost") {
    const amount =
      Number(row?.pricedTokens || 0) > 0
        ? formatCostAmount(timelineValue(row, "cost"), state.costScaleTarget)
        : localizeText("无可计价费用");
    const unpriced = Number(row?.unpricedTokens || 0) > 0 ? formatTokenMillions(row.unpricedTokens) : null;
    if (english) return `${key}. Estimated cost ${amount}${unpriced ? `; ${unpriced} unpriced tokens` : ""}.`;
    return `${key}，费用估算 ${amount}${unpriced ? `，未计价 ${unpriced} tokens` : ""}`;
  }
  const details = mode === "model" ? row?.models || [] : row?.channels || [];
  const kind = mode === "model" ? "模型" : "渠道";
  const breakdown = details
    .map((item) => `${item.name} ${formatTokenMillions(usageValue(item.total, "total"))} tokens`)
    .join(english ? ", " : "，");
  if (english)
    return `${key}. Total ${formatTokenMillions(usageValue(row?.total, "total"))} tokens${breakdown ? `; ${mode === "model" ? "models" : "sources"}: ${breakdown}` : ""}.`;
  return `${key}，总计 ${formatTokenMillions(usageValue(row?.total, "total"))} tokens${breakdown ? `，${kind}：${breakdown}` : ""}`;
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

function bindUsageRows(container, selector, rows, options = null) {
  container.querySelectorAll(selector).forEach((element, index) => {
    tooltipRows.set(element, { row: rows[index], options });
  });
}

const CATEGORY_PALETTES = {
  light: [
    "#2563eb",
    "#c2410c",
    "#7c3aed",
    "#0f766e",
    "#be185d",
    "#4d7c0f",
    "#6b7280",
    "#b91c1c",
    "#0e7490",
    "#4338ca",
    "#15803d",
    "#9f1239",
  ],
  dark: [
    "#60a5fa",
    "#fb923c",
    "#c084fc",
    "#2dd4bf",
    "#f472b6",
    "#a3e635",
    "#cbd5e1",
    "#f87171",
    "#22d3ee",
    "#818cf8",
    "#4ade80",
    "#fda4af",
  ],
};

const MODEL_COLOR_ORDER = [
  "gpt-5.6-luna",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-6-sol",
  "gpt-6-astra",
  "codex-auto-review",
  "Unknown model",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.6",
  "gpt-daybreak-blue-latest",
];
const MODEL_COLOR_SLOTS = new Map(MODEL_COLOR_ORDER.map((name, index) => [name, index]));
const LIGHT_CATEGORY_OVERFLOW_LIGHTNESS = 29;

function categoryColorHex(hue, lightness) {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * (lightness / 100) - 1)) * 0.7;
  const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const match = lightness / 100 - chroma / 2;
  const rgb =
    normalizedHue < 60
      ? [chroma, x, 0]
      : normalizedHue < 120
        ? [x, chroma, 0]
        : normalizedHue < 180
          ? [0, chroma, x]
          : normalizedHue < 240
            ? [0, x, chroma]
            : normalizedHue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return `#${rgb
    .map((channel) =>
      Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function categoryColor(index, dark) {
  const palette = dark ? CATEGORY_PALETTES.dark : CATEGORY_PALETTES.light;
  if (index < palette.length) return palette[index];
  const hue = ((index - palette.length) * 137.508 + 17) % 360;
  return dark ? `hsl(${hue} 70% 64%)` : categoryColorHex(hue, LIGHT_CATEGORY_OVERFLOW_LIGHTNESS);
}

function categoricalColors(rows = []) {
  const dark = document.documentElement.dataset?.theme === "dark";
  const totals = new Map();
  for (const row of rows) totals.set(row.name, Math.max(totals.get(row.name) || 0, usageValue(row.total, "total")));
  const names = [...totals.keys()].sort(
    (left, right) => totals.get(right) - totals.get(left) || left.localeCompare(right),
  );
  return new Map(names.map((name, index) => [name, categoryColor(index, dark)]));
}

export function getChannelColors(rows) {
  return categoricalColors(rows);
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

export function nextPresetState(currentState = {}, preset = "today") {
  return nextSharedPresetState(currentState, preset, state.preset);
}

function renderCostMetrics(summary) {
  const estimate = summary.costEstimate;
  const note = $("#costEstimateNote");
  if (!estimate) {
    for (const selector of ["#totalCost", "#inputCost", "#cachedInputCost", "#outputCost", "#priceModelCount"]) {
      $(selector).textContent = "—";
      $(selector).removeAttribute("title");
    }
    note.textContent = "费用估算暂不可用。";
    note.title = "";
    return;
  }

  setCurrencyMetric("#totalCost", estimate.totalUsd, estimate.totalCny);
  setCurrencyMetric("#inputCost", estimate.inputUsd, estimate.inputCny);
  setCurrencyMetric("#cachedInputCost", estimate.cachedInputUsd, estimate.cachedInputCny);
  setCurrencyMetric("#outputCost", estimate.outputUsd, estimate.outputCny);
  setMetric("#priceModelCount", estimate.modelCount);

  const checkedAt = estimate.priceCheckedAt ? `价格基准 ${estimate.priceCheckedAt}` : "当前价格基准";
  const totalTokens = formatTokens(summary.totals.total);
  const caveats = [];
  caveats.push(...pricingScenarioNotes(estimate.unpricedReasons));
  if (estimate.serviceTierUnknownRecords > 0)
    caveats.push(`${formatTokens(estimate.serviceTierUnknownRecords)} 条记录的服务等级未知，按 Standard 情景估算`);
  if (estimate.contextUnknownRecords > 0)
    caveats.push(
      `${formatTokens(estimate.contextUnknownRecords)} 条记录无法可靠对应单次请求输入，按可用的较低上下文费率估算`,
    );
  if (estimate.cacheWriteUnknownRecords > 0)
    caveats.push(
      `${formatTokens(estimate.cacheWriteUnknownTokens)} 个输入 tokens 缺少缓存写入明细，相关未知部分按最低费率估算`,
    );
  if (estimate.minimumEstimatedTokens > 0)
    caveats.push(`${formatTokens(estimate.minimumEstimatedTokens)} / ${totalTokens} tokens 使用最低费率估算`);
  if (estimate.minimumRateModels?.length)
    caveats.push(
      `模型 ${estimate.minimumRateModels.map((name) => displayModelName(name)).join("、")} 缺少专用单价，按价目表最低费率估算`,
    );
  if (estimate.unpricedTokens > 0) caveats.push(`仍有 ${formatTokens(estimate.unpricedTokens)} tokens 无法估算`);
  const sourceLinks = renderPricingSourceLinksHtml(
    estimate.priceSources?.length ? estimate.priceSources : [estimate.priceSource],
    estimate.currencies || [],
  );
  note.innerHTML = `
    <p>按当前价目表估算 · ${escapeHtml(checkedAt)} · ${sourceLinks || "默认价格来源"}</p>
    <p>金额按已知明细及最低费率情景折算 API 等价费用，不代表实际账单，也不含工具调用等非 token 费用。</p>
    ${
      caveats.length
        ? `<ul aria-label="估算限制">${caveats.map((caveat) => `<li>${escapeHtml(caveat)}。</li>`).join("")}</ul>`
        : "<p>缓存读取与写入按各自官方费率计入总额。</p>"
    }
  `;
  note.title = estimate.unpricedModels?.length
    ? `仍无法计价的模型：${estimate.unpricedModels.map((name) => displayModelName(name)).join("、")}`
    : "更新计价标准后，所有已索引的历史用量会按新单价重算。";
}

const PRICING_SOURCE_LABELS = Object.freeze({
  "platform.claude.com": "Anthropic 定价",
  "docs.anthropic.com": "Anthropic 定价",
  "claude.com": "Anthropic 定价",
  "developers.openai.com": "OpenAI 价格表",
  "stepfun.com": "StepFun 定价",
  "mimo.mi.com": "MiMo 定价",
  "deepseek.com": "DeepSeek 定价",
  "kimi.com": "Kimi 定价",
  "bigmodel.cn": "GLM 定价",
});

export function renderPricingSourceLinksHtml(values = [], currencies = []) {
  const sources = new Map();
  for (const value of values) {
    const url = externalHttpUrl(value);
    if (!url || (!currencies.includes("USD") && url.hostname === "developers.openai.com")) continue;
    sources.set(url.href, url);
  }
  return [...sources.values()]
    .map((url) => {
      const label = Object.hasOwn(PRICING_SOURCE_LABELS, url.hostname)
        ? PRICING_SOURCE_LABELS[url.hostname]
        : url.hostname;
      return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    })
    .join("、");
}

export function pricingScenarioNotes(reasons = [], locale = getLocale()) {
  const english = locale === "en-US";
  const notes = {
    "aggregate-usage-coverage-unknown": english
      ? "Aggregated usage may not include every provider-reported detail"
      : "聚合用量的提供方明细可能不完整",
    "request-output-unknown-minimum-scenario": english
      ? "Per-request output length is unknown; the estimate uses the lowest applicable rate"
      : "单次请求输出长度未知，按适用的最低费率估算",
    "request-time-unknown-minimum-scenario": english
      ? "Request times are unknown; the estimate uses the lowest applicable time-based rate"
      : "请求时间未知，按适用时段的最低费率估算",
    "cache-write-ttl-unknown-5m-scenario": english
      ? "Claude cache-write TTL is unknown; the estimate uses 5-minute pricing"
      : "Claude 缓存写入 TTL 未确认，按 5 分钟价格场景估算",
    "cache-write-ttl-unsupported": english
      ? "Known non-5-minute cache writes are unpriced; configure the matching TTL rates before estimating them"
      : "已知非 5 分钟缓存写入暂未计价，需匹配相应 TTL 费率",
    "fast-pricing-unavailable-standard-scenario": english
      ? "This Claude model has no supported Fast price; the estimate uses Standard pricing"
      : "该 Claude 模型没有已支持的 Fast 价目，按 Standard 场景估算",
    "legacy-context-pricing-unverified-standard-scenario": english
      ? "Legacy Claude usage exceeds the verified standard context range; the estimate uses base pricing"
      : "旧版 Claude 用量超过已核验的标准上下文范围，按基础价格场景估算",
  };
  return Object.keys(notes)
    .filter((reason) => reasons.includes(reason))
    .map((reason) => notes[reason]);
}

// New Record：所选范围内的纪录期点亮对应指标卡右上角的 New 小字。
const RECORD_CARD_METRICS = Object.freeze({
  totalTokens: "#totalTokens",
  inputTokens: "#inputTokens",
  cachedTokens: "#cachedTokens",
  outputTokens: "#outputTokens",
  reasoningTokens: "#reasoningTokens",
  sessionCount: "#sessionCount",
  totalCost: "#totalCost",
  inputCost: "#inputCost",
  cachedCost: "#cachedInputCost",
  outputCost: "#outputCost",
  cacheHitRate: "#cacheHitRate",
  modelCount: "#priceModelCount",
});

function renderRecordBadges(records = {}) {
  const englishRecordNames = {
    totalTokens: "Total tokens",
    inputTokens: "Input tokens",
    cachedTokens: "Cache hit tokens",
    outputTokens: "Output tokens",
    reasoningTokens: "Reasoning tokens",
    sessionCount: "Sessions",
    totalCost: "Estimated cost",
    inputCost: "Cache miss cost",
    cachedCost: "Cache hit cost",
    outputCost: "Output cost",
    cacheHitRate: "Cache hit rate",
    modelCount: "Model count",
  };
  for (const [metric, selector] of Object.entries(RECORD_CARD_METRICS)) {
    const valueNode = $(selector);
    const card = valueNode?.closest(".metric");
    const badge = card?.querySelector(".metric-new");
    if (!badge) continue;
    const record = state.preset === "all" ? null : records?.[metric];
    badge.hidden = !record;
    badge.textContent = "";
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", getLocale() === "en-US" ? "New record" : "新纪录");
    const comparisonCount = record?.comparedWindowCount;
    card.title = record
      ? getLocale() === "en-US"
        ? `Highest ${englishRecordNames[metric]?.toLowerCase() || "usage"} in a ${record.unit || "period"}: ${record.period}${comparisonCount ? ` (compared with ${comparisonCount} earlier observed windows)` : ""}`
        : `${record.title}：${record.period}${comparisonCount ? `（对比此前 ${comparisonCount} 个已观测窗口）` : ""}`
      : "";
  }
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
  setMetric("#sessionCount", summary.sessionCount);
  renderCostMetrics(summary);
  renderRecordBadges(summary.records);
}

function renderBarList(container, rows, colorMap = null, options = null) {
  container.innerHTML = renderBarListHtml(rows, colorMap, options || undefined);
  bindUsageRows(container, ".bar-row", rows, options);
}

function timelineBreakdownReady(rows, mode) {
  if (mode === "channel") return true;
  const activeRows = rows.filter((row) => usageValue(row?.total, "total") > 0);
  if (mode === "model") {
    return activeRows.every(
      (row) =>
        Array.isArray(row.models) &&
        Math.abs(
          row.models.reduce((sum, model) => sum + usageValue(model.total, "total"), 0) - usageValue(row.total, "total"),
        ) < 1e-6,
    );
  }
  return activeRows.every((row) => {
    const costs = row.costByModel;
    if (!costs || typeof costs !== "object" || Array.isArray(costs)) return false;
    if (!Number.isFinite(Number(row.pricedTokens)) || !Number.isFinite(Number(row.unpricedTokens))) return false;
    const pricedTokens = Object.values(costs).reduce((sum, cost) => sum + Number(cost.pricedTokens || 0), 0);
    const unpricedTokens = Object.values(costs).reduce((sum, cost) => sum + Number(cost.unpricedTokens || 0), 0);
    return (
      Math.abs(pricedTokens - Number(row.pricedTokens)) < 1e-6 &&
      Math.abs(unpricedTokens - Number(row.unpricedTokens)) < 1e-6
    );
  });
}

export function timelineDetailRows(summary, mode) {
  if (summary.timelineError) return [];
  if (mode === "channel") return summary.channels || [];
  if (mode === "model") return summary.models || [];
  const byModel = new Map();
  for (const slot of summary.timeline || []) {
    for (const { name, value } of timelineCostSegments(slot)) {
      byModel.set(name, (byModel.get(name) || 0) + value);
    }
  }
  return [...byModel]
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

export function renderCostDetailHtml(rows, colorMap = null) {
  if (!rows.length) return '<div class="empty">没有可计价的费用记录</div>';
  const max = rows[0].value || 1;
  return rows
    .map((row) => {
      const name = escapeHtml(displayModelName(row.name));
      const amount = formatCostAmount(row.value, state.costScaleTarget);
      const color = safeChartColor(colorMap?.get(row.name) || getModelColor(row.name));
      const width = Math.max(2, (row.value / max) * 100);
      return `
      <div class="bar-row" tabindex="0" aria-label="${name}，费用估算 ${amount}">
        <div class="bar-label">
          <span class="bar-name" title="${name}">${name}</span>
          <span class="bar-value" title="${amount}">${amount}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width: ${width}%; background: ${color};"></div></div>
      </div>
    `;
    })
    .join("");
}

let highlightedSeries = null;

function renderTimelineDetails(summary, channelColors, modelColors) {
  const mode = state.timelineMode;
  const label = { channel: "按渠道", model: "按模型", cost: "按花销" }[mode] || "按渠道";
  $("#detailModeLabel").textContent = label;
  const container = $("#detailList");
  if (summary.timelineError) {
    container.innerHTML = '<div class="empty">时间范围过大，无法生成时间分布。</div>';
    return;
  }
  if (!timelineBreakdownReady(summary.timeline || [], mode)) {
    container.innerHTML = `<div class="empty">${mode === "model" ? "模型" : "费用"}明细不可用，请刷新数据。</div>`;
    return;
  }
  const rows = timelineDetailRows(summary, mode);
  if (mode === "cost") {
    container.innerHTML = renderCostDetailHtml(rows, modelColors);
  } else {
    renderBarList(
      container,
      rows,
      mode === "model" ? modelColors : channelColors,
      mode === "model" ? { modelNames: true } : null,
    );
  }
  if (highlightedSeries !== null) {
    container.querySelectorAll(".bar-row").forEach((element, index) => {
      element.classList.toggle("series-muted", rows[index].name !== highlightedSeries);
    });
  }
}

// Last table published per kind. The table markup is a pure function of the filtered rows and
// the render options, so an equal signature means the DOM already holds exactly that markup and
// neither rebuilding the string nor re-parsing it as innerHTML can change anything.
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

// 周/月槽直接显示实际覆盖日期，首尾按所选范围裁剪。

export function renderComparisonHtml(comparison, range = null) {
  return renderSharedComparisonHtml(comparison, range, state.preset);
}

function renderComparison(summary) {
  const container = $("#comparisonSummary");
  if (!container) return;
  container.hidden = false;
  container.innerHTML = renderComparisonHtml(summary?.comparison, summary?.range);
}

function getModelColor(name) {
  const dark = document.documentElement.dataset?.theme === "dark";
  const fixedSlot = MODEL_COLOR_SLOTS.get(name);
  if (fixedSlot !== undefined) return categoryColor(fixedSlot, dark);
  let hash = 2166136261;
  for (const character of String(name)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  return dark ? `hsl(${hue} 70% 64%)` : categoryColorHex(hue, LIGHT_CATEGORY_OVERFLOW_LIGHTNESS);
}

export function getModelColors(rows = []) {
  const dark = document.documentElement.dataset?.theme === "dark";
  const names = [...new Set(rows.map((row) => row.name))];
  const extraNames = names
    .filter((name) => !MODEL_COLOR_SLOTS.has(name))
    .sort((left, right) => left.localeCompare(right));
  const extraSlots = new Map(extraNames.map((name, index) => [name, MODEL_COLOR_ORDER.length + index]));
  return new Map(names.map((name) => [name, categoryColor(MODEL_COLOR_SLOTS.get(name) ?? extraSlots.get(name), dark)]));
}

function timelineCostSegments(row, modelRows = []) {
  const costByModel = row?.costByModel || {};
  const orderedNames = [];
  const valuesByName = new Map();
  for (const model of modelRows) {
    if (!orderedNames.includes(model.name)) orderedNames.push(model.name);
  }
  for (const [key, cost] of Object.entries(costByModel)) {
    const name = costBucketModelName(key, cost);
    if (!orderedNames.includes(name)) orderedNames.push(name);
    const value = scaledCost(cost.totalUsd, cost.currency);
    if (Number.isFinite(value) && value > 0) valuesByName.set(name, (valuesByName.get(name) || 0) + value);
  }
  return orderedNames.filter((name) => valuesByName.has(name)).map((name) => ({ name, value: valuesByName.get(name) }));
}

function timelineValue(row, mode) {
  if (mode === "cost") {
    return Object.values(row?.costByModel || {}).reduce(
      (total, cost) => total + scaledCost(cost.totalUsd, cost.currency),
      0,
    );
  }
  return usageValue(row?.total, "total");
}

const preciseUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const preciseCnyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// 金额符号随模型标价货币切换：美元模型显示 $，人民币模型显示 ¥。
export function formatCostAmount(value, currency = "USD") {
  const amount = Number(value || 0);
  const safe = Number.isFinite(amount) ? amount : 0;
  return currency === "CNY" ? cnyFormatter.format(safe) : usdFormatter.format(safe);
}

function formatPreciseCost(value, currency = "USD") {
  const amount = Number(value || 0);
  const safe = Number.isFinite(amount) ? amount : 0;
  return currency === "CNY" ? preciseCnyFormatter.format(safe) : preciseUsdFormatter.format(safe);
}

// 混合币种并列展示（如 $1.23 + ¥4.56）；某币种没有计价记录时用 null 表示。
export function formatCostPair(usd, cny) {
  const parts = [];
  const usdValue = Number(usd);
  const cnyValue = Number(cny);
  if (usd !== null && usd !== undefined && Number.isFinite(usdValue)) parts.push(formatPreciseCost(usdValue, "USD"));
  if (cny !== null && cny !== undefined && Number.isFinite(cnyValue)) parts.push(formatPreciseCost(cnyValue, "CNY"));
  return parts.length ? parts.join(" + ") : "—";
}

export function costPairFromSlots(costByModel = {}) {
  let usd = 0;
  let cny = 0;
  let hasUsd = false;
  let hasCny = false;
  for (const cost of Object.values(costByModel || {})) {
    const amount = Number(cost?.totalUsd || 0);
    if (!(amount > 0)) continue;
    if (cost?.currency === "CNY") {
      cny += amount;
      hasCny = true;
    } else {
      usd += amount;
      hasUsd = true;
    }
  }
  return { usd: hasUsd ? usd : null, cny: hasCny ? cny : null };
}

function costBucketModelName(key, cost) {
  return String(cost?.model || key);
}

// 原币种金额只在展示时折算，保留完整精度用于汇总与图表比例。
export function costScaleValue(amount, currency, rate, targetCurrency) {
  const value = Number(amount || 0);
  const safeRate = Number(rate) > 0 ? Number(rate) : 1;
  const target = targetCurrency === "CNY" ? "CNY" : "USD";
  if ((currency === "CNY") === (target === "CNY")) return value;
  return currency === "CNY" ? value / safeRate : value * safeRate;
}

function scaledCost(amount, currency) {
  return costScaleValue(amount, currency, state.usdToCnyRate, state.costScaleTarget);
}

export function formatTimelineTooltip(row, mode = "channel", range = null) {
  const quotaInfo = quotaTimelineSlotInfo(row);
  const quotaNote = quotaInfo?.note ? `<div class="usage-tooltip-note">${escapeHtml(quotaInfo.note)}</div>` : "";
  const slotTitle = quotaInfo?.title || timelineSlotRangeTitle(row, range);
  if (mode === "channel") return `${formatUsageTooltip(row, slotTitle, { compactTokens: true })}${quotaNote}`;
  const title = escapeHtml(slotTitle || row?.name || row?.key || "未知时间");
  if (mode === "model") {
    const models = [...(row?.models || [])]
      .sort(
        (left, right) =>
          usageValue(left.total, "total") - usageValue(right.total, "total") || left.name.localeCompare(right.name),
      )
      .map(
        (model) =>
          `<span class="usage-tooltip-label">${escapeHtml(displayModelName(model.name))}</span><span class="usage-tooltip-value">${formatTokenMillions(usageValue(model.total, "total"))}</span>`,
      )
      .join("");
    return `<div class="usage-tooltip-title">${title}</div>${quotaNote}<div class="usage-tooltip-grid"><span class="usage-tooltip-label">总 tokens</span><span class="usage-tooltip-value">${formatTokenMillions(usageValue(row?.total, "total"))}</span></div><div class="usage-tooltip-subtitle">模型</div><div class="usage-tooltip-grid">${models || `<span class="usage-tooltip-label">无模型用量</span>`}</div>`;
  }
  const costs = timelineCostSegments(row)
    .sort((left, right) => left.value - right.value || left.name.localeCompare(right.name))
    .map(({ name, value }) => {
      const amount = formatCostAmount(value, state.costScaleTarget);
      return `<span class="usage-tooltip-label">${escapeHtml(displayModelName(name))}</span><span class="usage-tooltip-value">${amount}</span>`;
    })
    .join("");
  const amountLabel =
    Number(row?.pricedTokens || 0) > 0
      ? formatCostAmount(timelineValue(row, "cost"), state.costScaleTarget)
      : "无可计价费用";
  const unpriced =
    Number(row?.unpricedTokens || 0) > 0
      ? `<span class="usage-tooltip-label">未计价 tokens</span><span class="usage-tooltip-value">${formatTokenMillions(row.unpricedTokens)}</span>`
      : "";
  return `<div class="usage-tooltip-title">${title}</div>${quotaNote}<div class="usage-tooltip-grid"><span class="usage-tooltip-label">估算金额</span><span class="usage-tooltip-value">${amountLabel}</span><span class="usage-tooltip-label">已计价 tokens</span><span class="usage-tooltip-value">${formatTokenMillions(row?.pricedTokens || 0)}</span>${unpriced}</div>${costs ? `<div class="usage-tooltip-subtitle">按模型</div><div class="usage-tooltip-grid">${costs}</div>` : ""}`;
}

function updateTimelineModeButtons() {
  for (const button of document.querySelectorAll("[data-timeline-mode]")) {
    const selected = button.dataset.timelineMode === state.timelineMode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  motionGlass?.select(state.timelineMode);
}

export function renderTimelineLegendHtml(summary, mode, channelColors, modelColors) {
  if (!["channel", "model", "cost"].includes(mode)) throw new TypeError(`unsupported timeline mode: ${mode}`);
  if (summary.timelineError) return "";
  const isChannel = mode === "channel";
  const isCost = mode === "cost";
  const totalsByName = new Map();
  for (const slot of summary.timeline || []) {
    let segments;
    if (isChannel) {
      segments = slot.channels || [];
    } else if (isCost) {
      segments = Object.entries(slot.costByModel || {}).map(([key, cost]) => ({
        name: costBucketModelName(key, cost),
        value: scaledCost(cost.totalUsd, cost.currency),
      }));
    } else {
      segments = slot.models || [];
    }
    for (const segment of segments) {
      const value = isCost ? Number(segment.value || 0) : usageValue(segment.total, "total");
      if (!(value > 0)) continue;
      totalsByName.set(segment.name, (totalsByName.get(segment.name) || 0) + value);
    }
  }
  const ordered = [...totalsByName.keys()].sort((a, b) => a.localeCompare(b));
  const colorFor = (name) =>
    isChannel ? channelColors.get(name) || "var(--green)" : modelColors.get(name) || getModelColor(name);
  return ordered
    .map((name) => {
      const color = safeChartColor(colorFor(name));
      const escapedName = escapeHtml(isChannel ? name : displayModelName(name));
      return `<span role="listitem"><button type="button" class="timeline-legend-item" data-series="${escapeHtml(name)}" aria-pressed="false"><span class="timeline-legend-swatch" aria-hidden="true" style="background:${color}"></span><span title="${escapedName}">${escapedName}</span></button></span>`;
    })
    .join("");
}

function renderTimelineLegend(summary, channelColors, modelColors) {
  const container = $("#timelineLegend");
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.series : null;
  container.innerHTML = renderTimelineLegendHtml(summary, state.timelineMode, channelColors, modelColors);
  const buttons = [...container.querySelectorAll("button[data-series]")];
  const selected = buttons.find((button) => button.dataset.series === highlightedSeries);
  if (selected) selected.setAttribute("aria-pressed", "true");
  else highlightedSeries = null;
  if (focused) buttons.find((button) => button.dataset.series === focused)?.focus({ preventScroll: true });
}

function renderTimelinePanels(summary) {
  const channelColors = getChannelColors(summary.channels);
  const allPeriodModels = state.periodComparison?.models || [];
  const modelColors = getModelColors([...allPeriodModels, ...summary.models]);
  renderTimelineLegend(summary, channelColors, modelColors);
  renderTimelineDetails(summary, channelColors, modelColors);
  drawTimeline(
    $("#timelineChart"),
    summary.timeline,
    summary.channels,
    channelColors,
    summary.range,
    state.timelineMode,
    summary.models,
    modelColors,
    highlightedSeries,
  );
}

export function maxTimelineValue(values) {
  return values.reduce((maximum, value) => Math.max(maximum, value), 0);
}

// 时间轴刻度文字：12px、-22.5° 旋转，水平占位 ≈ 文字宽×cos(22.5°) + 字号×sin(22.5°)，另留 4px 呼吸空隙。

export function drawTimeline(
  canvas,
  rows,
  channelRows = [],
  channelColors = new Map(),
  range = null,
  mode = state.timelineMode,
  modelRows = [],
  modelColorsByName = getModelColors(modelRows),
  focusedSeries = null,
) {
  if (!["channel", "model", "cost"].includes(mode)) throw new TypeError(`unsupported timeline mode: ${mode}`);
  const startLabel = range?.start ? dateKey(asDate(range.start), rangeCalendarZone(range)) : "";
  const endLabel = range?.end ? dateKey(asDate(range.end), rangeCalendarZone(range)) : "";
  const rangeLabelText = startLabel && endLabel ? `，统计范围 ${startLabel} 至 ${endLabel}` : "";
  const costAria =
    getLocale() === "en-US"
      ? `Usage over time, estimated API-equivalent cost by model, with ${state.costScaleTarget} on the vertical axis${startLabel && endLabel ? `, from ${startLabel} to ${endLabel}` : ""}. Inspect each interval for dates and model costs.`
      : `时间分布，按模型堆叠 API 等价费用估算，${state.costScaleTarget === "CNY" ? "人民币" : "美元"}为纵轴单位${rangeLabelText}；每个时间槽可查看完整日期和模型费用`;
  const styles = getComputedStyle(document.documentElement);
  const unavailableQuota = isQuotaPreset(range?.preset) && range?.quotaState !== "available";
  const messages = {
    aria: localizeText(mode === "cost" ? costAria : timelineTokenAriaLabel(range, mode)),
    empty: localizeText(unavailableQuota ? range?.quotaReason || QUOTA_UI_COPY.waiting : "没有匹配的用量记录"),
    emptyAria: unavailableQuota,
    unavailable:
      rows.length && !timelineBreakdownReady(rows, mode)
        ? localizeText(`${mode === "model" ? "模型" : "费用"}明细不可用，请重启服务`)
        : null,
  };
  const tokenSeries = () =>
    tokenTimelineSeries(mode, {
      channelRows,
      channelColors,
      modelRows,
      modelColorsByName,
      modelColor: getModelColor,
      channelColor: styles.getPropertyValue("--green").trim() || "#2f855a",
      formatAxis: formatCompact,
    });
  return drawTimelineCanvas(canvas, rows, {
    styles,
    palette: { line: "#d9e0e6", text: "#607080", fallback: "#2364aa" },
    outline: { roleId: "chart.axis-line", lineWidth: 1 },
    ratio: window.devicePixelRatio || 1,
    range,
    focusedSeries,
    bucket: range?.bucket || state.bucket,
    series:
      mode === "cost"
        ? {
            value: (row) => timelineValue(row, mode),
            segments: (row) =>
              timelineCostSegments(row, modelRows).map((segment) => ({
                ...segment,
                color: modelColorsByName.get(segment.name) || getModelColor(segment.name),
              })),
            sortStacks: true,
            fallbackBar: false,
            formatAxis: (value) => formatPreciseCost(value, state.costScaleTarget),
          }
        : tokenSeries(),
    messages,
    timelineBars,
    drawnChartBox,
  });
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

// harness 归组顺序。Codex 优先，便于 gpt 系模型归到最相关一侧。
export const HARNESS_ORDER = ["Codex", "ZCode", "DSH", "OpenCode", "Claude", "WorkBuddy", "Hermes"];

function currentSummary() {
  return state.summary;
}

let shareSummary = null;
let sharePricingModels = null;
let shareAchievementReceipt = null;
let openingShare = false;

function updateShareAvailability() {
  const button = $("#shareToggle");
  if (button)
    button.disabled = !shareSummary || shareSummary !== state.summary || !canShareSummary(shareSummary, state);
}

async function openShareImageDialog() {
  if (openingShare || $("#shareToggle").disabled) return;
  openingShare = true;
  try {
    // Keep the clicked dashboard response even if a refresh finishes during lazy loading.
    const snapshot = {
      summary: shareSummary,
      preset: state.preset,
      recentValue: state.recentValue,
      startDate: state.startDate,
      endDate: state.endDate,

      currency: state.costScaleTarget,
      usdToCnyRate: state.usdToCnyRate,
      periodComparison: state.periodComparison,
      pricingModels: sharePricingModels,
      achievementReceipt: shareAchievementReceipt,
      locale: getLocale(),
      theme: state.theme,
    };
    const preference = state.skinRuntime?.getPreference();
    const { openShareDialog } = await import("./share-dialog.js");
    const skins = preference ? await import("./skins.js") : null;
    const { theme } = snapshot;
    const characterFor = (view) => {
      const url = preference?.showCharacters && skins?.skinAssetUrl(preference.skinId, theme, view);
      return url ? { url, displayParams: skins.skinDisplayParams(preference.skinId, theme, view) } : null;
    };
    openShareDialog({
      ...snapshot,
      palette: skins?.paletteDeclarations(preference.skinId, theme) || [],
      character: characterFor("front"),
      landscapeCharacter: characterFor("side"),
    });
  } catch (error) {
    runtimeNotice(`加载失败：${error.message}`);
  } finally {
    openingShare = false;
  }
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
    "#sessionCount",
    "#totalCost",
    "#inputCost",
    "#cachedInputCost",
    "#outputCost",
    "#cacheHitRate",
    "#priceModelCount",
  ]) {
    const node = $(selector);
    if (node) {
      node.textContent = "—";
      node.title = "";
    }
  }
  for (const card of document.querySelectorAll(".metric")) {
    card.title = "";
    const badge = card.querySelector(".metric-new");
    if (badge) badge.hidden = true;
  }
  renderComparison({ comparison: null, range: unavailableRange });
  const warning = $("#timelineRangeWarning");
  if (warning) {
    warning.hidden = true;
    warning.textContent = "";
  }
  const legend = $("#timelineLegend");
  if (legend) legend.innerHTML = "";
  highlightedSeries = null;
  const detailList = $("#detailList");
  if (detailList) detailList.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  updateTimelineModeButtons();
  drawTimeline($("#timelineChart"), [], [], new Map(), unavailableRange, state.timelineMode);
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
  highlightedSeries = null;
  const details = $("#detailList");
  if (details) details.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  drawTimeline($("#timelineChart"), [], [], new Map(), state.emptySummaryRange, state.timelineMode);
}

function render() {
  updateShareAvailability();
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

const dashboardRuntime = createDashboardRuntime(
  {
    state,
    document: globalThis.document,
    window: globalThis.window,
    storage: typeof localStorage === "undefined" ? undefined : localStorage,
    now: () => Date.now(),
    fetch: (...args) => fetch(...args),
    intervalMs: AUTO_REFRESH_INTERVAL_MS,
    storageKey: AUTO_REFRESH_STORAGE_KEY,
    render: (...args) => render(...args),
    loadUsage: (...args) => loadUsage(...args),
    checkForUpdates: (...args) => checkForUpdates(...args),
    usageQuery: (...args) => usageQuery(...args),
    setAutoRefreshStatus: (...args) => setAutoRefreshStatus(...args),
    receiveRuntimeSnapshot: (...args) => receiveRuntimeSnapshot(...args),
    reconcileQuotaSourceSelection: (...args) => reconcileQuotaSourceSelection(...args),
    clearQuotaNotice: (...args) => clearQuotaNotice(...args),
    updateQuotaPresetButton: (...args) => updateQuotaPresetButton(...args),
    renderUnavailableQuota: (...args) => renderUnavailableQuota(...args),
    quotaWindowAvailability: (...args) => quotaWindowAvailability(...args),
    isQuotaPreset: (...args) => isQuotaPreset(...args),
    pollImportTask: (...args) => pollImportTask(...args),
  },
  {
    onLoadStart({ preserveView }) {
      if (!preserveView) shareSummary = null;
      updateShareAvailability();
    },
    onUsage(data) {
      shareSummary = data.summary;
      shareAchievementReceipt = data.achievementShareReceipt || null;
      refreshAchievements();
      if (document.documentElement.dataset.edition === "waifu" && !paletteStudioPreview)
        void import("./achievement-events.js").then((events) => events.retryAchievementOperations()).catch(() => {});
      sharePricingModels = data.pricingCatalog?.models || {};
      const costEstimate = data.summary?.costEstimate;
      if (Number(costEstimate?.usdToCnyRate) > 0) state.usdToCnyRate = Number(costEstimate.usdToCnyRate);
    },
    onError(_error, { preserveView }) {
      if (!preserveView) shareSummary = null;
      updateShareAvailability();
    },
    async afterUsage() {
      if (!$("#pricingDialog").hidden && state.pricingCatalog) {
        try {
          const response = await fetch(pricingActivityUrl());
          if (response.ok) {
            const latest = await response.json();
            state.pricingCatalog.usageCoverage = latest.usageCoverage;
            state.pricingCatalog.modelActivity = latest.modelActivity;
            state.pricingCatalog.automatic = latest.automatic;
            renderAutomaticPricingStatus(latest.automatic, latest.usageCoverage);
            renderPricingModelList();
          }
        } catch {}
      }
    },
    onStreamOpen() {
      refreshAchievements();
    },
    bindStream(source) {
      source.addEventListener?.("achievement-state", () => {
        if (state.usageEventsSource === source) refreshAchievements();
      });
    },
  },
);

function setAutoRefreshErrorDetails(...args) {
  return dashboardRuntime.setAutoRefreshErrorDetails(...args);
}

function setAutoRefreshStatus(...args) {
  return dashboardRuntime.setAutoRefreshStatus(...args);
}

function beginRuntimeTask(kind, options = {}) {
  return dashboardRuntime.beginRuntimeTask(
    kind,
    kind === "pricing"
      ? {
          ...options,
          priority: options.priority ?? (options.user ? 0 : 3),
          labels: { pricing: "正在更新价格…" },
        }
      : options,
  );
}

function updateRuntimeTask(...args) {
  return dashboardRuntime.updateRuntimeTask(...args);
}

function finishRuntimeTask(...args) {
  return dashboardRuntime.finishRuntimeTask(...args);
}

function runtimeNotice(...args) {
  return dashboardRuntime.runtimeNotice(...args);
}

function runtimeRequestHeaders(...args) {
  return dashboardRuntime.runtimeRequestHeaders(...args);
}

function receiveRuntimeSnapshot(snapshot, reset = false) {
  const present = (task) =>
    task?.kind === "pricing" ? { ...task, priority: task.priority ?? 3, labels: { pricing: "正在更新价格…" } } : task;
  return dashboardRuntime.receiveRuntimeSnapshot(
    snapshot && Array.isArray(snapshot.tasks) && Array.isArray(snapshot.errors)
      ? { ...snapshot, tasks: snapshot.tasks.map(present), errors: snapshot.errors.map(present) }
      : snapshot,
    reset,
  );
}

function renderAutoRefreshControls(...args) {
  return dashboardRuntime.renderAutoRefreshControls(...args);
}

function renderRelativeCheckTime(...args) {
  return dashboardRuntime.renderRelativeCheckTime(...args);
}

export function formatAutoRefreshTimestamp(...args) {
  return dashboardRuntime.formatAutoRefreshTimestamp(...args);
}

function setAutoRefreshEnabled(...args) {
  return dashboardRuntime.setAutoRefreshEnabled(...args);
}

function initializeAutoRefresh(...args) {
  return dashboardRuntime.initializeAutoRefresh(...args);
}

const PRICING_FIELDS = [
  ["input", "缓外输入"],
  ["cachedInput", "缓存输入"],
  ["cacheWrite", "缓存写入"],
  ["output", "输出"],
];

function setPricingMessage(message, isError = false) {
  const element = $("#pricingMessage");
  element.textContent = localizeText(message);
  element.classList.toggle("error", isError);
}

export function automaticPricingStatusText(status = {}, locale = "zh-CN", fallbackTotal = 0) {
  const english = locale === "en-US";
  const updatedAt = status.priceUpdatedAt ? new Date(status.priceUpdatedAt) : null;
  const price = updatedAt && Number.isFinite(updatedAt.getTime()) ? dateKey(updatedAt) : null;
  const matched = status.automaticModelCount ?? 0;
  const total = status.totalModelCount ?? fallbackTotal;
  const partial = status.partialAutomaticModelCount ?? 0;
  const sourceCoverage = status.priceSourceCoverage || {};
  const usdSourceMapped = sourceCoverage.supportedUsdModelCount ?? sourceCoverage.supportedModelCount ?? 0;
  const cnySourceMapped = sourceCoverage.supportedCnyModelCount ?? 0;
  const unsupportedCurrency = sourceCoverage.unsupportedCurrencyModelCount ?? 0;
  const manualModels = status.manualModelCount ?? status.manualModels?.length ?? 0;
  const numberLocale = english ? "en-US" : "zh-CN";
  const formatRate = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
      ? new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 4 }).format(number)
      : null;
  };
  const automaticRate = formatRate(status.automaticUsdToCnyRate);
  const effectiveRate = formatRate(status.effectiveUsdToCnyRate);
  const exchangeRate = english
    ? `${status.manualExchangeRate ? `auto ${automaticRate || "built-in"} · current ${effectiveRate || "built-in"} (manual)` : `current ${effectiveRate || automaticRate || "built-in"}`} · quote date ${status.exchangeRateDate || "built-in"}`
    : `${status.manualExchangeRate ? `自动 ${automaticRate || "内置"} · 当前 ${effectiveRate || "内置"}（手动）` : `当前 ${effectiveRate || automaticRate || "内置"}`} · 报价日期 ${status.exchangeRateDate || "内置"}`;
  return english
    ? `Model prices: ${price || "built-in"} (auto-maintained ${matched}/${total}, partial ${partial}, manual overrides ${manualModels}) · USD source mappings ${usdSourceMapped}/${total}, CNY adapters ${cnySourceMapped}, CNY manual-only ${unsupportedCurrency} · USD/CNY: ${exchangeRate}`
    : `模型价：${price || "内置"}（自动维护 ${matched}/${total}，部分 ${partial}，手动覆盖 ${manualModels}）· USD 来源适配 ${usdSourceMapped}/${total}，CNY 官方源 ${cnySourceMapped} 条，暂保留本地 ${unsupportedCurrency} 条 · 美元兑人民币：${exchangeRate}`;
}

export function usagePricingCoverageText(coverage = {}, locale = "zh-CN") {
  const english = locale === "en-US";
  if (!coverage.ready)
    return english ? "Waiting for usage data before checking coverage." : "等待用量加载，暂不能确认计价覆盖。";
  const used = coverage.usedModelCount || 0;
  const matched = coverage.matchedUsedModelCount || 0;
  const missing = coverage.missingUsedModels?.length ?? Math.max(0, used - matched);
  const free = coverage.freeRuleUsedModelCount || 0;
  return english
    ? `Usage coverage ${matched}/${used} · missing rates ${missing} · free-rule models ${free}`
    : `用量覆盖 ${matched}/${used} · 缺少费率 ${missing} · 免费规则 ${free}`;
}

export function pricingUpdateSummaryText(summary = {}, locale = "zh-CN") {
  const english = locale === "en-US";
  const verified = summary.verifiedModelCount ?? 0;
  const attempted = summary.attemptedModelCount ?? 0;
  const changed = summary.changedModelCount ?? 0;
  const partial = summary.partialModelCount ?? 0;
  const conflicts = summary.conflictModelCount ?? 0;
  const manual = summary.manualOverrideModelCount ?? 0;
  const noMatch = summary.noValidMatchModelCount ?? 0;
  const cny = summary.unsupportedCurrencyModelCount ?? 0;
  return english
    ? `Price check: verified ${verified}/${attempted}, changed ${changed}, partial ${partial}, conflicts ${conflicts}, manual overrides ${manual}, no valid source match ${noMatch}; CNY entries kept local ${cny}`
    : `本次计价：核验 ${verified}/${attempted}，变化 ${changed}，部分 ${partial}，冲突 ${conflicts}，受手动覆盖 ${manual}，未命中有效来源 ${noMatch}；CNY 本地保留 ${cny}`;
}

function renderAutomaticRateRestoreControl() {
  const button = $("#restoreAutomaticRateButton");
  if (!button) return;
  button.hidden = state.pricingCatalog?.automatic?.manualExchangeRate !== true;
  button.setAttribute("aria-pressed", String(state.restoreAutomaticExchangeRate === true));
}

export function pricingUpdateTimestamp(value) {
  if (!value) return "—";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (!Number.isFinite(date.getTime())) return "—";
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderAutomaticPricingStatus(status = {}) {
  const node = $("#pricingUpdatedAt");
  if (!node) return;
  const timestamp = pricingUpdateTimestamp(status.priceUpdatedAt || state.pricingCatalog?.checkedAt);
  node.textContent = `${getLocale() === "en-US" ? "Prices updated" : "价目表更新"} ${timestamp}`;
}

export function pricingIssueText(issue, english) {
  const source = !english && issue.source === "Xiaomi MiMo" ? "小米 MiMo" : issue.source;
  if (issue.code === "timeout") {
    const seconds = issue.timeoutMs ? `（${issue.timeoutMs / 1000} 秒）` : "";
    return english
      ? `${source} timed out${issue.timeoutMs ? ` after ${issue.timeoutMs / 1000}s` : ""}`
      : `${source} 请求超时${seconds}`;
  }
  return `${source}：${issue.message}`;
}

export function discoveryReasonText(reason, english) {
  const labels = english
    ? {
        "not-found": "not listed by either price source",
        "unsupported-provider": "not a supported OpenAI text model",
        "incomplete-rates": "required input, cache, or output rates are missing",
        "context-policy-unknown": "context pricing policy is unknown",
        "unsupported-context-policy": "multiple context tiers are not supported",
        conflict: "the price sources disagree",
        "catalog-capacity": "the model catalog capacity was reached",
        timeout: "price source timed out",
        "source-error": "price sources could not be read",
        "retry-after": "retry is available after one hour",
        "usage-not-ready": "waiting for usage indexing",
        error: "discovery failed",
      }
    : {
        "not-found": "两个价目来源都没有该模型",
        "unsupported-provider": "不是支持的 OpenAI 文本模型",
        "incomplete-rates": "缺少输入、缓存或输出必需费率",
        "context-policy-unknown": "上下文计价规则不明确",
        "unsupported-context-policy": "暂不支持多个上下文档位",
        conflict: "两个价目来源存在冲突",
        "catalog-capacity": "已达到模型目录容量上限",
        timeout: "价目来源请求超时",
        "source-error": "无法读取价目来源",
        "retry-after": "一小时后可重试",
        "usage-not-ready": "等待用量索引就绪",
        error: "自动发现失败",
      };
  return labels[reason] || reason || (english ? "unknown result" : "未知结果");
}

export function pricingProvenanceText(metadata = {}, locale = "zh-CN") {
  const english = locale === "en-US";
  const labels = {
    short: english ? "Standard short" : "标准短上下文",
    long: english ? "Standard long" : "标准长上下文",
    "fast.short": english ? "Fast short" : "快速短上下文",
    "fast.long": english ? "Fast long" : "快速长上下文",
  };
  const origins = english
    ? {
        remote: "remote",
        reference: "OpenRouter reference",
        "built-in": "built-in",
        derived: "derived from Standard ×2",
        mixed: "mixed",
      }
    : {
        remote: "远端来源",
        reference: "OpenRouter 参考价",
        "built-in": "内置价目",
        derived: "由标准费率推算 ×2",
        mixed: "混合来源",
      };
  const fieldLabels = english
    ? { input: "input", cachedInput: "cache read", cacheWrite: "cache write", output: "output" }
    : { input: "输入", cachedInput: "缓存读取", cacheWrite: "缓存写入", output: "输出" };
  return Object.entries(labels)
    .filter(([tier]) => metadata[tier])
    .map(([tier, label]) => {
      const item = metadata[tier];
      const details = [origins[item.origin] || item.origin || (english ? "unknown" : "未知")];
      if (item.sourceUrl) {
        try {
          details.push(new URL(item.sourceUrl).hostname);
        } catch {
          details.push(item.sourceUrl);
        }
      }
      if (item.inheritedFields?.length) {
        details.push(
          (english ? "inherited " : "沿用") +
            item.inheritedFields.map((field) => fieldLabels[field] || field).join(", "),
        );
      }
      const inheritedSources =
        item.inheritedFields
          ?.map((field) => {
            const inherited = item.inheritedFrom?.[field];
            if (!inherited) return "";
            let source = inherited.origin || (english ? "previous rate" : "原费率");
            if (inherited.sourceUrl) {
              try {
                source = new URL(inherited.sourceUrl).hostname;
              } catch {
                source = inherited.sourceUrl;
              }
            }
            return `${fieldLabels[field] || field} ← ${source}`;
          })
          .filter(Boolean) || [];
      if (inheritedSources.length) details.push(inheritedSources.join(", "));
      if (item.checkedAt) details.push(item.checkedAt.slice(0, 10));
      if (item.inputFallbackFields?.length)
        details.push(
          `${item.inputFallbackFields.map((field) => fieldLabels[field] || field).join(", ")}${english ? " use input rates where no cache rate is quoted" : "未单独报价，按普通输入价计"}`,
        );
      if (item.conflicts?.length) details.push(english ? "conflict retained previous rate" : "冲突时保留原费率");
      return `${label}: ${details.join(" · ")}`;
    })
    .join(english ? "; " : "；");
}

async function refreshPricingAutomatically(force = false) {
  if (state.pricingCatalog && !force) return;
  const activity = beginRuntimeTask("pricing", { user: force });
  const button = $("#refreshPricingButton");
  if (button) button.disabled = true;
  if (force && state.pricingCatalog)
    setPricingMessage(getLocale() === "en-US" ? "Updating prices and exchange rate…" : "正在更新价目与汇率…");
  try {
    const response = await fetch("/api/pricing/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", ...runtimeRequestHeaders(activity) },
      body: JSON.stringify({ force }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(localizeServerError(result, response.status));
    if (state.pricingCatalog) state.pricingCatalog.automatic = result;
    if (result.changed || result.statusChanged) {
      // A background refresh may finish after the user has begun editing the dialog.
      if (force && state.pricingCatalog) {
        const catalogResponse = await fetch(pricingActivityUrl(), { headers: runtimeRequestHeaders(activity) });
        if (!catalogResponse.ok) throw new Error(`HTTP ${catalogResponse.status}`);
        const catalog = await catalogResponse.json();
        state.pricingCatalog = catalog;
        $("#usdToCnyRate").value = String(catalog.usdToCnyRate);
        state.restoreAutomaticExchangeRate = false;
        renderAutomaticRateRestoreControl();
      }
      if (result.changed && (state.autoRefreshEnabled || force)) {
        state.snapshotId = null;
        updateRuntimeTask(activity, "statistics");
        await loadUsage({ skipCheck: true, activity, confirmSync: true, background: !force });
      }
    }
    if (state.pricingCatalog) {
      renderAutomaticPricingStatus(state.pricingCatalog.automatic || result, state.pricingCatalog.usageCoverage);
      renderPricingModelList();
      const english = getLocale() === "en-US";
      const issueMessages = result.issues?.length
        ? result.issues.map((issue) => pricingIssueText(issue, english)).join(english ? "; " : "；")
        : result.errors?.join(english ? "; " : "；");
      const message = issueMessages
        ? english
          ? "Some prices could not be updated. Previous rates were kept."
          : "部分价格未能更新，已保留原费率。"
        : force
          ? result.changed || result.statusChanged
            ? getLocale() === "en-US"
              ? result.changed
                ? "Update complete. Unsaved edits were reset."
                : "Status checked. Rates are unchanged."
              : result.changed
                ? "更新完成；未保存的编辑已重置。"
                : "状态已检查，费率未变化。"
            : getLocale() === "en-US"
              ? "Checked. Rates are unchanged."
              : "已检查，费率未变化。"
          : "";
      setPricingMessage(force ? message : "", Boolean(issueMessages));
    }
  } catch (error) {
    finishRuntimeTask(activity, error);
    if (state.pricingCatalog) {
      if (force) setPricingMessage(getLocale() === "en-US" ? "Update failed. Try again." : "更新失败，请重试。", true);
    }
  } finally {
    finishRuntimeTask(activity);
    if (button) button.disabled = false;
  }
}

export function pricingModelNoteParts(contexts, model) {
  const parts = [];
  const english = getLocale() === "en-US";
  if (model === "gpt-6.1-sol")
    parts.push(
      english
        ? `Codex / ChatGPT Work: ${CODEX_GPT_61_CONTEXT_WINDOW / 1_000}K context; short-context rates apply at every length. Fast uses Fast short-context rates`
        : `Codex / ChatGPT Work：上下文 ${CODEX_GPT_61_CONTEXT_WINDOW / 1_000}K，所有长度均按短上下文价；Fast 使用快速短上下文价`,
    );
  if (Number.isInteger(contexts.longContextThreshold))
    parts.push(
      model === "gpt-6.1-sol"
        ? english
          ? `Other sources / API: long-context rates apply above ${formatTokens(contexts.longContextThreshold)} input tokens per request`
          : `其他来源 / API：单次输入超过 ${formatTokens(contexts.longContextThreshold)} tokens 按长上下文价`
        : english
          ? `Long-context rates apply above ${formatTokens(contexts.longContextThreshold)} input tokens per request`
          : `单次输入超过 ${formatTokens(contexts.longContextThreshold)} tokens 按长上下文价`,
    );
  if (Number.isInteger(contexts.outputThreshold))
    parts.push(
      english
        ? `Long-output rates apply at ${formatTokens(contexts.outputThreshold)} output tokens or more`
        : `输出达到 ${formatTokens(contexts.outputThreshold)} tokens 起按长输出价`,
    );
  if (contexts.offPeakMultiplier)
    parts.push(
      english
        ? `Off-peak rates are ${Number(contexts.offPeakMultiplier) * 100}% of peak rates (Beijing time, weekdays 09:00–12:00 and 14:00–18:00; holidays are treated as peak)`
        : `谷时按 ${Number((contexts.offPeakMultiplier * 10).toFixed(2))} 折计（北京时间工作日 9:00-12:00、14:00-18:00 为高峰，节假日未建模按高峰计）`,
    );
  if (contexts.cacheWriteTtl === "5m")
    parts.push(
      english
        ? "Cache writes use 5-minute rates; unknown TTL is an estimated scenario"
        : "缓存写入使用 5 分钟费率，TTL 未确认时为场景估算",
    );
  if (contexts.standardContextLimit)
    parts.push(
      english
        ? `Standard context verified through ${formatTokens(contexts.standardContextLimit)} tokens`
        : `标准上下文已核验至 ${formatTokens(contexts.standardContextLimit)} tokens`,
    );
  return parts;
}

export function formatPricingInput(value) {
  // Hide binary conversion tails without fixing the number of decimal places for small rates.
  return typeof value === "number" ? String(Number(value.toPrecision(15))) : (value ?? "");
}

function pricingContextsHtml(model, contexts) {
  const contextBlock = (context, label, source) => `
      <div class="pricing-context" role="group" aria-label="${label}">
        <strong>${label}</strong>
        ${PRICING_FIELDS.map(
          ([field, fieldLabel]) => `
          <label>${fieldLabel}<input type="number" min="0" step="any" required
            data-model="${escapeHtml(model)}" data-context="${context}" data-field="${field}"
            value="${escapeHtml(formatPricingInput(source[field]))}" /></label>
        `,
        ).join("")}
      </div>
    `;
  return [
    ["", "标准模式", contexts],
    ["fast.", "快速模式", contexts.fast],
  ]
    .filter(([, , source]) => source)
    .map(
      ([prefix, label, source]) => `<section class="pricing-mode-group" aria-label="${label}">
        <h3 class="pricing-mode-heading"><span>${label}</span></h3>
        <div class="pricing-contexts">${["short", "shortLongOutput", "long"]
          .filter((context) => source[context])
          .map((context) =>
            contextBlock(
              `${prefix}${context}`,
              { short: "短上下文", shortLongOutput: "短上下文·长输出", long: "长上下文" }[context],
              source[context],
            ),
          )
          .join("")}</div>
      </section>`,
    )
    .join("");
}

// 计价字段写回工作副本；fast.* 指向官方声明的快速模式费率。
function writePricingField(entry, context, field, value) {
  if (context.startsWith("fast.")) {
    const sub = context.slice(5);
    if (entry.fast?.[sub]) entry.fast[sub][field] = value;
    return;
  }
  if (entry[context]) entry[context][field] = value;
}

export function modelPricingInputsChanged(inputs) {
  const fields = [...inputs];
  return (
    fields.length > 0 &&
    fields.every((input) => input.validity.valid && input.value !== "" && Number.isFinite(Number(input.value))) &&
    fields.some((input) => input.defaultValue === "" || Number(input.value) !== Number(input.defaultValue))
  );
}

function updateModelPricingApplyState() {
  const inputs = $("#modelPricingFields").querySelectorAll("input[data-model]");
  $("#applyModelPricingButton").disabled = !modelPricingInputsChanged(inputs);
}

function pricingRowsForNames(names, catalog) {
  const rows = [];
  const seen = new Set();
  for (const raw of names) {
    const resolved = resolvePricingModel(raw, catalog);
    if (resolved.matchType === "missing" && !resolved.rawModel) continue;
    const identity = resolved.canonicalModel.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push({ model: resolved.canonicalModel, catalogKey: resolved.catalogKey, matchType: resolved.matchType });
  }
  return rows;
}

export function pricingProviderGroups() {
  const catalog = state.pricingCatalog?.models || {};
  const harnessModels = state.pricingCatalog?.modelActivity?.harnessModels ?? state.metadata?.harnessModels ?? {};
  const rows = pricingRowsForNames(Object.values(harnessModels).flat(), catalog);
  const dates = state.pricingCatalog?.automatic?.modelReleaseDates;
  const search = state.pricingSearch.trim().toLocaleLowerCase();
  const providers = new Map(PRICING_PROVIDERS.map((provider) => [provider.id, provider]));
  for (const row of rows) {
    const known = pricingProvider(row.model);
    const metadata = state.pricingCatalog?.automatic?.modelMetadata?.[row.catalogKey || row.model]?.short;
    const id = known.id === "other" && /^[a-z0-9-]+$/.test(metadata?.providerId || "") ? metadata.providerId : known.id;
    row.providerId = id;
    if (!providers.has(id)) providers.set(id, { id, name: metadata.providerName || id });
  }
  return [...providers.values()]
    .map((provider) => {
      const providerMatches = `${provider.id} ${provider.name} ${localizeText(provider.name)}`
        .toLocaleLowerCase()
        .includes(search);
      const models = rows
        .filter((row) => row.providerId === provider.id)
        .filter((row) => providerMatches || `${row.model} ${row.catalogKey || ""}`.toLocaleLowerCase().includes(search))
        .map((row) => ({ ...row, releaseDate: pricingReleaseDate(row.model, dates) }))
        .sort(
          (left, right) =>
            right.releaseDate.localeCompare(left.releaseDate) ||
            right.model.localeCompare(left.model, undefined, { numeric: true }),
        );
      const hasUnread = models.some((row) => !state.pricingSeenModels.has(row.model.toLowerCase()));
      return { ...provider, models, hasUnread };
    })
    .filter((provider) => provider.models.length)
    .sort(
      (left, right) =>
        Number(right.hasUnread) - Number(left.hasUnread) ||
        Number(left.id === "other") - Number(right.id === "other") ||
        right.models.length - left.models.length,
    );
}

function renderPricingModelList() {
  const container = $("#pricingProviderList");
  const catalog = state.pricingCatalog;
  if (!container || !catalog) return;
  const english = getLocale() === "en-US";
  const groups = pricingProviderGroups();
  const empty = `<div class="empty">${localizeText(state.pricingSearch.trim() ? "没有匹配的模型" : "暂无已用到的模型")}</div>`;
  container.innerHTML =
    groups
      .map(
        (
          provider,
        ) => `<button type="button" class="pricing-provider-card" data-pricing-provider="${provider.id}" aria-haspopup="dialog">
    <span class="pricing-provider-name">${escapeHtml(localizeText(provider.name))}</span>
    <span class="metric-new" role="img" aria-label="${english ? "Newly used models" : "有新使用的模型"}"${provider.hasUnread ? "" : " hidden"}></span>
    <span class="pricing-provider-readout"><span class="pricing-provider-count">${provider.models.length}<small class="metric-unit">${english ? "models" : "个模型"}</small></span></span>
  </button>`,
      )
      .join("") || empty;
  const provider = groups.find((group) => group.id === state.pricingProvider);
  if (!provider) return;
  $("#providerPricingTitle").textContent = localizeText(provider.name);
  const columns = [
    ["input", english ? "Input" : "输入"],
    ["cachedInput", english ? "Cache" : "缓存"],
    ["output", english ? "Output" : "输出"],
  ];
  const rateFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 });
  $("#providerPricingColumns").innerHTML =
    `<span>${english ? "Model" : "模型"}</span>${columns.map(([, label]) => `<span>${label}</span>`).join("")}`;
  const rowHtml = (row) => {
    if (row.matchType === "missing") {
      return `<button type="button" class="pricing-model-row" data-pricing-model="${escapeHtml(row.model.toLowerCase())}" aria-haspopup="dialog" title="${english ? "Edit this model's rates" : "点击编辑该模型费率"}">
        <span class="pricing-model-name"><span class="pricing-model-id">${escapeHtml(row.model)}</span></span>
        <span class="pricing-state-badge missing">${english ? "Set rates" : "待设置单价"}</span>
      </button>`;
    }
    if (row.matchType === "free") {
      return `<div class="pricing-model-row pricing-model-unpriced" role="group" aria-label="${escapeHtml(row.model)}">
        <span class="pricing-model-name"><span class="pricing-model-id">${escapeHtml(row.model)}</span></span>
        <span class="pricing-state-badge free">${english ? "Free" : "免费"}</span>
      </div>`;
    }
    const contexts = catalog.models[row.catalogKey];
    const currency = contexts.currency === "CNY" ? "¥" : "$";
    const rates = columns.map(([field, label]) => ({
      field,
      label,
      value: typeof contexts.short?.[field] === "number" ? rateFormatter.format(contexts.short[field]) : "—",
    }));
    const accessibleName = `${row.model}, ${rates.map((rate) => `${rate.label} ${currency}${rate.value}`).join(", ")}`;
    const alias =
      row.model.toLowerCase() === row.catalogKey.toLowerCase()
        ? ""
        : ` · ${english ? "Priced as" : "计价名称"} ${row.catalogKey}`;
    return `<button type="button" class="pricing-model-row" data-pricing-model="${escapeHtml(row.catalogKey)}" aria-haspopup="dialog" aria-label="${escapeHtml(accessibleName)}" title="${escapeHtml((english ? "Edit this model's rates" : "点击编辑该模型费率") + alias)}">
      <span class="pricing-model-name"><span class="pricing-model-id">${escapeHtml(row.model)}</span></span>
      ${rates.map((rate) => `<span class="pricing-model-rate" data-pricing-rate="${rate.field}"><span class="pricing-rate-currency">${currency}</span>${escapeHtml(rate.value)}</span>`).join("")}
    </button>`;
  };

  $("#pricingModelList").innerHTML = provider.models.map(rowHtml).join("") || empty;
}

function openProviderPricing(provider) {
  state.pricingProvider = provider;
  const group = pricingProviderGroups().find((item) => item.id === provider);
  if (!group) return;
  for (const row of group.models) state.pricingSeenModels.add(row.model.toLowerCase());
  try {
    localStorage.setItem(PRICING_SEEN_MODELS_STORAGE_KEY, JSON.stringify([...state.pricingSeenModels]));
  } catch {
    // Keep acknowledgement for this session when browser storage is unavailable.
  }
  renderPricingModelList();
  $("#pricingDialog").classList.add("is-provider-open");
  $("#providerPricingDialog").showModal();
  $("#providerPricingTitle").focus({ preventScroll: true });
}

function closeProviderPricing(immediate = false) {
  closeModelPricing();
  const dialog = $("#providerPricingDialog");
  if (!dialog.open && state.pricingProvider === null) return;
  $("#pricingDialog").classList.remove("is-provider-open");
  if (dialog.open && !immediate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    dialog.classList.add("is-leaving");
    return;
  }
  const provider = state.pricingProvider;
  state.pricingProvider = null;
  dialog.close();
  dialog.classList.remove("is-leaving");
  [...$("#pricingProviderList").querySelectorAll("[data-pricing-provider]")]
    .find((button) => button.dataset.pricingProvider === provider)
    ?.focus({ preventScroll: true });
}

function updateDisplayCurrencyButtons() {
  for (const button of document.querySelectorAll("[data-display-currency]")) {
    const selected = button.dataset.displayCurrency === state.costScaleTarget;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function openModelPricing(model) {
  if (!state.pricingCatalog) return;
  const entry = state.pricingCatalog.models[model] || {
    short: Object.fromEntries(PRICING_FIELDS.map(([field]) => [field, ""])),
  };
  state.modelPricingDraft = model;
  $("#modelPricingTitle").innerHTML =
    `${escapeHtml(model)}<span class="currency-badge">${entry.currency === "CNY" ? "CNY" : "USD"}</span>`;
  const provenance = pricingProvenanceText(state.pricingCatalog?.automatic?.modelMetadata?.[model], getLocale());
  $("#modelPricingNote").textContent = [...pricingModelNoteParts(entry, model), provenance]
    .filter(Boolean)
    .join(getLocale() === "en-US" ? "; " : "；");
  $("#modelPricingFields").innerHTML = pricingContextsHtml(model, entry);
  updateModelPricingApplyState();
  // 原生顶层弹窗：showModal 负责置顶、焦点圈定，关闭时焦点自动还原。
  $("#modelPricingDialog").showModal();
  $("#modelPricingTitle").focus({ preventScroll: true });
}

function closeModelPricing() {
  const dialog = $("#modelPricingDialog");
  if (dialog.open) dialog.close();
}

function applyModelPricing() {
  const model = state.modelPricingDraft;
  const inputs = $("#modelPricingFields").querySelectorAll("input[data-model]");
  if (!model || !state.pricingCatalog || !modelPricingInputsChanged(inputs)) return;
  const entry = state.pricingCatalog.models[model] || { currency: "USD", short: {} };
  for (const input of inputs) {
    // A formatted default is presentation only; preserve untouched source precision.
    if (input.defaultValue !== "" && Number(input.value) === Number(input.defaultValue)) continue;
    writePricingField(entry, input.dataset.context, input.dataset.field, Number(input.value));
  }
  state.pricingCatalog.models = { ...state.pricingCatalog.models, [model]: entry };
  closeModelPricing();
  renderPricingModelList();
  [...$("#pricingModelList").querySelectorAll("[data-pricing-model]")]
    .find((row) => row.dataset.pricingModel === model)
    ?.focus();
}

function pricingActivityUrl() {
  return state.snapshotId ? `/api/pricing?snapshot=${encodeURIComponent(state.snapshotId)}` : "/api/pricing";
}

async function openPricingDialog() {
  const button = $("#updatePricingButton");
  button.disabled = true;
  const activity = beginRuntimeTask("pricing", { user: true });
  try {
    const response = await fetch(pricingActivityUrl(), { headers: runtimeRequestHeaders(activity) });
    const catalog = await response.json();
    if (!response.ok) throw new Error(localizeServerError(catalog, response.status));
    state.pricingCatalog = catalog;
    try {
      const seen = JSON.parse(localStorage.getItem(PRICING_SEEN_MODELS_STORAGE_KEY));
      if (Array.isArray(seen) && seen.every((model) => typeof model === "string")) {
        state.pricingSeenModels = new Set(seen);
      }
    } catch {
      // Retain in-memory acknowledgement if browser storage is unavailable or invalid.
    }
    state.restoreAutomaticExchangeRate = false;
    renderAutomaticRateRestoreControl();
    renderAutomaticPricingStatus(catalog.automatic);
    state.pricingSearch = "";
    state.pricingProvider = null;
    $("#pricingSearch").value = "";
    $("#usdToCnyRate").value = String(catalog.usdToCnyRate ?? 6.72);
    updateDisplayCurrencyButtons();
    renderPricingModelList();
    setPricingMessage("");
    $("#pricingDialog").hidden = false;
    $("#pricingProviderList").scrollTop = 0;
    $("#pricingDialogTitle").focus({ preventScroll: true });
  } catch (error) {
    finishRuntimeTask(activity, new Error(`读取计价标准失败：${error.message}`));
  } finally {
    finishRuntimeTask(activity);
    button.disabled = false;
  }
}

function closePricingDialog() {
  closeProviderPricing(true);
  $("#pricingDialog").hidden = true;
  state.pricingCatalog = null;
  state.restoreAutomaticExchangeRate = false;
  renderAutomaticRateRestoreControl();
  state.pricingSearch = "";
  setPricingMessage("");
  $("#updatePricingButton").focus();
}

function restoreAutomaticExchangeRateDraft() {
  const rate = Number(state.pricingCatalog?.automatic?.automaticUsdToCnyRate);
  if (!(rate > 0)) {
    setPricingMessage(
      getLocale() === "en-US" ? "No automatic exchange rate is available." : "当前没有可恢复的自动汇率。",
      true,
    );
    return;
  }
  state.restoreAutomaticExchangeRate = true;
  $("#usdToCnyRate").value = String(rate);
  renderAutomaticRateRestoreControl();
  setPricingMessage(
    getLocale() === "en-US"
      ? "The automatic rate will take effect when you save. Cancel leaves the saved rate unchanged."
      : "自动汇率将在保存后生效；取消不会改变已保存的汇率。",
  );
}

async function submitPricing(event) {
  event.preventDefault();
  if (!state.pricingCatalog) return;
  const rateText = $("#usdToCnyRate").value.trim();
  const usdToCnyRate = Number(rateText);
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(rateText) || !Number.isFinite(usdToCnyRate) || !(usdToCnyRate > 0)) {
    setPricingMessage("请填写大于 0 的美元兑人民币汇率。", true);
    return;
  }
  const restoreAutomaticExchangeRate = state.restoreAutomaticExchangeRate === true;
  // 价格核对日期自动取保存当天，无需用户填写。
  const now = new Date();
  const checkedAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const button = $("#savePricingButton");
  button.disabled = true;
  const activity = beginRuntimeTask("pricing", { user: true });
  setPricingMessage("正在保存并重算…");
  try {
    const response = await fetch("/api/pricing", {
      method: "PUT",
      headers: { "content-type": "application/json", ...runtimeRequestHeaders(activity) },
      body: JSON.stringify({
        version: state.pricingCatalog.version,
        checkedAt,
        usdToCnyRate,
        restoreAutomaticExchangeRate,
        models: structuredClone(state.pricingCatalog.models),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(localizeServerError(data, response.status));
    // The open snapshot carries the pre-save pricing catalog. Force the next usage load
    // to freeze a catalog that includes the rates just written.
    state.snapshotId = null;
    updateRuntimeTask(activity, "statistics");
    await loadUsage({ skipCheck: true, activity, confirmSync: true });
    closePricingDialog();
  } catch (error) {
    finishRuntimeTask(activity, error);
    setPricingMessage(`保存失败：${error.message}`, true);
  } finally {
    finishRuntimeTask(activity);
    button.disabled = false;
  }
}

function updatePresetButtons() {
  if (state.preset === "all") renderRecordBadges();
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
    runtimeNotice("最近范围格式无效。请使用数字和天、周、月或年。");
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

export let activeUsageLoadDone = Promise.resolve();

function usageQuery(...args) {
  return dashboardRuntime.usageQuery(...args);
}

function loadUsage({ preserveShare, ...options } = {}) {
  const pending = dashboardRuntime.loadUsage({ ...options, preserveView: options.preserveView ?? preserveShare });
  activeUsageLoadDone = dashboardRuntime.activeUsageLoadDone;
  return pending;
}

function checkForUpdates(...args) {
  return dashboardRuntime.checkForUpdates(...args);
}

function startAutoRefresh(...args) {
  return dashboardRuntime.startAutoRefresh(...args);
}

function refreshViewForFilters(...args) {
  return dashboardRuntime.refreshViewForFilters(...args);
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

// Native surface lighting: one actual raised surface at a time. Keeping this
// delegated also covers comparison cards rebuilt by render(). The whole calendar
// is exempt, including its raised navigation buttons and gaps between dates.
function setupFrameSpotlight(root) {
  if (!root || typeof window.matchMedia !== "function") return;
  const surfaces =
    ".topbar,.toolbar > .control-group,.metric,.panel,.comparison-item,.recent-segment,.recent-range-menu,button";
  // Detail tracks/fills belong to the panel's continuous light: neither hit
  // testing nor the parent mask should treat them as separate wells.
  const recesses =
    ".metric > strong,.comparison-item:not(.comparison-unavailable) > strong,.bar-track:not(.detail-panel .bar-track),.timeline-chart-well,.comparison-table-scroll,.home-list,.cost-estimate-note,.auto-refresh-well,#presetButtons,.segmented-well,.recent-combobox,.date-range-button,input,select,textarea,button:disabled,.date-picker-popover";
  const capability = window.matchMedia("(hover: hover) and (pointer: fine)");
  let point = null;
  let active = null;
  let frame = 0;
  let maskDirty = true;
  let lastBounds = "";
  let lastStyle = "";
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(invalidate) : null;
  let observedNodes = new Set([root]);

  function observeSizes(nodes) {
    const next = new Set([root, ...nodes]);
    for (const node of observedNodes) if (!next.has(node)) resizeObserver?.unobserve(node);
    for (const node of next) if (!observedNodes.has(node)) resizeObserver?.observe(node);
    observedNodes = next;
  }

  function raised(node, css = getComputedStyle(node)) {
    // A raised ceramic rim can itself contain an inset shadow. Only surfaces
    // with an outer material shadow qualify; transparent rail items do not.
    return (
      !node.matches(recesses) &&
      css.boxShadow !== "none" &&
      css.boxShadow.split(/,(?![^(]*\))/).some((shadow) => !/\binset\b/.test(shadow))
    );
  }

  function inset(css) {
    return css.boxShadow !== "none" && css.boxShadow.split(/,(?![^(]*\))/).every((shadow) => /\binset\b/.test(shadow));
  }

  function surfaceAt(node) {
    if (!node || !root.contains(node)) return null;
    if (node.closest(".date-picker-popover")) return null;
    if (document.documentElement.dataset.skin === "classic" && node.closest("#skinToggle")) return null;
    if (node.closest("#timelineModes[data-motion-ready]")) return null;
    for (let current = node; current && current !== root; current = current.parentElement) {
      if (current.matches(recesses)) return null;
      if (current.matches(surfaces)) {
        const css = getComputedStyle(current);
        if (inset(css)) return null;
        if (raised(current, css)) return current;
      }
    }
    return null;
  }

  function clear() {
    if (!active) return;
    active.removeAttribute("data-spotlight-active");
    active.removeAttribute("data-spotlight-static");
    for (const property of ["--spotlight-x", "--spotlight-y", "--spotlight-radius", "--spotlight-mask"]) {
      active.style.removeProperty(property);
    }
    active = null;
    lastBounds = "";
    lastStyle = "";
    observeSizes([]);
  }

  function reset() {
    point = null;
    cancelAnimationFrame(frame);
    frame = 0;
    clear();
  }

  function schedule() {
    if (point && !frame && capability.matches && !document.hidden) frame = requestAnimationFrame(paint);
  }

  function invalidate() {
    maskDirty = true;
    schedule();
  }

  function maskFor(host, bounds, css) {
    const left = bounds.left + Number.parseFloat(css.borderLeftWidth);
    const top = bounds.top + Number.parseFloat(css.borderTopWidth);
    const width = bounds.width - Number.parseFloat(css.borderLeftWidth) - Number.parseFloat(css.borderRightWidth);
    const height = bounds.height - Number.parseFloat(css.borderTopWidth) - Number.parseFloat(css.borderBottomWidth);
    const holes = [];
    const clips = [];
    const observed = [];
    for (const node of host.querySelectorAll(`${recesses},${surfaces}`)) {
      // Remove whole wells, plus child raised surfaces, from the parent's light.
      // A raised button inside a well can still light its own surface when hit.
      if (observed.some((ancestor) => ancestor.contains(node))) continue;
      // Closed details can retain layout boxes for content that is not painted.
      if (!node.checkVisibility({ visibilityProperty: true })) continue;
      const childCss = getComputedStyle(node);
      if (!node.matches(recesses) && !inset(childCss) && !raised(node, childCss)) continue;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height || childCss.visibility === "hidden") continue;
      const visible = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      // Offscreen rows inside a scroller must not cut ghost holes in the panel
      // heading. Preserve the rounded shape, then clip it to visible ancestors.
      for (let parent = node.parentElement; parent && parent !== host; parent = parent.parentElement) {
        const parentCss = getComputedStyle(parent);
        if (parentCss.overflowX === "visible" && parentCss.overflowY === "visible") continue;
        const clip = parent.getBoundingClientRect();
        if (parentCss.overflowX !== "visible") {
          visible.left = Math.max(visible.left, clip.left + Number.parseFloat(parentCss.borderLeftWidth));
          visible.right = Math.min(visible.right, clip.right - Number.parseFloat(parentCss.borderRightWidth));
        }
        if (parentCss.overflowY !== "visible") {
          visible.top = Math.max(visible.top, clip.top + Number.parseFloat(parentCss.borderTopWidth));
          visible.bottom = Math.min(visible.bottom, clip.bottom - Number.parseFloat(parentCss.borderBottomWidth));
        }
      }
      if (visible.right <= visible.left || visible.bottom <= visible.top) continue;
      const radius = Math.min(Number.parseFloat(childCss.borderTopLeftRadius) || 0, box.width / 2, box.height / 2);
      const id = `visible-${holes.length}`;
      clips.push(
        `<clipPath id="${id}"><rect x="${visible.left - left}" y="${visible.top - top}" width="${visible.right - visible.left}" height="${visible.bottom - visible.top}"/></clipPath>`,
      );
      holes.push(
        `<rect x="${box.left - left}" y="${box.top - top}" width="${box.width}" height="${box.height}" rx="${radius}" fill="black" clip-path="url(#${id})"/>`,
      );
      observed.push(node);
    }
    // SVG alpha masking unions overlapping cutouts. It also protects transparent
    // wells; their background opacity and existing inner shadows stay untouched.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${clips.join("")}</defs><mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/>${holes.join("")}</mask><rect width="${width}" height="${height}" fill="white" mask="url(#cut)"/></svg>`;
    return { image: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`, observed };
  }

  function paint() {
    frame = 0;
    if (!point || !capability.matches || document.hidden) return reset();
    // Re-hit-test after scrolling or template replacement, even without a new
    // pointer event. No stale event target or enter-only coordinate cache.
    const host = surfaceAt(document.elementFromPoint(point.x, point.y));
    if (!host?.isConnected) return clear();
    const css = getComputedStyle(host);
    const bounds = host.getBoundingClientRect();
    if (!bounds.width || !bounds.height || css.visibility === "hidden") return clear();
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    const rebuild = host !== active || maskDirty || key !== lastBounds;
    const mask = rebuild ? maskFor(host, bounds, css) : null;
    const x = point.x - bounds.left - Number.parseFloat(css.borderLeftWidth);
    const y = point.y - bounds.top - Number.parseFloat(css.borderTopWidth);
    if (host !== active) {
      clear();
      active = host;
      if (css.position === "static") active.setAttribute("data-spotlight-static", "");
      active.setAttribute("data-spotlight-active", "");
    }
    active.style.setProperty("--spotlight-x", `${x}px`);
    active.style.setProperty("--spotlight-y", `${y}px`);
    active.style.setProperty("--spotlight-radius", `${Math.min(320, Math.max(80, bounds.width * 0.65))}px`);
    if (mask) {
      active.style.setProperty("--spotlight-mask", mask.image);
      observeSizes([active, ...mask.observed]);
    }
    lastStyle = active.getAttribute("style");
    lastBounds = key;
    maskDirty = false;
  }

  function move(event) {
    if (!capability.matches || event.pointerType === "touch") return reset();
    point = { x: event.clientX, y: event.clientY };
    schedule();
  }

  root.addEventListener("pointermove", move, { passive: true });
  root.addEventListener("pointerdown", move, { passive: true });
  root.addEventListener("pointerup", move, { passive: true });
  root.addEventListener("pointerleave", reset);
  root.addEventListener("pointercancel", reset);
  capability.addEventListener("change", reset);
  window.addEventListener("blur", reset);
  window.addEventListener("resize", invalidate, { passive: true });
  document.addEventListener("scroll", invalidate, { capture: true, passive: true });
  document.addEventListener("visibilitychange", reset);
  resizeObserver?.observe(root);
  const mutations = new MutationObserver((records) => {
    // Coordinate writes are local CSS variables; do not feed our own writes
    // back into the observer and create an endless animation frame loop.
    if (
      records.every(
        (record) =>
          record.target.closest?.(
            "[data-motion-content], [data-motion-indicator], [data-glass-surface], .lg-cover, .lg-tick",
          ) ||
          (record.type === "attributes" &&
            record.attributeName === "style" &&
            record.target === active &&
            active.getAttribute("style") === lastStyle),
      )
    )
      return;
    if (records.some((record) => record.type === "childList")) motionGlass?.refreshTargets();
    if (
      records.some(
        (record) => record.attributeName === "hidden" && record.target.matches(".dialog-backdrop:not([hidden])"),
      )
    )
      motionGlass?.clearFrame();
    if (active && !active.isConnected) clear();
    invalidate();
  });
  mutations.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "open", "disabled", "aria-pressed", "aria-selected", "aria-expanded"],
  });
  // Dialogs sit outside .shell. Opening one must also clear a main-page light
  // under its backdrop without waiting for the user to move the pointer.
  for (const backdrop of document.querySelectorAll(".dialog-backdrop")) {
    mutations.observe(backdrop, { attributes: true, attributeFilter: ["hidden"] });
  }
}

async function bootDashboard() {
  try {
    state.costScaleTarget = window.localStorage.getItem(DISPLAY_CURRENCY_STORAGE_KEY) === "CNY" ? "CNY" : "USD";
  } catch {
    state.costScaleTarget = "USD";
  }
  updateDisplayCurrencyButtons();
  updateDateRangeControl();
  setupUsageTooltip();
  setupFrameSpotlight($(".shell"));
  updateLanguageButton();

  // Character skins: adopt the state the pre-paint bootstrap already restored,
  // then re-apply through the DOM path so both entry points agree exactly.
  // Programmatic preference changes (tests, future callers) must reach the
  // picker's slider sync too, not just the decoration layer (refinement R4).
  if (document.documentElement.dataset.edition === "waifu") {
    const { createSkinPicker, createSkinRuntime, installSkinTestHook, SKINS } = await import("./skin-ui.js");
    state.skinRuntime = createSkinRuntime({
      registry: SKINS,
      persistChanges: !paletteStudioPreview,
      onChange: (preference, meta) => {
        state.skinPicker?.syncOpacityControl();
        // Canvas charts read CSS colours at draw time, so a palette change (the
        // skin changed) must be followed by one re-render. Opacity and character
        // visibility recolour nothing, and re-rendering per slider tick would be
        // wasteful.
        if (!meta || meta.previousSkinId !== preference.skinId) {
          motionGlass?.updateGlass();
          render();
        }
        if (!paletteStudioPreview && meta?.previousSkinId !== preference.skinId)
          void import("./achievement-events.js")
            .then((events) => events.recordAchievementSkin(preference.skinId))
            .catch(() => {});
      },
    });
    state.skinRuntime.restore();
    state.skinRuntime.apply();
    if (!paletteStudioPreview)
      void import("./achievement-events.js")
        .then((events) => events.recordAchievementSkin(state.skinRuntime.getPreference().skinId))
        .catch(() => {});
    function reflectPickerOpen(open) {
      $("#skinToggle").setAttribute("aria-expanded", String(open));
      motionGlass?.updateGlass();
    }
    state.skinPicker = createSkinPicker({
      runtime: state.skinRuntime,
      translate: (key) => localizeText(key, getLocale()),
      onOpen: () => reflectPickerOpen(true),
      onClose: () => reflectPickerOpen(false),
    });
    state.skinPicker.bind();
    installSkinTestHook(state.skinRuntime, state.skinPicker);
    $("#skinToggle").addEventListener("click", () => state.skinPicker.toggleOpen());
    const { createAchievementDialog } = await import("./achievement-dialog.js");
    const { createAchievementUnread } = await import("./achievement-unread.js");
    const { createAchievementNotice } = await import("./achievement-notice.js");
    achievementUnread = createAchievementUnread({
      onChange: (snapshot) => {
        achievementNotice?.update(snapshot);
        achievementDialog?.acceptSnapshot(snapshot);
      },
    });
    achievementDialog = createAchievementDialog({
      readSnapshot: () => achievementUnread.refresh(),
      onRecentShown: (displayed) => achievementUnread.markShown(displayed),
      async onShare(selection) {
        const appearance = {
          ...state.skinRuntime.getPreference(),
          mode: state.theme,
        };
        try {
          const { openAchievementShareDialog } = await import("./share-dialog.js");
          if (!selection.opener.closest("dialog")?.open) return;
          openAchievementShareDialog({
            ...selection,
            render: async () => {
              const { renderAchievementShareCard } = await import("./achievement-share-card.js");
              return renderAchievementShareCard({ ...selection, ...appearance });
            },
          });
        } catch {
          runtimeNotice(
            selection.locale === "en-US" ? "Could not open achievement sharing." : "暂时无法打开成就分享。",
          );
        }
      },
    });
    achievementNotice = createAchievementNotice({ onOpen: () => achievementDialog.openRecent() });
    refreshAchievements();
  }

  $("#languageToggle").addEventListener("click", () => {
    setLanguage(getLocale() === "en-US" ? "zh-CN" : "en-US");
  });

  $("#shareToggle").addEventListener("click", () => void openShareImageDialog());

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

  $("#autoRefreshToggle").addEventListener("click", () => setAutoRefreshEnabled(!state.autoRefreshEnabled));
  $("#autoRefreshError").addEventListener("click", () => setAutoRefreshErrorDetails(true));
  $("#autoRefreshErrorBack").addEventListener("click", () => setAutoRefreshErrorDetails(false));
  $("#autoRefreshErrorDetails").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setAutoRefreshErrorDetails(false);
  });
  $("#timelineModes").addEventListener("click", (event) => {
    const button = event.target.closest("[data-timeline-mode]");
    if (!button || button.dataset.timelineMode === state.timelineMode) return;
    state.timelineMode = button.dataset.timelineMode;
    highlightedSeries = null;
    render();
  });
  $("#timelineLegend").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-series]");
    const summary = currentSummary();
    if (!button || !summary) return;
    const { series } = button.dataset;
    highlightedSeries = highlightedSeries === series ? null : series;
    renderTimelinePanels(summary);
  });

  $("#updatePricingButton").addEventListener("click", openPricingDialog);
  $("#refreshPricingButton").addEventListener("click", () => void refreshPricingAutomatically(true));
  $("#pricingForm").addEventListener("submit", submitPricing);
  $("#cancelPricingButton").addEventListener("click", closePricingDialog);
  $("#restoreAutomaticRateButton").addEventListener("click", restoreAutomaticExchangeRateDraft);
  $("#usdToCnyRate").addEventListener("input", () => {
    if (!state.restoreAutomaticExchangeRate) return;
    state.restoreAutomaticExchangeRate = false;
    renderAutomaticRateRestoreControl();
  });
  $("#pricingDialog").addEventListener("click", (event) => {
    if (event.target.id === "pricingDialog") closePricingDialog();
  });
  $("#pricingSearch").addEventListener("input", (event) => {
    state.pricingSearch = event.target.value;
    renderPricingModelList();
    $("#pricingProviderList").scrollTop = 0;
  });
  $("#pricingProviderList").addEventListener("click", (event) => {
    const provider = event.target.closest("[data-pricing-provider]");
    if (provider) openProviderPricing(provider.dataset.pricingProvider);
  });
  $("#closeProviderPricingButton").addEventListener("click", () => closeProviderPricing());
  $("#providerPricingDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeProviderPricing();
  });
  $("#providerPricingDialog").addEventListener("animationend", (event) => {
    if (event.animationName === "provider-pricing-leave") closeProviderPricing(true);
  });
  $("#providerPricingDialog").addEventListener("click", (event) => {
    if (event.target.id === "providerPricingDialog") closeProviderPricing();
  });
  $("#providerPricingDialog").addEventListener("close", () => {
    if (!$("#providerPricingDialog").open) closeProviderPricing(true);
  });
  $("#pricingCurrency").addEventListener("click", (event) => {
    const currency = event.target.closest("[data-display-currency]")?.dataset.displayCurrency;
    if (!["USD", "CNY"].includes(currency) || currency === state.costScaleTarget) return;
    state.costScaleTarget = currency;
    try {
      window.localStorage.setItem(DISPLAY_CURRENCY_STORAGE_KEY, currency);
    } catch {
      // Browsers that disable storage still allow changing the current display.
    }
    updateDisplayCurrencyButtons();
    hideUsageTooltip();
    render();
  });
  $("#pricingModelList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-pricing-model]");
    if (!row) return;
    openModelPricing(row.dataset.pricingModel);
  });
  $("#applyModelPricingButton").addEventListener("click", applyModelPricing);
  $("#modelPricingFields").addEventListener("input", updateModelPricingApplyState);
  $("#modelPricingFields").addEventListener("change", updateModelPricingApplyState);
  $("#cancelModelPricingButton").addEventListener("click", closeModelPricing);
  $("#modelPricingDialog").addEventListener("click", (event) => {
    if (event.target.id === "modelPricingDialog") closeModelPricing();
  });
  // cancel（Esc）与 close() 都会走到 close：草稿在这里统一清理。
  $("#modelPricingDialog").addEventListener("close", () => {
    state.modelPricingDraft = null;
  });
  $("#addImportButton").addEventListener("click", openImportDialog);
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
    removeImportDirectory(button.dataset.importPath).catch(() => {
      button.disabled = false;
    });
  });
  $("#importForm").addEventListener("submit", submitImportDirectory);
  $("#rescanImportsButton").addEventListener("click", () => void scanImportDirectories());
  $("#manualImportButton").addEventListener("click", () => {
    showManualImport($("#manualImportArea").hidden);
  });
  $("#importCandidates").addEventListener("change", updateImportButton);
  $("#importPath").addEventListener("input", updateImportButton);
  $("#pickImportDirectoryButton").addEventListener("click", pickImportDirectory);
  $("#sourcePicker").addEventListener("change", (event) => {
    const input = event.target.closest("input[data-source-id]");
    if (!input) {
      return;
    }
    setSourceOption(input.dataset.sourceId, input.checked);
  });
  $("#cancelImportButton").addEventListener("click", closeImportDialog);
  $("#importDialog").addEventListener("click", (event) => {
    if (event.target.id === "importDialog") {
      closeImportDialog();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !$("#modelPricingDialog").open && !$("#providerPricingDialog").open) {
      const dialog = [$("#pricingDialog"), $("#importDialog"), $("#skinDialog")].find(
        (candidate) => candidate && !candidate.hidden,
      );
      if (dialog) trapDialogFocus(event, dialog);
    }
    if (event.key === "Escape") {
      setRecentMenuOpen(false);
    }
    // 子弹窗已改原生 <dialog>，Esc 由平台关闭顶层弹窗；这里只在子弹窗未打开时关父弹窗。
    if (
      event.key === "Escape" &&
      !$("#pricingDialog").hidden &&
      !$("#modelPricingDialog").open &&
      !$("#providerPricingDialog").open
    )
      closePricingDialog();
    if (event.key === "Escape" && !$("#importDialog").hidden) {
      closeImportDialog();
    }
    if (event.key === "Escape" && $("#skinDialog") && !$("#skinDialog").hidden) {
      state.skinPicker?.close();
    }
  });
  $("#themeToggle").addEventListener("click", () => {
    void toggleTheme();
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
    if (!document.hidden) renderRelativeCheckTime();
    if (!document.hidden && state.autoRefreshEnabled) {
      startAutoRefresh();
      void checkForUpdates();
    }
  });
  window.addEventListener("pagehide", () => {
    dashboardRuntime.dispose();
    window.clearInterval(importView.timer);
  });

  setTheme(preferredTheme(), { persist: false });
  if (state.skinRuntime) motionGlass = setupMotionGlass();
  state.excludedHomes = readExcludedHomes();
  initializeAutoRefresh();
  updateRecentControls();
  void pollImportTask(true);
  void loadUsage().then(() => {
    startAutoRefresh();
    void refreshPricingAutomatically();
  });
  setInterval(() => void refreshPricingAutomatically(), 60 * 60 * 1000);
}

if (typeof document !== "undefined") {
  bootDashboard();
}
