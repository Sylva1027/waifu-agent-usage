const root = document.documentElement;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const characters = document.getElementById("skinCharacters");
const scene = document.createElement("div");
scene.id = "deepseek-ambient";
scene.setAttribute("aria-hidden", "true");
const water = document.createElement("div");
water.className = "deepseek-water";
scene.append(water);
characters.before(scene);

const frameDuration = 1000 / 12;
const riseFrames = 11;
const fallFrames = 16;
const glintDuration = (riseFrames + fallFrames) * frameDuration;
const restDuration = 14_000;

// Start frame, center, size, peak opacity and optional vertical drift for each patch.
const ridge = [
  [1, 0.09, 0.294, 0.22, 0.13, 0.53],
  [3, 0.055, 0.43, 0.21, 0.12, 0.61],
  [9, 0.167, 0.474, 0.24, 0.13, 0.72],
  [16, 0.285, 0.585, 0.23, 0.13, 0.77],
  [23, 0.435, 0.65, 0.25, 0.14, 0.76],
  [30, 0.6, 0.651, 0.27, 0.13, 0.68],
  [37, 0.754, 0.67, 0.25, 0.13, 0.68],
  [45, 0.895, 0.709, 0.23, 0.14, 0.71],
  [37, 0.765, 0.408, 0.18, 0.075, 0.49, -4],
  [45, 0.858, 0.399, 0.2, 0.074, 0.57, -4],
  [50, 0.946, 0.38, 0.15, 0.07, 0.5, -4],
];
const wake = [
  [64, 0.822, 0.659, 0.17, 0.08, 0.37],
  [70, 0.924, 0.663, 0.15, 0.08, 0.32],
];

function makeGlint([start, x, y, width, height, strength, verticalDrift = 3]) {
  const patch = document.createElement("span");
  patch.className = "deepseek-glint";
  patch.style.setProperty("--patch-x", x - width / 2);
  patch.style.setProperty("--patch-y", y - height / 2);
  patch.style.setProperty("--patch-width", `${100 * width}%`);
  patch.style.setProperty("--height", `${100 * height}%`);
  water.append(patch);

  return new Animation(
    new KeyframeEffect(
      patch,
      [
        { opacity: 0, transform: `translate(-5%, ${-verticalDrift}%)`, easing: `steps(${riseFrames}, end)` },
        {
          opacity: strength,
          transform: "translate(0)",
          offset: riseFrames / (riseFrames + fallFrames),
          easing: `steps(${fallFrames}, end)`,
        },
        { opacity: 0, transform: `translate(5%, ${verticalDrift}%)` },
      ],
      { delay: start * frameDuration, duration: glintDuration },
    ),
    document.timeline,
  );
}

const glints = ridge.map(makeGlint);
const afterglints = wake.map(makeGlint);
let mode = "";
let ready = false;
let loadVersion = 0;
let episode = null;
let restTimer = 0;

function stopEpisode() {
  for (const animation of episode ?? []) {
    animation.onfinish = null;
    animation.cancel();
  }
  episode = null;
}

function syncPlayback() {
  if (reducedMotion.matches) {
    clearTimeout(restTimer);
    restTimer = 0;
    stopEpisode();
    return;
  }
  const visible = ready && mode && !root.dataset.themeTransition && !document.hidden && document.hasFocus();
  if (!visible) {
    clearTimeout(restTimer);
    restTimer = 0;
    for (const animation of episode ?? []) {
      if (animation.playState === "running") animation.pause();
    }
    return;
  }
  if (episode) {
    for (const animation of episode) {
      if (animation.playState === "idle" || animation.playState === "paused") animation.play();
    }
  } else if (!restTimer) {
    restTimer = window.setTimeout(() => {
      restTimer = 0;
      requestWave("ambient");
    }, restDuration);
  }
}

function requestWave(reason) {
  // A paused wave still owns the playhead.
  if (reducedMotion.matches || !mode || root.dataset.skin !== "deepseek") return;
  if (episode?.at(-1).playState === "finished") stopEpisode();
  if (episode) return;
  clearTimeout(restTimer);
  restTimer = 0;
  episode = reason === "achievement" ? [...glints, ...afterglints] : glints;
  scene.dataset.trigger = reason;
  const last = episode.at(-1);
  last.onfinish = () => {
    if (last.playState !== "finished") return;
    stopEpisode();
    syncPlayback();
  };
  syncPlayback();
}

async function syncTheme() {
  const next = root.dataset.skin === "deepseek" ? root.dataset.theme || "light" : "";
  if (next === mode) {
    syncPlayback();
    return;
  }
  const previous = mode;
  mode = next;
  const version = ++loadVersion;
  ready = false;
  syncPlayback();
  if (!next) {
    stopEpisode();
    delete scene.dataset.trigger;
    return;
  }

  requestWave(previous ? "theme" : "entry");
  try {
    await Promise.all(
      ["background", "glints"].map((asset) => {
        const image = new Image();
        image.src = new URL(`./art/${asset}-${next}.webp`, import.meta.url).href;
        return image.decode();
      }),
    );
    if (loadVersion !== version) return;
    ready = true;
    syncPlayback();
  } catch {
    if (loadVersion === version) stopEpisode();
  }
}

new MutationObserver(syncTheme).observe(root, {
  attributes: true,
  attributeFilter: ["data-skin", "data-theme", "data-theme-transition"],
});
reducedMotion.addEventListener("change", syncPlayback);
for (const event of ["focus", "blur"]) window.addEventListener(event, syncPlayback);
document.addEventListener("visibilitychange", syncPlayback);
document.addEventListener("waifu:achievement-earned", () => requestWave("achievement"));
syncTheme();
