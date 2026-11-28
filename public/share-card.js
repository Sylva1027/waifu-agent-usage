import {
  SHARE_METRIC_DEFINITIONS as SHARE_METRICS,
  shareMetricParts,
  shareTokenParts as tokenParts,
} from "./share-metrics.js";
import { sharePeriodLabel, SHARE_PERIODS } from "./share-card-data.js";
import { escapeHtml } from "./html-utils.js";
import { compactCurrency, landscapeCardHtml } from "./share-landscape.js";

export { SHARE_METRIC_DEFINITIONS as SHARE_METRICS } from "./share-metrics.js";

const resources = new Map();
const stylesUrl = new URL("./styles.css", import.meta.url).href;
const landscapeStylesUrl = new URL("./share-landscape.css", import.meta.url).href;
// Inline the approved mark so standalone exports do not depend on the dialog DOM.
const WATERMARK_HTML = `<div class="share-watermark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21v-3c-4 1-4-2-5-2m13 5v-4c0-1-.4-1.7-1-2 3-.4 6-1.4 6-6a5 5 0 0 0-1.5-3.5c.2-1 .2-2-.5-3-1.5 0-3 1-3.5 1.5a13 13 0 0 0-7 0C8 3.5 6.5 2.5 5 2.5c-.7 1-.7 2-.5 3A5 5 0 0 0 3 9c0 4.6 3 5.6 6 6-.6.3-1 1-1 2" /></svg><span>waifu-usage</span></div>`;

function asDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function resource(url, dataUrl = false) {
  const key = `${dataUrl ? "image" : "text"}:${url}`;
  if (!resources.has(key)) {
    const pending = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error("Could not load share-card resource");
        return dataUrl ? response.blob().then(asDataUrl) : response.text();
      })
      .catch((error) => {
        resources.delete(key);
        throw error;
      });
    resources.set(key, pending);
  }
  return resources.get(key);
}

async function decodedImage(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

function metricHtml(id, english, data) {
  const metric = SHARE_METRICS.find((item) => item.id === id);
  const value = shareMetricParts(id, data.metricValues);
  const unit = value[1] ? `<small${value[1] === "%" ? "" : ' class="p-token-unit"'}>${value[1]}</small>` : "";
  return `<section class="p-metric p-panel"><div class="p-metric-body"><span class="p-label">${english ? metric.en : metric.zh}</span><div class="p-readout"><strong>${value[0]}${unit}</strong></div></div></section>`;
}

/**
 * Render the approved portrait or R04 landscape from the same dashboard snapshot.
 * Palettes and optional artwork come from the caller, so standard releases never
 * import skin modules. cacheHitRate is a fraction; unavailable metrics are null.
 * glassPalette captures Classic's material at click time, including the wallpaper behind the panes.
 */
export async function renderShareCard({
  data,
  locale = "zh-CN",
  theme = "light",
  layout = "portrait",
  chart = "trend",
  metrics = layout === "landscape" ? ["cached", "output", "input", "cacheHit"] : ["cacheHit", "output"],
  showCost = false,
  palette = [],
  glassPalette = null,
  character = null,
  landscapeCharacter = character,
}) {
  if (!data?.totals || !SHARE_PERIODS.includes(data.period)) throw new Error("Unsupported share period");
  if (!["light", "dark"].includes(theme)) throw new Error("Unsupported share theme");
  if (!["portrait", "landscape"].includes(layout)) throw new Error("Unsupported share layout");
  if (!["trend", "harnesses", "composition"].includes(chart)) throw new Error("Unsupported share chart");
  if (
    metrics.length > (layout === "landscape" ? 4 : 2) ||
    new Set(metrics).size !== metrics.length ||
    metrics.some((id) => !SHARE_METRICS.some((metric) => metric.id === id))
  ) {
    throw new Error("Expected different share metrics for the selected layout");
  }
  const english = locale.startsWith("en");
  const period = sharePeriodLabel(data, english);
  if (layout === "landscape") character = landscapeCharacter;
  const [productionCss, art, layoutCss] = await Promise.all([
    resource(stylesUrl),
    character ? resource(character.url, true) : null,
    layout === "landscape" ? resource(landscapeStylesUrl) : CARD_CSS,
  ]);
  const colours = (glassPalette ?? palette).map(([key, value]) => `${key}:${value}`).join(";");
  const total = tokenParts(data.totals.total);
  const rows = data.models.slice(0, 5);
  const maximum = Math.max(0, ...rows.map((row) => row.total));
  const bars = rows
    .map((row) => {
      const value = tokenParts(row.total);
      const width = maximum > 0 ? Math.max(0, (row.total / maximum) * 100) : 0;
      return `<div class="bar-row"><div class="bar-label"><span class="bar-name">${escapeHtml(row.name)}</span><span class="bar-value">${value.join("")}</span></div><div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div></div>`;
    })
    .join("");
  let artwork = "";
  if (character) {
    let image;
    try {
      image = await decodedImage(art);
    } catch (error) {
      // Do not preserve a failed image decode across the user's next attempt.
      resources.delete(`image:${character.url}`);
      throw error;
    }
    const face = character.displayParams;
    // Position visible ink, not transparent canvas margins: head at 72px, feet at 1080px.
    const height = layout === "landscape" ? (1080 - 72) / face.inkHeight : (1180 * face.scale) / 1.0091;
    const width = (image.naturalWidth / image.naturalHeight) * height;
    artwork =
      layout === "landscape"
        ? `<img class="s-character" alt="" src="${escapeHtml(art)}" style="height:${height}px;left:${230 - width * face.face.faceX}px;top:${72 - height * face.inkTop}px"/>`
        : `<div class="p-ornament"><img class="p-character" alt="" src="${escapeHtml(art)}" style="height:${height}px;left:${812.2 - width * face.face.faceX}px"/></div>`;
  }
  const cost = data.cost;
  const heading = english ? "Model Usage" : "模型用量";
  const periodLabel = `<span class="p-period">${escapeHtml(period)}</span>`;
  const fee =
    showCost && Number.isFinite(cost?.amount)
      ? `<div class="p-fee">${english ? "API estimate" : "API 估算"}<span>${compactCurrency(cost.amount, cost.currency)}</span></div>`
      : "";
  const card =
    layout === "landscape"
      ? landscapeCardHtml({ data, english, theme, metrics, showCost, colours, artwork, chart })
      : `<article class="p-card skin-preview-scope${character ? "" : " no-character classic-hybrid"}" data-preview-theme="${theme}" style="${escapeHtml(colours)}" lang="${english ? "en" : "zh-CN"}">${artwork}<section class="p-hero p-panel v05"><div class="p-heading">${heading}</div>${periodLabel}<div class="p-hero-display"><div class="p-number"><strong>${total[0]}</strong><span>${total[1]}</span></div></div>${fee}</section><div class="p-lower"><div class="p-data">${rows.length ? `<section class="p-models p-panel"><div class="p-model-tray">${bars}</div></section>` : ""}${metrics.map((id) => metricHtml(id, english, data)).join("")}</div></div></article>`;
  const cardCss = glassPalette ? layoutCss + GLASS_CSS : SURFACE_CSS + layoutCss;
  const html = `<div xmlns="http://www.w3.org/1999/xhtml"><style>${productionCss}${WATERMARK_CSS}${cardCss}</style>${card.replace("</article>", `${WATERMARK_HTML}</article>`)}</div>`;
  const [width, height] = layout === "landscape" ? [1440, 1080] : [1080, 1440];
  const wrapper = new DOMParser().parseFromString(html, "text/html").body.firstElementChild;
  const xml = new XMLSerializer().serializeToString(wrapper);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${xml}</foreignObject></svg>`;
  const image = await decodedImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable");
  context.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG generation failed"))), "image/png");
  });
}

const WATERMARK_CSS = `
.share-watermark{position:absolute;left:50%;transform:translateX(-50%);z-index:2;display:flex;align-items:center;gap:10px;height:28px;font-size:24px;font-weight:450;line-height:28px;letter-spacing:.15px;white-space:nowrap;color:color-mix(in srgb,var(--muted) 32%,var(--bg));pointer-events:none}
.share-watermark svg{width:28.75px;height:28.75px;flex:none;stroke:currentColor;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}
.p-card .share-watermark,.s-card .share-watermark{bottom:18px}
`;

const SURFACE_CSS = `
.p-panel,.s-panel{background:linear-gradient(135deg,var(--ceramic-top),var(--neo-surface) 45%,var(--ceramic-bottom));box-shadow:14px 18px 36px var(--ceramic-shade),-8px -10px 28px var(--ceramic-light),inset 2px 2px 2px var(--ceramic-rim)}
.p-readout,.s-readout{background:var(--ceramic-well);box-shadow:inset 4px 5px 10px var(--ceramic-shade),inset -1px -1px 2px var(--ceramic-rim)}
.p-card .bar-track,.s-track,.s-stack,.h-ribbon{border:1px solid transparent;background:var(--ceramic-well);box-shadow:inset 3px 4px 7px var(--ceramic-shade),inset -1px -1px 2px var(--ceramic-rim)}
.p-card .bar-fill,.s-fill,.s-stack>span,.h-ribbon>span{box-shadow:inset 0 2px 2px color-mix(in srgb,var(--ceramic-rim) 40%,transparent)}
.v05 .p-hero-display::before,.s-heading::after,.s-chart-title::after{content:"";position:absolute;height:3px;border-radius:3px;background:linear-gradient(to bottom,var(--ceramic-top),var(--ceramic-bottom));box-shadow:0 2px 3px var(--ceramic-shade),inset 0 1px 0 var(--ceramic-rim)}
`;

// The PNG is a separate SVG document. Paint the clicked dashboard's resting material from its captured CSS values.
const GLASS_CSS = `
.p-card, .s-card {
  background-color: var(--glass-wallpaper-base, var(--bg));
  background-image: var(--glass-wallpaper, none);
}
.share-watermark { color: color-mix(in srgb, var(--ink) 38%, transparent); }
.p-panel, .s-panel {
  background: var(--glass-face);
  box-shadow: inset 0 1px 0 var(--glass-rim-light), inset 0 0 0 1px var(--glass-rim-shade),
    0 8px 20px -14px var(--glass-cast);
}
.p-panel::before, .s-panel::before {
  content: "";
  position: absolute;
  top: 0;
  inset-inline: 9%;
  height: 2px;
  background: var(--glass-window-reflection);
}
.p-readout, .s-readout {
  background: var(--glass-table);
  box-shadow: inset 0 0 0 1px var(--glass-rim-shade);
}
.p-card .bar-track, .s-track, .s-stack, .h-ribbon {
  background: var(--glass-well);
  box-shadow: none;
}
.v05 .p-heading { text-shadow: none; }
.v05 .p-hero-display::before, .s-heading::after, .s-chart-title::after {
  content: "";
  position: absolute;
  height: 1px;
  background: var(--glass-divider);
}
`;

const CARD_CSS = `
*{box-sizing:border-box}
.p-period{position:absolute;top:34px;right:36px;font-size:28px;line-height:34px;font-weight:400;color:var(--muted);white-space:nowrap}
.p-card{position:relative;isolation:isolate;overflow:hidden;width:1080px;height:1440px;padding:72px;background:var(--bg);color:var(--ink);font-family:var(--ui-font-sans);font-variant-numeric:lining-nums tabular-nums;display:grid;grid-template-rows:290px 1fr;gap:36px}
.p-ornament{position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:0}.p-character{position:absolute;left:510px;top:355px;height:1180px;width:auto;max-width:none;opacity:.66}
.p-panel{position:relative;z-index:1;border-radius:36px;}
.p-hero{padding:28px}.p-heading{height:46px;line-height:46px;padding-left:8px;font-size:38px;font-weight:550;color:var(--muted)}.p-hero-display{height:176px;margin-top:12px;padding:0 16px;border-radius:24px;display:flex;align-items:center}.p-number{display:flex;align-items:baseline;gap:15px;line-height:1.15;white-space:nowrap}.p-number>strong{font-size:122px;letter-spacing:-4px;font-weight:700}.p-number>span{font-size:58px;font-weight:550;color:var(--muted)}
.p-lower{position:relative;display:grid;grid-template-columns:520px 1fr;gap:36px;min-height:0}.p-data{display:grid;grid-auto-rows:190px;align-content:start;gap:36px;min-height:0}.p-data:has(.p-models){grid-template-rows:auto}.p-models{padding:24px}.p-model-tray{display:grid;grid-auto-rows:94px;min-height:0}.p-card .bar-row{display:flex;flex-direction:column;justify-content:center;gap:0;padding:10px 12px;min-height:0;position:relative;outline:none}.p-card .bar-label{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0;line-height:1.3;margin:0}.p-card .bar-name{font-size:35px;font-weight:600;letter-spacing:-.4px;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto}.p-card .bar-value{font-size:31px;font-weight:550;letter-spacing:-.5px;color:var(--muted);flex:0 0 auto;white-space:nowrap}.p-card .bar-track{width:100%;height:12px;margin-top:10px;flex:0 0 12px;border-radius:99px;overflow:hidden}.p-card .bar-fill{height:100%;border-radius:inherit;background:var(--blue);opacity:.82}
.p-metric{padding:24px}.p-metric-body{height:100%}.p-label{display:block;font-size:32px;line-height:38px;font-weight:500;color:var(--muted)}.p-readout{height:92px;margin-top:12px;padding:0 12px;display:flex;align-items:center;border-radius:20px;}.p-readout>strong{font-size:63px;font-weight:650;letter-spacing:-1.5px;line-height:1.15;white-space:nowrap}.p-readout small{font-size:34px;font-weight:500;color:var(--muted);margin-left:7px;letter-spacing:0}
.v05 .p-heading{color:var(--muted);text-shadow:-1px -1px 1px var(--ceramic-shade),1px 1px 1px var(--ceramic-rim)}.v05 .p-hero-display{position:relative;background:transparent;box-shadow:none;padding-left:8px}.v05 .p-hero-display::before{left:8px;right:8px;top:0}
.p-readout small.p-token-unit{font-size:30px;font-weight:500;margin-left:8px}.p-data,.p-model-tray{grid-template-columns:minmax(0,1fr);min-width:0}.p-models,.bar-row{min-width:0}.p-card.no-character .p-lower{grid-template-columns:minmax(0,1fr)}.classic-hybrid{padding:172px 160px}.classic-hybrid .p-data{grid-template-columns:1fr 1fr;grid-auto-rows:216px}.classic-hybrid .p-models{grid-column:1/-1}.classic-hybrid .p-metric{display:flex;align-items:center}.classic-hybrid .p-metric-body{height:auto;width:100%}
.p-fee{position:absolute;right:36px;bottom:36px;z-index:1;display:flex;flex-direction:column;align-items:flex-end;gap:8px;color:var(--muted);font-size:25px;font-weight:450;line-height:1;white-space:nowrap;text-box-trim:trim-both;text-box-edge:cap alphabetic}.p-fee span{font-size:36px;font-weight:500;letter-spacing:-.02em;text-box-trim:trim-both;text-box-edge:cap alphabetic}
`;
