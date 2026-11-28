import { patterns } from "./patterns.js";

// Heights are the centerlines marked in the dashboard reference, in viewport percent.
const layout = [
  ["upper", "left", 5.3],
  ["upper", "right", 5.7],
  ["middle", "left", 37.9],
  ["right-middle", "right", 41.3],
  ["lower", "left", 95.1],
  ["right-lower", "right", 95.2],
];
const bandAssets = {
  upper: {
    weave: new URL("./upper-weave.webp", import.meta.url).href,
    rail: new URL("./upper-rail.webp", import.meta.url).href,
    led: new URL("./upper-led.webp", import.meta.url).href,
  },
  middle: {
    weave: new URL("./middle-weave.webp", import.meta.url).href,
    rail: new URL("./middle-rail.webp", import.meta.url).href,
    led: new URL("./middle-led.webp", import.meta.url).href,
  },
  lower: {
    weave: new URL("./lower-weave.webp", import.meta.url).href,
    rail: new URL("./lower-rail.webp", import.meta.url).href,
    led: new URL("./lower-led.webp", import.meta.url).href,
  },
  "right-middle": {
    weave: new URL("./right-middle-weave.webp", import.meta.url).href,
    rail: new URL("./right-middle-rail.webp", import.meta.url).href,
    led: new URL("./right-middle-led.webp", import.meta.url).href,
  },
  "right-lower": {
    weave: new URL("./right-lower-weave.webp", import.meta.url).href,
    rail: new URL("./right-lower-rail.webp", import.meta.url).href,
    led: new URL("./right-lower-led.webp", import.meta.url).href,
  },
};
const portraitMasks = {
  front: new URL("./occlusion-front.webp", import.meta.url).href,
  side: new URL("./occlusion-side.webp", import.meta.url).href,
};

export function mount({ root, characters }) {
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const layer = document.createElement("div");
  layer.id = "glm-ambient";
  layer.setAttribute("aria-hidden", "true");
  characters.before(layer);

  const art = document.createElement("div");
  art.className = "glm-bands";
  const bands = [];
  let animations = [];
  let pending = !reduced.matches;
  let theme = root.dataset.theme;
  const resizeObserver = new ResizeObserver(alignPortraits);
  const portraitObserver = new MutationObserver(alignPortraits);
  const themeObserver = new MutationObserver(sync);

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
    for (const [part, url] of Object.entries(bandAssets[name])) {
      band.style.setProperty("--" + part, `url("${url}")`);
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
        left: left / 16 + "%",
        width: (right - left) / 16 + "%",
        top: (top / sourceHeight) * 100 + "%",
        height: ((bottom - top) / sourceHeight) * 100 + "%",
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
    if (!art.isConnected) return;
    const masks = [];
    if (characters.dataset.skin === "glm" && Number(getComputedStyle(characters).opacity) > 0) {
      for (const img of characters.querySelectorAll('img[data-loaded="1"]')) {
        const { x, y, width, height } = img.getBoundingClientRect();
        const mask = portraitMasks[img.dataset.view];
        if (!mask || !width || !height || getComputedStyle(img).visibility !== "visible") continue;
        masks.push(`url("${mask}") ${x}px ${y}px / ${width}px ${height}px no-repeat add`);
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
      pass.push(
        thread.animate(
          positions.map((transform) => ({ transform })),
          { delay: start, duration },
        ),
      );
      const beats = columns.map(({ x }, i) => {
        const center = mirror ? 1 - x / 1600 : x / 1600;
        return 0.035 + (0.93 * (center + (i + 0.5) / columns.length)) / 2;
      });
      for (const [i, { lamps }] of columns.entries()) {
        const before = i ? (beats[i - 1] + beats[i]) / 2 : 0.035;
        const after = i + 1 < beats.length ? (beats[i] + beats[i + 1]) / 2 : 0.965;
        const timing = { delay: start + before * duration, duration: (after - before) * duration };
        for (const lamp of lamps) {
          pass.push(
            lamp.animate(
              [
                { opacity: 0, easing: "cubic-bezier(0.29, 0, 0.63, 1)" },
                { opacity: 0.86, offset: 0.47, easing: "cubic-bezier(0.34, 0, 0.52, 1)" },
                { opacity: 0 },
              ],
              timing,
            ),
          );
        }
      }
      start += duration;
    }
    animations = pass;
    Promise.allSettled(pass.map((a) => a.finished)).then(() => {
      if (animations === pass) animations = [];
    });
  }

  function stop() {
    pending = false;
    for (const animation of animations) animation.cancel();
    animations = [];
  }

  async function mountBands() {
    const assets = [...Object.values(portraitMasks), ...Object.values(bandAssets).flatMap(Object.values)];
    const images = assets.map((src) => {
      const image = new Image();
      image.src = src;
      return image;
    });
    const release = () => {
      for (const image of images) image.removeAttribute("src");
    };
    signal.addEventListener("abort", release, { once: true });
    try {
      await Promise.all(images.map((image) => image.decode()));
    } catch {
      // Retain the jacquard when a required band or portrait mask is unavailable.
      release();
      return;
    } finally {
      signal.removeEventListener("abort", release);
    }
    if (signal.aborted || root.dataset.skin !== "glm") return;
    bands.push(...layout.map(buildBand));
    layer.append(art);
    alignPortraits();
    resizeObserver.observe(layer);
    portraitObserver.observe(characters, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["style", "data-loaded", "data-skin", "data-skin-characters", "data-face-centered"],
    });
    sync();
  }

  function sync() {
    if (theme !== root.dataset.theme) {
      theme = root.dataset.theme;
      stop();
      pending = !reduced.matches;
    }
    if (root.dataset.skin !== "glm" || reduced.matches) return stop();
    if (!bands.length) return;
    const paused = document.hidden || !document.hasFocus() || root.hasAttribute("data-theme-transition");
    if (pending && !paused) {
      pending = false;
      play();
    }
    for (const animation of animations) {
      if (paused && animation.playState === "running") animation.pause();
      else if (!paused && animation.playState === "paused") animation.play();
    }
  }

  themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-theme-transition"] });
  for (const event of ["focus", "blur"]) window.addEventListener(event, sync, { signal });
  document.addEventListener("visibilitychange", sync, { signal });
  reduced.addEventListener("change", sync, { signal });
  document.addEventListener(
    "waifu:achievement-earned",
    () => {
      if (root.dataset.skin !== "glm" || reduced.matches || animations.length) return;
      pending = true;
      sync();
    },
    { signal },
  );

  void mountBands();
  return () => {
    lifecycle.abort();
    stop();
    themeObserver.disconnect();
    resizeObserver.disconnect();
    portraitObserver.disconnect();
    layer.remove();
    art.replaceChildren();
    bands.length = 0;
  };
}
