import { escapeHtml as esc } from "./html-utils.js";
import { SHARE_METRIC_DEFINITIONS, shareMetricParts, shareTokenParts as parts } from "./share-metrics.js";
import { sharePeriodLabel } from "./share-card-data.js";
import { calendarParts, rangeCalendarZone } from "./calendar.js";
export function compactCurrency(amount, currency) {
  if (!Number.isFinite(amount)) return "—";
  const units = ["", "K", "M", "B", "T"];
  let index = 0;
  while (Math.abs(amount) >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index++;
  }
  if (Math.abs(Number(amount.toFixed(index ? 2 : 0))) >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index++;
  }
  return `${currency === "CNY" ? "¥" : "$"}${amount.toFixed(index ? 2 : 0)}${units[index]}`;
}

export function groupTrend(rows) {
  const size = Math.max(1, Math.ceil(rows.length / 7)),
    groups = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    groups.push({
      key: chunk[0].key,
      endKey: chunk.at(-1).key,
      total: chunk.reduce((sum, row) => sum + row.total, 0),
    });
  }
  return groups;
}

function token(value) {
  const [divisor, unit] = value >= 1e12 ? [1e12, "T"] : value >= 1e9 ? [1e9, "B"] : [1e6, "M"];
  return `${(value / divisor).toFixed(2)}${unit}`;
}

function trendDate(key, calendarZone) {
  // Calendar bucket keys already contain the selected wall time; quota keys are epoch milliseconds.
  if (/^\d{4}-\d{2}(?:-\d{2})?(?: \d{2}:\d{2})?$/.test(key))
    return new Date(key.includes(" ") ? `${key.replace(" ", "T")}Z` : key);
  const date = new Date(/^\d{11,}$/.test(key) ? Number(key) : key);
  if (calendarZone === "utc") return date;
  const parts = calendarParts(date, calendarZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
}

function trendHtml(box, data, english) {
  const [x, y, width, height] = box,
    rows = groupTrend(data.charts?.trend || []),
    w = width - 48,
    h = height - 100,
    top = 27,
    bottom = h - 26,
    max = Math.max(0, ...rows.map((row) => row.total)),
    slot = w / Math.max(rows.length, 1),
    barWidth = Math.min(20, slot * 0.46),
    title = english ? "Trend" : "趋势";
  const dateFor = (key) => trendDate(key, rangeCalendarZone(data.range));
  const start = dateFor(rows[0]?.key),
    end = dateFor(rows.at(-1)?.endKey),
    span = end - start;
  const daily =
    rows.length > 1 &&
    span <= 7 * 86400000 &&
    rows.every((row, i) => !i || dateFor(row.key) - dateFor(rows[i - 1].key) === 86400000);
  const dateLabel = (key) => {
    const date = dateFor(key),
      pad = (n) => String(n).padStart(2, "0");
    if (!Number.isFinite(date.getTime())) return String(key).slice(-5);
    if (daily)
      return (english ? ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] : ["日", "一", "二", "三", "四", "五", "六"])[
        date.getUTCDay()
      ];
    if (span >= 32 * 86400000) return `${String(date.getUTCFullYear()).slice(-2)}/${pad(date.getUTCMonth() + 1)}`;
    if (span >= 86400000) return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
    return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  };
  let labels = "";
  if (daily)
    labels = rows
      .map(
        (row, i) => `<text x="${slot * (i + 0.5)}" y="${h - 2}" text-anchor="middle">${esc(dateLabel(row.key))}</text>`,
      )
      .join("");
  else if (rows.length === 1)
    labels = `<text x="${w / 2}" y="${h - 2}" text-anchor="middle">${esc(dateLabel(rows[0].key))}</text>`;
  else if (rows.length > 1)
    labels = `<text x="0" y="${h - 2}">${esc(dateLabel(rows[0].key))}</text><text x="${w}" y="${h - 2}" text-anchor="end">${esc(dateLabel(rows.at(-1).endKey))}</text>`;
  const bars = rows
    .map((row, i) => {
      const barHeight = max > 0 ? (row.total / max) * (bottom - top) : 0;
      return `<rect class="trend-bar" x="${slot * (i + 0.5) - barWidth / 2}" y="${bottom - barHeight}" width="${barWidth}" height="${barHeight}" rx="4" fill="var(--blue)" opacity=".86"><title>${esc(row.key)} — ${esc(row.endKey)}: ${token(row.total)}</title></rect>`;
    })
    .join("");
  const plot = rows.length
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}"><text x="0" y="14">${token(max)}</text><path d="M0 ${bottom}H${w}" stroke="var(--line)" fill="none"/>${bars}${labels}</svg>`
    : `<div class="trend-empty">—</div>`;
  return `<section class="s-panel s-chart compact-chart trend-chart" style="left:${x}px;top:${y}px;width:${width}px;height:${height}px"><div class="s-chart-title"><span>${title}</span></div><div class="s-plot">${plot}</div></section>`;
}

const rect = ([x, y, w, h]) => `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
function chartHtml(kind, box, data, english) {
  if (kind === "trend") return trendHtml(box, data, english);
  let html = "";
  if (kind === "harnesses") {
    const rows = data.charts?.harnesses || [],
      colors = [
        "var(--blue)",
        "color-mix(in srgb,var(--blue) 70%,var(--muted))",
        "color-mix(in srgb,var(--blue) 40%,var(--muted))",
        "var(--muted)",
        "color-mix(in srgb,var(--blue) 65%,var(--ink))",
        "color-mix(in srgb,var(--muted) 75%,var(--ink))",
        "color-mix(in srgb,var(--blue) 35%,var(--ink))",
      ];
    html = rows.length
      ? `<div class="h-distribution"><div class="h-ribbon">${rows.map((r, i) => `<span style="width:${100 * (r.share || 0)}%;background:${colors[i % colors.length]}"></span>`).join("")}</div><div class="h-legend${rows.length > 4 ? " many-sources" : ""}">${rows.map((r, i) => `<div class="h-item"><i style="background:${colors[i % colors.length]}"></i><span class="h-name" title="${esc(r.name)}">${esc(r.name)}</span><span class="h-share">${r.share > 0 && r.share < 0.01 ? "&lt;1" : (100 * (r.share || 0)).toFixed(0)}%</span></div>`).join("")}</div></div>`
      : `<div class="h-empty">—</div>`;
  } else {
    const values = data.charts?.composition || {},
      entries = [
        [english ? "Uncached" : "未缓存输入", values.uncached, "var(--blue)"],
        [english ? "Cache read" : "缓存读取", values.cached, "var(--green)"],
        [english ? "Output" : "输出", values.output, "var(--muted)"],
      ],
      sum = entries.reduce((n, r) => n + (r[1] || 0), 0);
    html = `<div class="s-composition"><div class="s-stack">${entries.map((r) => `<span style="width:${sum > 0 ? ((r[1] || 0) / sum) * 100 : 0}%;background:${r[2]}"></span>`).join("")}</div>${entries.map((r) => `<div class="s-composition-row"><span><i style="background:${r[2]}"></i>${r[0]}</span><span>${parts(sum > 0 ? r[1] : null).join("")}</span></div>`).join("")}</div>`;
  }
  return `<section class="s-panel s-chart compact-chart" style="${rect(box)}"><div class="s-chart-title">${kind === "harnesses" ? "Harness" : english ? "Token composition" : "Token 构成"}</div><div class="s-plot">${html}</div></section>`;
}
export function landscapeCardHtml({ data, english, theme, metrics, showCost, colours, artwork, chart }) {
  const hero = artwork ? [452, 64, 600, 224] : [64, 64, 864, 224],
    plot = artwork ? [1076, 64, 300, 224] : [952, 64, 424, 224],
    metricX = artwork ? 1076 : 952,
    metricWidth = artwork ? 300 : 424,
    rows = data.models.slice(0, 7),
    models = [hero[0], 312, hero[2], 44 + (660 / 7) * rows.length],
    maximum = Math.max(0, ...rows.map((r) => r.total)),
    total = parts(data.totals.total);
  const fee =
    showCost && Number.isFinite(data.cost?.amount)
      ? `<div class="s-fee"><span>${english ? "API estimate" : "API 估算"}</span><b>${compactCurrency(data.cost.amount, data.cost.currency)}</b></div>`
      : "";
  const bars = rows
    .map(
      (r) =>
        `<div class="s-model"><div class="s-model-line"><span class="s-name">${esc(r.name)}</span><span class="s-value">${parts(r.total).join("")}</span></div><div class="s-track"><div class="s-fill" style="width:${maximum > 0 ? (r.total / maximum) * 100 : 0}%"></div></div></div>`,
    )
    .join("");
  const panels = metrics
    .map((id, i) => {
      const meta = SHARE_METRIC_DEFINITIONS.find((m) => m.id === id),
        value = shareMetricParts(id, data.metricValues);
      return `<section class="s-metric s-panel" style="${rect([metricX, [312, 497, 682, 868][i], metricWidth, 148])}"><span class="s-label">${esc(english ? meta.en : meta.zh)}</span><div class="s-readout"><strong>${value[0]}${value[1] ? `<small>${value[1]}</small>` : ""}</strong></div></section>`;
    })
    .join("");
  return `<article class="s-card skin-preview-scope" data-scheme="C3R4" data-preview-theme="${theme}" style="${esc(colours)}" lang="${english ? "en" : "zh-CN"}">${artwork}<section class="s-panel s-hero" style="${rect(hero)}"><div class="s-heading"><span>${english ? "Model Usage" : "模型用量"}</span><span class="s-period">${esc(sharePeriodLabel(data, english))}</span></div><div class="s-value-row"><div class="s-total"><strong>${total[0]}</strong><small>${total[1]}</small></div>${fee}</div></section>${rows.length ? `<section class="s-panel s-models" style="${rect(models)}">${bars}</section>` : ""}${chartHtml(chart, plot, data, english)}${panels}</article>`;
}
