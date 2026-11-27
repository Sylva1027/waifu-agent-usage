import { patterns } from "./patterns.js";

const layer = document.getElementById("glm-ambient");
const portraits = document.getElementById("skinCharacters");
const root = document.documentElement;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const art = document.createElement("div");
art.className = "glm-bands";

// Heights are the centerlines marked in the dashboard reference, in viewport percent.
const layout = [
  ["upper", "left", 5.3], ["upper", "right", 5.7],
  ["middle", "left", 37.9], ["right-middle", "right", 41.3],
  ["lower", "left", 95.1], ["right-lower", "right", 95.2],
];
const asset = (name) => new URL(name + ".webp", import.meta.url).href;
const active = () => root.dataset.skin === "glm";
const bands = [];
let animations = [];
let pending = false;
let ready = false;
let previousActive = false;

function buildBand([name, side, height]) {
  const { cells, height: sourceHeight } = patterns[name];
  const band = document.createElement("div");
  band.className = "glm-band";
  band.dataset.side = side;
  band.dataset.pattern = name;
  band.style[side] = "0";
  band.style.top = height + "%";
  band.style.aspectRatio = "1600 / " + sourceHeight;
  const mirror = side === "right" && name === "upper";
  if (mirror) band.style.transform = "translateY(-50%) scaleX(-1)";
  for (const part of ["weave", "rail", "led"]) {
    band.style.setProperty("--" + part, `url("${asset(name + "-" + part)}")`);
  }

  const rails = document.createElement("div");
  rails.className = "glm-rails";
  const thread = document.createElement("div");
  thread.className = "glm-running-thread";
  rails.append(thread);

  const lamps = document.createElement("div");
  lamps.className = "glm-lamps";
  const columns = [];
  for (const [left, top, right, bottom] of cells) {
    const lamp = document.createElement("div");
    lamp.className = "glm-lamp";
    Object.assign(lamp.style, {
      left: left / 16 + "%", width: (right - left) / 16 + "%",
      top: top / sourceHeight * 100 + "%", height: (bottom - top) / sourceHeight * 100 + "%",
    });
    lamp.style.setProperty("--cell-x", left / 16 + "cqw");
    lamp.style.setProperty("--cell-y", top / 16 + "cqw");
    lamps.append(lamp);
    // The bounds are ordered across the artwork. Vertically stacked diamonds
    // straddle the same column center and share one envelope.
    let column = columns.at(-1);
    if (!column || column.x < left || column.x >= right) {
      const x = (left + right) / 2;
      column = { x, lamps: [] };
      columns.push(column);
    }
    column.lamps.push(lamp);
  }
  band.append(rails, lamps);
  art.append(band);
  return { thread, columns: mirror ? columns.reverse() : columns, mirror };
}

function alignPortraits() {
  const masks = [];
  if (portraits.dataset.skin === "glm" && Number(getComputedStyle(portraits).opacity) > 0) {
    for (const img of portraits.querySelectorAll('img[data-loaded="1"]')) {
      const { x, y, width, height } = img.getBoundingClientRect();
      if (!width || !height || getComputedStyle(img).visibility !== "visible") continue;
      masks.push(`url("${asset("occlusion-" + img.dataset.view)}") ${x}px ${y}px / ${width}px ${height}px no-repeat add`);
    }
  }
  art.style.mask = masks.length ? ["linear-gradient(white, white) subtract", ...masks].join(", ") : "none";
}

function play() {
  let start = 0;
  const pass = [];
  for (const { thread, columns, mirror } of bands) {
    const duration = 1760;
    const positions = ["translateX(-100%)", "translateX(435%)"];
    if (mirror) positions.reverse();
    pass.push(thread.animate(positions.map(transform => ({ transform })), { delay: start, duration }));
    const beats = columns.map(({ x }, i) => {
      const center = mirror ? 1 - x / 1600 : x / 1600;
      return 0.035 + 0.93 * (center + (i + 0.5) / columns.length) / 2;
    });
    for (const [i, { lamps }] of columns.entries()) {
      const before = i ? (beats[i - 1] + beats[i]) / 2 : 0.035;
      const after = i + 1 < beats.length ? (beats[i] + beats[i + 1]) / 2 : 0.965;
      const timing = { delay: start + before * duration, duration: (after - before) * duration };
      for (const lamp of lamps) {
        pass.push(lamp.animate([
          { opacity: 0, easing: "cubic-bezier(0.29, 0, 0.63, 1)" },
          { opacity: 0.86, offset: 0.47, easing: "cubic-bezier(0.34, 0, 0.52, 1)" },
          { opacity: 0 },
        ], timing));
      }
    }
    start += duration;
  }
  animations = pass;
  Promise.allSettled(pass.map(a => a.finished)).then(() => {
    if (animations === pass) animations = [];
  });
}

function stop() {
  pending = false;
  for (const animation of animations) animation.cancel();
  animations = [];
}

function sync() {
  const enabled = active();
  if (!enabled || reduced.matches) stop();
  else if (!previousActive) pending = true;
  previousActive = enabled;
  if (!enabled || reduced.matches || !ready) return;
  const paused = document.hidden || !document.hasFocus() || root.hasAttribute("data-theme-transition");
  if (pending && !paused) { pending = false; play(); }
  for (const animation of animations) {
    if (paused && animation.playState === "running") animation.pause();
    else if (!paused && animation.playState === "paused") animation.play();
  }
}

new ResizeObserver(alignPortraits).observe(layer);
new MutationObserver(alignPortraits).observe(portraits, {
  attributes: true, childList: true, subtree: true,
  attributeFilter: ["style", "data-loaded", "data-skin", "data-skin-characters", "data-face-centered"],
});
new MutationObserver(sync).observe(root, {
  attributes: true, attributeFilter: ["data-skin", "data-theme", "data-theme-transition"],
});
for (const event of ["focus", "blur"]) window.addEventListener(event, sync);
document.addEventListener("visibilitychange", sync);
reduced.addEventListener("change", sync);
document.addEventListener("waifu:achievement-earned", () => {
  if (!active() || reduced.matches || animations.length) return;
  pending = true;
  sync();
});

sync();
const assets = ["occlusion-front", "occlusion-side", ...Object.keys(patterns).flatMap(
  name => ["weave", "rail", "led"].map(part => name + "-" + part),
)];
await Promise.all(assets.map(name => {
  const image = new Image();
  image.src = asset(name);
  return image.decode();
}));
bands.push(...layout.map(buildBand));
alignPortraits();
layer.append(art);
ready = true;
sync();
