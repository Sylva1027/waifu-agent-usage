import { canonicalRecentValue, getLocale } from "./locale.js";
import { RECENT_SELECTIONS, isPreviousQuotaRange } from "./timeline-utils.js";
import {
  formatTokenMillions,
  formatTokens,
  asDate,
  QUOTA_PRESETS,
  usageValue,
  timelineChannelSegments,
  timelineModelSegments,
} from "./dashboard-render.js";
import { calendarParts, calendarDate, rangeCalendarZone, dateKey } from "./calendar.js";
import { escapeHtml } from "./html-utils.js";

function isQuotaPreset(preset, fallbackPreset = undefined) {
  return QUOTA_PRESETS.includes(preset === undefined ? fallbackPreset : preset);
}

const MONTH_NAMES_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CALENDAR_BUCKETS = new Set(["day", "week", "month", "hour"]);

export function renderTokenMetricHtml(value) {
  const formatted = formatTokenMillions(value);
  return `${escapeHtml(formatted.slice(0, -1))}<small class="metric-unit">${formatted.at(-1)}</small>`;
}

export function usageTooltipPosition(anchorX, anchorY, width, height, viewportWidth, viewportHeight) {
  const offset = 14;
  const margin = 8;
  let left = anchorX + offset;
  let top = anchorY + offset;
  if (left + width + margin > viewportWidth) {
    left = anchorX - width - offset;
  }
  if (top + height + margin > viewportHeight) {
    top = anchorY - height - offset;
  }
  return {
    left: Math.min(Math.max(margin, left), Math.max(margin, viewportWidth - width - margin)),
    top: Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - height - margin)),
  };
}

export function normalizeRecentValue(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, "");
  return canonicalRecentValue(value) || normalized;
}

export function parseRecentValue(value) {
  const normalized = normalizeRecentValue(value);
  if (RECENT_SELECTIONS.includes(normalized)) return { named: normalized };
  if (normalized === "半年") {
    return { months: 6 };
  }
  if (normalized === "一年") {
    return { months: 12 };
  }
  const dayMatch = normalized.match(/^([1-9]\d*)天$/);
  if (dayMatch) {
    return { days: Number(dayMatch[1]) };
  }
  const weekMatch = normalized.match(/^([1-9]\d*)周$/);
  if (weekMatch) {
    return { days: Number(weekMatch[1]) * 7 };
  }
  const monthMatch = normalized.match(/^([1-9]\d*)个月$/);
  if (monthMatch) {
    return { months: Number(monthMatch[1]) };
  }
  const yearMatch = normalized.match(/^([1-9]\d*)年$/);
  if (yearMatch) {
    return { months: Number(yearMatch[1]) * 12 };
  }
  return null;
}

export function addCalendarDays(date, days, zone = "local") {
  if (zone !== "local" && zone !== "utc") {
    const parts = calendarParts(date, zone);
    return calendarDate(parts.year, parts.month - 1, parts.day + days, zone);
  }
  const next = new Date(date);
  if (zone === "utc") next.setUTCDate(next.getUTCDate() + days);
  else next.setDate(next.getDate() + days);
  return next;
}

export function nextPresetState(currentState = {}, preset = "today", fallbackPreset) {
  const selected = ["today", "week", "month", "all", "custom", "recent"].includes(preset) ? preset : "today";
  const next = { preset: selected, bucket: selected === "today" ? "hour" : "day" };
  if (isQuotaPreset(currentState.preset, fallbackPreset)) next.lastQuotaPreset = currentState.preset;
  return next;
}

export function nextQuotaPresetState(currentState = {}) {
  const currentPreset = currentState.preset || "today";
  const preferred = QUOTA_PRESETS.includes(currentState.lastQuotaPreset) ? currentState.lastQuotaPreset : "quota_5h";
  const target = isQuotaPreset(currentPreset) ? (currentPreset === "quota_5h" ? "quota_week" : "quota_5h") : preferred;
  return {
    changed: true,
    preset: target,
    bucket: target === "quota_5h" ? "quota_30m" : "quota_24h",
    lastQuotaPreset: target,
    reason: "",
  };
}

export function nextRecentState(_currentState = {}, value = "") {
  const recentValue = normalizeRecentValue(value);
  const parsed = parseRecentValue(recentValue);
  const namedBucket = { 上一个5h: "quota_30m", 上周: "day", 上个月: "day", 今年: "month", 去年: "month" }[recentValue];
  return { preset: "recent", recentValue, bucket: namedBucket || (parsed?.days === 1 ? "hour" : "day") };
}

export function comparisonLabel(range, preset) {
  if (range?.recentValue === "今年") return "较去年同期";
  if (range?.recentValue === "去年") return "较前年";
  if (range?.recentValue === "上个月") return "较上月";
  const mode = range?.quotaPreset || range?.preset || preset;
  return (
    {
      quota_5h: "较上一5h",
      quota_week: "较上一7d",
      today: "较昨日",
      week: "较上周",
      month: "较上月",
      custom: "较上一等长周期",
      recent: "较上一等长周期",
    }[mode] || "暂无对比"
  );
}

export function shortTimelineLabel(key, bucket, range) {
  const text = String(key || "");
  if (bucket === "quota_30m" || bucket === "quota_24h") {
    const timestampMs = Number(text);
    if (!Number.isFinite(timestampMs)) return text;
    const date = new Date(timestampMs);
    if (bucket === "quota_30m") {
      if (isPreviousQuotaRange(range)) {
        const dateText = dateKey(date, rangeCalendarZone(range));
        const crossYear =
          dateKey(asDate(range.start), rangeCalendarZone(range)).slice(0, 4) !==
          dateKey(asDate(range.end), rangeCalendarZone(range)).slice(0, 4);
        const clock = `${String(calendarParts(date, rangeCalendarZone(range)).hour).padStart(2, "0")}:${String(calendarParts(date, rangeCalendarZone(range)).minute).padStart(2, "0")}`;
        return `${crossYear ? dateText : dateText.slice(5)} ${clock}`;
      }
      return `${String(calendarParts(date, rangeCalendarZone(range)).hour).padStart(2, "0")}:${String(calendarParts(date, rangeCalendarZone(range)).minute).padStart(2, "0")}`;
    }
    return getLocale() === "en-US"
      ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][calendarParts(date, rangeCalendarZone(range)).weekday]
      : ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][calendarParts(date, rangeCalendarZone(range)).weekday];
  }
  if (bucket === "hour") {
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):00$/);
    if (!match) return text;
    const start = asDate(range?.start);
    const end = asDate(range?.end);
    const oneDay = start && end && dateKey(start, rangeCalendarZone(range)) === dateKey(end, rangeCalendarZone(range));
    return oneDay ? match[4] : `${match[2]}-${match[3]} ${match[4]}`;
  }
  if (bucket === "month") {
    const monthStart = asDate(range?.start);
    const monthEnd = asDate(range?.end);
    const crossYear =
      monthStart &&
      monthEnd &&
      dateKey(monthStart, rangeCalendarZone(range)).slice(0, 4) !==
        dateKey(monthEnd, rangeCalendarZone(range)).slice(0, 4);
    // 跨年时保留 "2026-09" 全键，同年内缩成 "9月"/"Sep"。
    if (crossYear) return text;
    const month = Number(text.slice(5, 7));
    if (!Number.isFinite(month)) return text;
    return getLocale() === "en-US" ? MONTH_NAMES_EN[month - 1] || text : `${month}月`;
  }
  if (bucket === "day" || bucket === "week") {
    const start = asDate(range?.start);
    const end = asDate(range?.end);
    if (bucket === "day" && range?.preset === "week") {
      const [year, month, day] = text.split("-").map(Number);
      const date = calendarDate(year, month - 1, day, rangeCalendarZone(range));
      return getLocale() === "en-US"
        ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][calendarParts(date, rangeCalendarZone(range)).weekday]
        : ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
            calendarParts(date, rangeCalendarZone(range)).weekday
          ];
    }
    if (bucket === "day" && range?.preset === "month") return text.slice(8, 10);
    if (
      start &&
      end &&
      dateKey(start, rangeCalendarZone(range)).slice(0, 4) !== dateKey(end, rangeCalendarZone(range)).slice(0, 4)
    )
      return text;
    return text.slice(5);
  }
  return text;
}

// 周/月槽直接显示实际覆盖日期，首尾按所选范围裁剪。
export function timelineSlotRangeTitle(row, range) {
  const bucket = range?.bucket;
  const key = String(row?.key || "");
  if ((bucket !== "week" && bucket !== "month") || !key) return null;
  const zone = rangeCalendarZone(range);
  const rangeStart = asDate(range?.start);
  const rangeEnd = asDate(range?.end);
  let first = null;
  let last = null;
  if (bucket === "week") {
    const [year, month, day] = key.split("-").map(Number);
    first = calendarDate(year, month - 1, day, zone);
    last = first ? addCalendarDays(first, 6, zone) : null;
  } else {
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7));
    if (Number.isFinite(year) && Number.isFinite(month)) {
      first = calendarDate(year, month - 1, 1, zone);
      last = calendarDate(year, month, 0, zone);
    }
  }
  if (!first || !last || Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return null;
  const effectiveStart = rangeStart && first < rangeStart ? rangeStart : first;
  const effectiveEnd = rangeEnd && last > rangeEnd ? rangeEnd : last;
  const english = getLocale() === "en-US";
  return `${dateKey(effectiveStart, zone)}${english ? " to " : " 至 "}${dateKey(effectiveEnd, zone)}`;
}

export function timelineAxisLabels(rows, options = {}) {
  if (!rows.length) return [];
  const bucket = options.bucket || "day";
  const range = options.range || {};
  const chartWidth = options.chartWidth || 960;
  const oneDayHourly =
    bucket === "hour" &&
    range.start &&
    range.end &&
    dateKey(asDate(range.start), rangeCalendarZone(range)) === dateKey(asDate(range.end), rangeCalendarZone(range));
  const labels = rows.map((row) => shortTimelineLabel(row.key, bucket, range));
  if (oneDayHourly && chartWidth >= 700) {
    return rows.map((_row, index) => ({ index, label: labels[index] }));
  }
  // 未来槽位不画柱（drawTimeline 跳过 row.future），也不作为刻度候选，月视图才不会标出统计范围外的日期。
  const endKey = range?.end ? dateKey(asDate(range.end), rangeCalendarZone(range)) : null;
  const candidateIndexes = [];
  rows.forEach((row, index) => {
    const isFuture =
      typeof row.future === "boolean"
        ? row.future
        : Boolean(endKey) && CALENDAR_BUCKETS.has(bucket) && String(row.key).slice(0, 10) > endKey;
    if (!isFuture) candidateIndexes.push(index);
  });
  const pool = candidateIndexes.length ? candidateIndexes : rows.map((_row, index) => index);
  const maxLabels = Math.max(1, options.maxLabels || Math.floor(chartWidth / 68));
  // 固定整数步长、末尾锚定：相邻刻度间隔恒定，且最新一天必有标签。
  // 旧的等分四舍五入在除不尽时产生 2/3 天交替间隔，还会整段跳过某天（如 13 天范围恰好丢掉 09-21）。
  const step = Math.max(1, Math.ceil(pool.length / maxLabels));
  const picked = [];
  for (let position = pool.length - 1; position >= 0; position -= step) {
    picked.push(pool[position]);
  }
  return picked.reverse().map((index) => ({ index, label: labels[index] }));
}

function formatExactDelta(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatTokens(value)}`;
}

function previousTokensLabel(comparisonLabel) {
  return (
    {
      较上一5h: "上一5h Tokens",
      较上一7d: "上一7d Tokens",
      较昨日: "昨日 tokens",
      较上周: "上周 tokens",
      较上月: "上月 tokens",
      较上一等长周期: "前一等长区间 tokens",
    }[comparisonLabel] || "上一周期 tokens"
  );
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "—";
  }
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "无基准";
  const sign = percent > 0 ? "+" : "";
  return `${sign}${percent}%`;
}

function comparisonClass(value) {
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

function finiteComparisonNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function comparisonDelta(value) {
  return value === null ? "—" : value === 0 ? "0" : `${value > 0 ? "+" : ""}${renderTokenMetricHtml(value)}`;
}

function comparisonTotal(value) {
  return value === null ? "—" : value === 0 ? "0" : renderTokenMetricHtml(value);
}

function renderUnavailableComparison(label) {
  return `
    <article class="comparison-item flat">
      <span>${escapeHtml(label)}</span>
      <strong>—</strong>
      <small>—</small>
    </article>
    <article class="comparison-item flat">
      <span>同比流速</span>
      <strong>—</strong>
      <small>—</small>
    </article>
    <article class="comparison-item previous-period flat">
      <span>${previousTokensLabel(label)}</span>
      <strong>—</strong>
    </article>
  `;
}

export function renderComparisonHtml(comparison, range, preset) {
  if (
    !comparison ||
    comparison.currentAvailable === false ||
    !comparison.previousRange ||
    finiteComparisonNumber(comparison.previousTotals?.total) === null
  ) {
    const label = comparison?.label || comparisonLabel(range, preset);
    return renderUnavailableComparison(label);
  }
  const totalDelta = finiteComparisonNumber(comparison.totalDelta);
  const averageDelta = finiteComparisonNumber(comparison.averageDelta);
  const previousTotal = finiteComparisonNumber(comparison.previousTotals.total);
  return `
    <article class="comparison-item ${comparisonClass(totalDelta)}">
      <span>${escapeHtml(comparison.label)}</span>
      <strong${totalDelta === null ? "" : ` title="${formatExactDelta(totalDelta)}"`}>${comparisonDelta(totalDelta)}</strong>
      <small>${formatPercent(comparison.percentChange)}</small>
    </article>
    <article class="comparison-item ${comparisonClass(averageDelta)}">
      <span>同比流速</span>
      <strong${averageDelta === null ? "" : ` title="${formatExactDelta(averageDelta)}"`}>${comparisonDelta(averageDelta)}</strong>
      <small>${formatPercent(comparison.averagePercentChange)}</small>
    </article>
    <article class="comparison-item previous-period">
      <span>${previousTokensLabel(comparison.label)}</span>
      <strong title="${formatTokens(previousTotal)}">${comparisonTotal(previousTotal)}</strong>
    </article>
  `;
}

export function timelineTokenAriaLabel(range, mode) {
  const start = range?.start ? dateKey(asDate(range.start), rangeCalendarZone(range)) : "";
  const end = range?.end ? dateKey(asDate(range.end), rangeCalendarZone(range)) : "";
  return getLocale() === "en-US"
    ? `Usage over time, tokens stacked ${mode === "model" ? "by model" : "by source"}${start && end ? `, from ${start} to ${end}` : ""}. Inspect each interval for dates and details.`
    : `时间分布，${mode === "model" ? "按模型" : "按渠道"}堆叠 tokens${start && end ? `，统计范围 ${start} 至 ${end}` : ""}；每个时间槽可查看完整日期和明细`;
}

export function tokenTimelineSeries(mode, options) {
  if (!["channel", "model"].includes(mode)) throw new TypeError(`unsupported timeline mode: ${mode}`);
  const { channelRows, channelColors, modelRows, modelColorsByName, modelColor, channelColor, formatAxis } = options;
  return {
    value: (row) => usageValue(row.total, "total"),
    segments: (row) =>
      (mode === "channel" ? timelineChannelSegments(row, channelRows) : timelineModelSegments(row, modelRows)).map(
        (segment) => ({
          name: segment.name,
          value: usageValue(segment.total, "total"),
          color:
            mode === "channel"
              ? channelColors.get(segment.name) || channelColor
              : modelColorsByName.get(segment.name) || modelColor(segment.name),
        }),
      ),
    sortStacks: mode === "model",
    fallbackBar: mode === "channel",
    formatAxis,
  };
}

// All application state, CSS and edition-specific series arrive explicitly from the caller.
export function drawTimelineCanvas(canvas, rows, options) {
  const { styles, palette, outline, ratio, range, bucket, series, messages, timelineBars, drawnChartBox } = options;
  const context = canvas.getContext("2d");
  canvas.dataset.usageTooltip = "true";
  canvas.dataset.chartAriaLabel = messages.aria;
  canvas.setAttribute?.("aria-label", messages.aria);
  timelineBars.set(canvas, []);
  const fontFamily =
    styles.getPropertyValue("--ui-font-sans").trim() ||
    'Inter, "Noto Sans SC", "Microsoft YaHei UI", "PingFang SC", system-ui, -apple-system, sans-serif';
  const axisFont = `12px ${fontFamily}`;
  const labelFont = `13px ${fontFamily}`;
  const chartLine = styles.getPropertyValue("--chart-line").trim() || palette.line;
  const chartText = styles.getPropertyValue("--chart-text").trim() || palette.text;
  const fallbackColor = styles.getPropertyValue("--blue").trim() || palette.fallback;
  // Measure the CSS box before touching the backing store; do not force a second layout.
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const width = cssWidth * ratio;
  const height = cssHeight * ratio;
  canvas.width = width;
  canvas.height = height;
  context.clearRect(0, 0, width, height);
  context.scale(ratio, ratio);
  drawnChartBox.set(canvas, { width: cssWidth, height: cssHeight });
  const padding = { top: 18, right: 18, bottom: 42, left: 64 };
  const chartWidth = cssWidth - padding.left - padding.right;
  const chartHeight = cssHeight - padding.top - padding.bottom;
  const axisPath = [
    [padding.left, padding.top],
    [padding.left, padding.top + chartHeight],
    [padding.left + chartWidth, padding.top + chartHeight],
  ];
  context.strokeStyle = chartLine;
  context.lineWidth = outline.lineWidth;
  context.beginPath();
  context.moveTo(...axisPath[0]);
  context.lineTo(...axisPath[1]);
  context.lineTo(...axisPath[2]);
  const drawKey = "__codexUsageChartDraw";
  const hadDraw = Object.hasOwn(context, drawKey);
  const previousDraw = hadDraw ? context[drawKey] : undefined;
  try {
    context[drawKey] = { roleId: outline.roleId, points: axisPath };
    context.stroke();
  } finally {
    if (hadDraw) context[drawKey] = previousDraw;
    else delete context[drawKey];
  }
  const drawMessage = (message, replaceAria) => {
    context.fillStyle = chartText;
    context.font = labelFont;
    context.fillText(message, padding.left + 12, padding.top + 28);
    if (replaceAria) {
      canvas.dataset.chartAriaLabel = message;
      canvas.setAttribute?.("aria-label", message);
    }
    timelineBars.set(canvas, []);
  };
  if (!rows.length) {
    drawMessage(messages.empty, messages.emptyAria);
    return;
  }
  if (messages.unavailable) {
    drawMessage(messages.unavailable, true);
    return;
  }
  const values = rows.map(series.value);
  const max = values.reduce((maximum, value) => Math.max(maximum, value), 0);
  const scaleMax = max || 1;
  const slotWidth = chartWidth / Math.max(rows.length, 1);
  const barWidth = Math.min(slotWidth, Math.max(Math.min(1, slotWidth), Math.min(30, slotWidth * 0.72)));
  const bars = [];
  rows.forEach((row, index) => {
    if (row.future) return;
    const value = values[index];
    const barHeight = value > 0 ? Math.max(2, (value / scaleMax) * chartHeight) : 0;
    const slotX = padding.left + index * slotWidth;
    const x = slotX + slotWidth / 2 - barWidth / 2;
    const segments = series.segments(row);
    if (series.sortStacks)
      segments.sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
    let y = padding.top + chartHeight;
    if (series.fallbackBar && value > 0 && !segments.length) {
      context.fillStyle = fallbackColor;
      context.fillRect(x, y - barHeight, barWidth, barHeight);
    }
    for (const segment of segments) {
      if (!(segment.value > 0)) continue;
      const segmentHeight = (segment.value / value) * barHeight;
      y -= segmentHeight;
      context.fillStyle = segment.color;
      context.fillRect(x, y, barWidth, Math.max(0.5, segmentHeight));
    }
    bars.push({ x: slotX, y: padding.top, width: slotWidth, height: chartHeight, row });
  });
  timelineBars.set(canvas, bars);
  context.fillStyle = chartText;
  context.font = axisFont;
  context.textAlign = "right";
  context.fillText(series.formatAxis(max), padding.left - 10, padding.top + 8);
  context.fillText(series.formatAxis(0), padding.left - 10, padding.top + chartHeight);
  context.textAlign = "left";
  const tickTilt = Math.PI / 8;
  context.font = axisFont;
  const tickFootprint = rows.reduce((widest, row) => {
    const width = context.measureText(shortTimelineLabel(row.key, bucket, range)).width;
    return Math.max(widest, width * Math.cos(tickTilt) + 12 * Math.sin(tickTilt));
  }, 0);
  const labels = timelineAxisLabels(rows, {
    bucket,
    range,
    chartWidth,
    maxLabels: Math.max(1, Math.floor(chartWidth / (tickFootprint + 4))),
  });
  for (const label of labels) {
    context.save();
    context.translate(padding.left + label.index * slotWidth + slotWidth / 2, padding.top + chartHeight + 18);
    context.rotate(-tickTilt);
    context.textAlign = "center";
    context.fillText(label.label, 0, 0);
    context.restore();
  }
}
