import { isPreviousWeeklyRange, isPreviousQuotaRange } from "./timeline-utils.js";
import { displayRecentValue } from "./locale.js";
import { escapeHtml, safeChartColor } from "./html-utils.js";
import { calendarParts, rangeCalendarZone, dateKey } from "./calendar.js";
export const QUOTA_PRESETS = ["quota_5h", "quota_week"];
export const QUOTA_MODE_LABELS = Object.freeze({ quota_5h: "5 小时限额", quota_week: "本周限额" });
export const formatter = new Intl.NumberFormat("en-US");
export const millionTokenFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export function usageValue(usage, field = "total") {
  return usage?.[field] || 0;
}
export function formatTokens(value) {
  return formatter.format(Math.round(value || 0));
}
export function formatTokenMillions(value) {
  const amount = Number(value || 0);
  const finite = Number.isFinite(amount) ? amount : 0;
  const magnitude = Math.abs(finite);
  const [divisor, unit] =
    magnitude >= 1_000_000_000_000 ? [1e12, "T"] : magnitude >= 1_000_000_000 ? [1e9, "B"] : [1e6, "M"];
  return `${millionTokenFormatter.format(finite / divisor)}${unit}`;
}
export function usageRowName(row) {
  return row?.name || row?.key || "未知";
}
export function displayModelName(value) {
  return String(value || "").toLowerCase();
}
export function usageRowAriaLabel(row, nameOverride = null) {
  return `${nameOverride ?? usageRowName(row)}：${formatTokens(usageValue(row?.total, "total"))} tokens`;
}
export function formatUsageTooltip(row, titleOverride = null, options = {}) {
  const total = row?.total || emptyUsage();
  const tooltipTitle = titleOverride || row?.name || row?.key || "未知";
  const tokenFormat = options.compactTokens ? formatTokenMillions : formatTokens;
  const details = [
    ["总 tokens", tokenFormat(usageValue(total, "total"))],
    ["总输入", tokenFormat(usageValue(total, "input"))],
    ["缓存读取", tokenFormat(usageValue(total, "cached"))],
    ["输出", tokenFormat(usageValue(total, "output"))],
    ["推理输出", tokenFormat(usageValue(total, "reasoning"))],
    ["事件", formatTokens(row?.count || 0)],
    ["会话", formatTokens(row?.sessions || 0)],
  ];
  const channels = row?.channels || [];
  const titleText = options.modelNames === true ? displayModelName(tooltipTitle) : tooltipTitle;
  return `
    <div class="usage-tooltip-title">${escapeHtml(titleText)}</div>
    <div class="usage-tooltip-grid">
      ${details
        .map(
          ([label, value]) => `
            <span class="usage-tooltip-label">${label}</span>
            <span class="usage-tooltip-value">${value}</span>
          `,
        )
        .join("")}
    </div>
    ${
      channels.length
        ? `
          <div class="usage-tooltip-subtitle">渠道</div>
          <div class="usage-tooltip-grid">
            ${channels
              .map(
                (channel) => `
                  <span class="usage-tooltip-label">${escapeHtml(channel.name)}</span>
                  <span class="usage-tooltip-value">${tokenFormat(usageValue(channel.total, "total"))}</span>
                `,
              )
              .join("")}
          </div>
        `
        : ""
    }
  `;
}
export function timelineChannelSegments(row, channelRows = []) {
  const rowChannels = new Map((row?.channels || []).map((channel) => [channel.name, channel]));
  const ordered = [];
  for (const channel of channelRows) {
    const match = rowChannels.get(channel.name);
    if (match) {
      ordered.push(match);
      rowChannels.delete(channel.name);
    }
  }
  ordered.push(...rowChannels.values());
  return ordered;
}
export function isQuotaPreset(preset) {
  return QUOTA_PRESETS.includes(preset);
}
export function formatLocalClock(date, zone = "local") {
  const parts = calendarParts(date, zone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}
export function quotaWindowBounds(range) {
  return {
    start: asDate(range?.windowStart || range?.start),
    end: asDate(range?.windowEndExclusive || range?.end),
  };
}
export function asDate(value) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}
export function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}
export function rangeLabel(summary) {
  const range = summary?.range || {};
  if (isQuotaPreset(range.preset) || range.quotaWindow) {
    const mode = range.quotaPreset || range.preset;
    const label = range.recentValue ? displayRecentValue(range.recentValue) : QUOTA_MODE_LABELS[mode];
    if (range.quotaState !== "available") return `等待${label}数据`;
    const { start, end } = quotaWindowBounds(range);
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return `等待${label}数据`;
    }
    if (isPreviousWeeklyRange(range)) {
      return `${dateKey(start, rangeCalendarZone(range))} 至 ${dateKey(end, rangeCalendarZone(range))} · 仅显示有用量的日期`;
    }
    if (isPreviousQuotaRange(range)) {
      const clock = (date) =>
        `${dateKey(date, rangeCalendarZone(range))} ${String(calendarParts(date, rangeCalendarZone(range)).hour).padStart(2, "0")}:${String(calendarParts(date, rangeCalendarZone(range)).minute).padStart(2, "0")}`;
      return `${clock(start)}–${clock(end)}`;
    }
    const zone = rangeCalendarZone(range);
    if (mode === "quota_week") return `${dateKey(start, zone)} 至 ${dateKey(end, zone)}`;
    const shortStart = dateKey(start, zone).slice(5);
    const shortEnd = dateKey(end, zone).slice(5);
    const startLabel = `${shortStart} ${formatLocalClock(start, zone)}`;
    const endLabel = `${shortEnd} ${formatLocalClock(end, zone)}`;
    return dateKey(start, zone) === dateKey(end, zone)
      ? `${startLabel}–${formatLocalClock(end, zone)}`
      : `${startLabel}–${endLabel}`;
  }
  const start = summary.range.start ? dateKey(asDate(summary.range.start), rangeCalendarZone(range)) : "开始";
  const end = summary.range.end ? dateKey(asDate(summary.range.end), rangeCalendarZone(range)) : "现在";
  // 粒度升档时在副标题明示合并方式，避免"日柱去哪了"的困惑。
  const granularity = range.bucket === "week" ? " · 按周合并" : range.bucket === "month" ? " · 按月合并" : "";
  return `${start} 至 ${end}${rangeCalendarZone(range) === "utc" ? " (UTC)" : ""}${granularity}`;
}
export function renderBarListHtml(rows, colorMap = null, options = {}) {
  // Build escaped HTML in one place so all bar-list render paths stay safe.
  if (!rows.length) {
    return `<div class="empty">没有匹配的用量记录</div>`;
  }
  const modelNames = options.modelNames === true;
  const max = rows[0].total.total || 1;
  return rows
    .map((row) => {
      const width = Math.max(2, (row.total.total / max) * 100);
      const color = colorMap?.get(row.name);
      const fillStyle = `width: ${width}%;${color ? ` background: ${safeChartColor(color)};` : ""}`;
      const rawName = usageRowName(row);
      const displayName = modelNames ? displayModelName(rawName) : rawName;
      const name = escapeHtml(displayName);
      const ariaLabel = escapeHtml(usageRowAriaLabel(row, modelNames ? displayName : null));
      return `
        <div class="bar-row" data-usage-tooltip="true" tabindex="0" aria-label="${ariaLabel}">
          <div class="bar-label">
            <span class="bar-name" title="${name}">${name}</span>
            <span class="bar-value" title="${formatTokens(row.total.total)}">${formatTokenMillions(row.total.total)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="${fillStyle}"></div></div>
        </div>
      `;
    })
    .join("");
}
export const COMPARISON_PERIOD_LABELS = { today: "今日", week: "本周", month: "本月", all: "全部" };
export const COMPARISON_PERIOD_ORDER = ["today", "week", "month", "all"];
export function comparisonPeriodTotal(row, period) {
  const total = Number(row.periods?.[period]?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}
export function comparePeriodComparisonRows(left, right, kind, sort) {
  if (kind === "repository") {
    const gitOrder = Number(right.kind === "git") - Number(left.kind === "git");
    if (gitOrder !== 0) return gitOrder;
  }
  const selectedPeriod = COMPARISON_PERIOD_ORDER.includes(sort?.period) ? sort.period : "today";
  const periods = sort?.showIndicator
    ? [selectedPeriod, ...COMPARISON_PERIOD_ORDER.filter((period) => period !== selectedPeriod)]
    : COMPARISON_PERIOD_ORDER;

  for (const [index, period] of periods.entries()) {
    const leftTotal = comparisonPeriodTotal(left, period);
    const rightTotal = comparisonPeriodTotal(right, period);
    const direction = index === 0 && sort?.showIndicator ? sort.direction : "desc";
    const difference = direction === "asc" ? leftTotal - rightTotal : rightTotal - leftTotal;
    if (difference !== 0) return difference;
  }

  const leftName = comparisonRowName(left.name, kind);
  const rightName = comparisonRowName(right.name, kind);
  const nameOrder = leftName.localeCompare(rightName);
  if (nameOrder !== 0) return nameOrder;
  return String(left.key || "").localeCompare(String(right.key || ""));
}
export function comparisonTokenValueClass(formattedValue) {
  return formattedValue === "0.00M" ? ' class="comparison-total-zero"' : "";
}
export function comparisonMetricHtml(label, value, unavailableTokens, { suffix = "", precision = 0 } = {}) {
  const known = Number(value || 0);
  const missing = Number(unavailableTokens || 0);
  const formatted =
    known === 0 && missing > 0
      ? "明细未提供"
      : precision
        ? `${(known * 100).toFixed(precision)}%`
        : `${formatTokenMillions(known)}${suffix}`;
  const title = precision || (known === 0 && missing > 0) ? "" : ` title="${formatTokens(known)}"`;
  const note = missing > 0 ? `；另有 ${formatTokenMillions(missing)} token 的记录未提供此项` : "";
  return `<div class="comparison-detail-metric"><span>${escapeHtml(label)}</span><strong${comparisonTokenValueClass(formatted)}${title}>${formatted}</strong><small${missing > 0 ? ` title="${formatTokens(missing)}"` : ""}>${missing > 0 ? escapeHtml(note.slice(2)) : ""}</small></div>`;
}
export function renderPeriodDetailHtml(metrics, period) {
  const hitInput = Number(metrics.cacheRateInput || 0);
  const hitRate = hitInput > 0 ? Number(metrics.cacheRateCached || 0) / hitInput : null;
  const partialHitData = Number(metrics.uncachedInputUnavailableTokens || 0) > 0;
  const hitLabel =
    hitRate === null
      ? partialHitData
        ? "明细未提供"
        : "—"
      : `${(hitRate * 100).toFixed(2)}%${partialHitData ? "（已知部分）" : ""}`;
  return `
    <h3 class="comparison-detail-title">${COMPARISON_PERIOD_LABELS[period]}明细</h3>
    <div class="comparison-detail-grid">
      ${comparisonMetricHtml("总 tokens", metrics.total)}
      ${comparisonMetricHtml("总输入", metrics.input, metrics.inputUnavailableTokens)}
      ${comparisonMetricHtml("缓存读取", metrics.cached, metrics.cachedUnavailableTokens)}
      ${comparisonMetricHtml("未命中输入", metrics.uncachedInput, metrics.uncachedInputUnavailableTokens)}
      ${comparisonMetricHtml("输出", metrics.output, metrics.outputUnavailableTokens)}
      ${comparisonMetricHtml("推理输出", metrics.reasoning, metrics.reasoningUnavailableTokens)}
      <div class="comparison-detail-metric"><span>缓存命中率</span><strong>${hitLabel}</strong><small>${partialHitData ? "只按总输入与缓存读取都已知的记录计算" : "缓存读取 ÷ 总输入"}</small></div>
      <div class="comparison-detail-metric"><span>明细不完整记录的总量</span><strong${comparisonTokenValueClass(formatTokenMillions(metrics.unattributedDetailTokens || 0))} title="${formatTokens(metrics.unattributedDetailTokens || 0)}">${formatTokenMillions(metrics.unattributedDetailTokens || 0)}</strong><small>记录总量提示，不与各明细相加</small></div>
      <div class="comparison-detail-metric"><span>字段不一致记录的总量</span><strong${comparisonTokenValueClass(formatTokenMillions(metrics.inconsistentTokens || 0))} title="${formatTokens(metrics.inconsistentTokens || 0)}">${formatTokenMillions(metrics.inconsistentTokens || 0)}</strong><small>涉及总量、输入/输出或缓存关系不一致</small></div>
      <div class="comparison-detail-metric"><span>明细校验差额合计</span><strong${comparisonTokenValueClass(formatTokenMillions(metrics.reconciliationGap || 0))} title="${formatTokens(metrics.reconciliationGap || 0)}">${formatTokenMillions(metrics.reconciliationGap || 0)}</strong><small>各项差额之和，仅作质量提示</small></div>
    </div>
  `;
}
export function filterPeriodComparisonRows(rows = []) {
  return rows.filter((row) => Object.values(row.periods || {}).some((period) => Number(period?.total || 0) > 0));
}
export function comparisonRowName(value, kind) {
  const name = String(value || "");
  if (kind === "model") return displayModelName(name);
  if (kind !== "repository" || !name || name === "Unknown cwd") return name;
  const normalized = name.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || name;
}
export function nextComparisonSort(current, period) {
  if (!current?.showIndicator || current.period !== period) {
    return { period, direction: "desc", showIndicator: true };
  }
  if (current.direction === "desc") {
    return { period, direction: "asc", showIndicator: true };
  }
  return { period: "today", direction: "desc", showIndicator: false };
}
export function renderPeriodComparisonTableHtml(rows = [], options = {}) {
  const kind = options.kind === "repository" ? "repository" : "model";
  const query = String(options.query || "")
    .trim()
    .toLocaleLowerCase();
  const expanded = options.expanded || null;
  const totals = options.totals || null;
  const sort = options.sort || { period: "today", direction: "desc", showIndicator: false };
  const periodKeys = COMPARISON_PERIOD_ORDER;
  const filtered = rows.filter((row) => {
    if (!query) return true;
    return comparisonRowName(row.name, kind).toLocaleLowerCase().includes(query);
  });
  if (!filtered.length) {
    return `<div class="empty">${rows.length ? "没有匹配的用量记录" : "所选时间范围内没有用量"}</div>`;
  }
  const sorted = [...filtered].sort((left, right) => comparePeriodComparisonRows(left, right, kind, sort));
  const body = sorted
    .map((row, index) => {
      const rowId = `${kind}-period-${index}`;
      const displayName = comparisonRowName(row.name, kind);
      const repositoryIcon =
        kind === "repository" && row.kind === "git"
          ? '<svg class="repository-git-icon" viewBox="0 0 16 16" role="img" aria-label="Git 仓库" title="Git 仓库" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5v7m0-3.5h3a3 3 0 0 0 3-3V5.5" /><circle cx="6" cy="3" r="1.5" /><circle cx="6" cy="13" r="1.5" /><circle cx="12" cy="4" r="1.5" /></svg>'
          : "";
      const cells = periodKeys
        .map((period) => {
          const isExpanded = expanded?.kind === kind && expanded?.key === row.key && expanded?.period === period;
          const value = row.periods?.[period]?.total || 0;
          const formattedValue = formatTokenMillions(value);
          const roundedZeroClass = formattedValue === "0.00M" ? " comparison-total-zero" : "";
          return `<td><button class="comparison-total-button${roundedZeroClass}" type="button" data-period-expand data-kind="${kind}" data-key="${escapeHtml(row.key)}" data-period="${period}" aria-expanded="${isExpanded}" ${isExpanded ? `aria-controls="${rowId}-detail"` : ""} title="${formatTokens(value)}">${formattedValue}</button></td>`;
        })
        .join("");
      const isExpanded = expanded?.kind === kind && expanded?.key === row.key;
      const activeMetrics = isExpanded ? row.periods?.[expanded.period] : null;
      return `
      <tr><th scope="row"><span class="comparison-row-name">${repositoryIcon}<span class="comparison-row-label" title="${escapeHtml(displayName)}" aria-label="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span></span></th>${cells}</tr>
      ${activeMetrics ? `<tr class="comparison-detail-row"><td id="${rowId}-detail" colspan="5">${renderPeriodDetailHtml(activeMetrics, expanded.period)}</td></tr>` : ""}
    `;
    })
    .join("");
  const totalsRow = totals
    ? `<tfoot><tr><th scope="row" title="不受搜索筛选影响">全局合计</th>${periodKeys
        .map((period) => {
          const value = totals[period]?.total || 0;
          const formattedValue = formatTokenMillions(value);
          const roundedZeroClass = formattedValue === "0.00M" ? "comparison-total-zero" : "";
          return `<td class="${roundedZeroClass}" title="${formatTokens(value)}">${formattedValue}</td>`;
        })
        .join("")}</tr></tfoot>`
    : "";
  return `
    <div class="comparison-table-frame">
      <div class="comparison-table-scroll">
        <table class="comparison-table">
          <thead><tr><th scope="col">${kind === "repository" ? "仓库" : "模型"}</th>${periodKeys
            .map((period) => {
              const isSorted = sort.showIndicator && sort.period === period;
              const direction = isSorted ? sort.direction : "desc";
              const indicator = isSorted ? (direction === "asc" ? "▲" : "▼") : "";
              const ariaSort = isSorted ? (direction === "asc" ? "ascending" : "descending") : "none";
              const label = COMPARISON_PERIOD_LABELS[period];
              const sortLabel = isSorted ? `${label}，${direction === "asc" ? "正序" : "倒序"}` : `按${label}用量排序`;
              const sortTitle = sort.showIndicator
                ? `当前先按${label}${sort.direction === "asc" ? "正序" : "倒序"}；平手依次按其余周期倒序`
                : "默认排序优先级：今日 → 本周 → 本月 → 全部（各项倒序）";
              const title = kind === "repository" ? `本地 Git 仓库优先；${sortTitle}` : sortTitle;
              return `<th scope="col" aria-sort="${ariaSort}"><button class="comparison-sort-button" type="button" data-comparison-sort data-kind="${kind}" data-period="${period}" aria-label="${sortLabel}" title="${title}"><span>${label}</span><span class="comparison-sort-indicator" aria-hidden="true"${indicator ? "" : " hidden"}>${indicator}</span></button></th>`;
            })
            .join("")}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${totalsRow ? `<div class="comparison-table-footer"><table class="comparison-table comparison-table-foot">${totalsRow}</table></div>` : ""}
    </div>
  `;
}
export function timelineModelSegments(row, modelRows = []) {
  const rowModels = new Map((row?.models || []).map((model) => [model.name, model]));
  const ordered = [];
  for (const model of modelRows) {
    const match = rowModels.get(model.name);
    if (match) {
      ordered.push(match);
      rowModels.delete(model.name);
    }
  }
  ordered.push(...rowModels.values());
  return ordered;
}
