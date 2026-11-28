import { loadScore } from "./score.js";

const root = document.documentElement;
const layer = document.querySelector("#kimi-ambient");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let theme = "";
let score;
let scoreLoad;
let animations = [];
let pendingTime = null;
let generation = 0;

function stop() {
  pendingTime = null;
  for (const animation of animations) animation.cancel();
  animations = [];
}

function layout() {
  score?.layout(layer.clientWidth, layer.clientHeight);
}

function syncPlayback() {
  if (!theme || reduced.matches) return;
  const paused = document.hidden || !document.hasFocus() || root.hasAttribute("data-theme-transition");
  if (pendingTime !== null && score && !paused) {
    animations = score.play();
    for (const animation of animations) animation.currentTime = pendingTime;
    pendingTime = null;
    const current = animations;
    Promise.allSettled(current.map((animation) => animation.finished)).then(() => {
      if (current === animations) animations = [];
    });
  }
  for (const animation of animations) {
    if (paused && animation.playState === "running") animation.pause();
    else if (!paused && animation.playState === "paused") animation.play();
  }
}

function requestPass() {
  if (!theme || !score || reduced.matches || pendingTime !== null || animations.length) return;
  pendingTime = 0;
  syncPlayback();
}

async function syncTheme() {
  const next = root.dataset.skin === "kimi" ? root.dataset.theme || "light" : "";
  if (theme === next) return syncPlayback();
  const version = ++generation;
  // Keep the same beat across a palette change, including while artwork decodes.
  const elapsed = animations.at(-1)?.currentTime ?? pendingTime ?? 0;
  stop();
  theme = next;
  score = undefined;
  layer.replaceChildren();
  if (!theme) {
    scoreLoad = undefined;
    return;
  }
  if (!reduced.matches) pendingTime = elapsed;
  try {
    scoreLoad ??= loadScore();
    const art = await scoreLoad;
    if (version !== generation) return;
    score = art;
    layer.replaceChildren(...art.nodes);
    layout();
    syncPlayback();
  } catch (error) {
    if (generation === version) {
      scoreLoad = undefined;
      stop();
      console.error("Kimi score artwork failed to load", error);
    }
  }
}

const portraits = document.querySelector("#skinCharacters");
const alignPortraitMasks = () => score?.alignPortraitMasks?.();
new ResizeObserver(alignPortraitMasks).observe(portraits);
new MutationObserver(alignPortraitMasks).observe(portraits, {
  attributes: true,
  childList: true,
  subtree: true,
  attributeFilter: ["style", "data-loaded", "data-skin", "data-skin-characters"],
});
new ResizeObserver(layout).observe(layer);
new MutationObserver(syncTheme).observe(root, {
  attributes: true,
  attributeFilter: ["data-theme", "data-skin", "data-theme-transition"],
});
for (const event of ["focus", "blur"]) window.addEventListener(event, syncPlayback);
document.addEventListener("visibilitychange", syncPlayback);
document.addEventListener("waifu:achievement-earned", requestPass);
reduced.addEventListener("change", () => {
  if (reduced.matches) stop();
});
syncTheme();
