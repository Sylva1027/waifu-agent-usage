import { createFiberLayer } from "./fibers.js";
import { firstPose, lastPose, patches, plate, tile } from "./breeze-patches.js";

const root = document.documentElement;
const paper = document.querySelector("#claude-ambient .claude-paper-left");
const fibers = createFiberLayer(document.querySelector("#claude-ambient .claude-paper-right"));
async function loadAtlas(name, theme) {
  const image = new Image();
  image.src = new URL(`./art/${name}-${theme}.webp`, import.meta.url).href;
  await image.decode();
  return image;
}
const frameMs = 1000 / 12;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const leafPoses = [0, 1, 3, 6, 9, 11, 12, 10, 8, 9, 10, 8, 5, 2, 0, -2, -3, -2, 0, 1, 2, 1, 0];
const foldPoses = [0, 1, 3, 6, 9, 11, 12, 11, 9, 7, 5, 6, 7, 6, 4, 2, 0, -1, -2, -1, 0];
const fiberPoses = [0, 2, 5, 8, 11, 12, 12, 10, 9, 9, 8, 6, 4, 2, 0, -1, -2, -1, 0, 1, 0];
const lastFrame = Math.max(
  fiberPoses.length,
  ...patches.map((p) => p.delay + (p.center ? foldPoses : leafPoses).length),
);
const parts = patches.map((patch, i) => {
  const node = document.createElement("span");
  node.className = "claude-breeze-patch";
  node.style.left = `${(100 * patch.x) / plate.width}%`;
  node.style.top = `${(100 * patch.y) / plate.height}%`;
  node.style.width = `${(100 * tile) / plate.width}%`;
  node.style.height = `${(100 * tile) / plate.height}%`;
  node.style.backgroundSize = `${100 * patches.length}% ${100 * (lastPose - firstPose + 1)}%`;
  node.style.backgroundPositionX = `${(100 * i) / (patches.length - 1)}%`;
  paper.append(node);
  return { node, poses: patch.center ? foldPoses : leafPoses, delay: patch.delay, pose: null };
});

let frame = 0;
let timer = 0;
let deadline = 0;
let remaining = 300;
let ready = false;
let theme = null;
let generation = 0;
let active = false;

function paint() {
  fibers.paint(fiberPoses[frame] ?? 0);
  for (const part of parts) {
    const pose = part.poses[frame - part.delay] ?? 0;
    if (part.pose === pose) continue;
    part.pose = pose;
    part.node.hidden = pose === 0;
    part.node.style.backgroundPositionY = `${(100 * (pose - firstPose)) / (lastPose - firstPose)}%`;
  }
}

function pause() {
  if (!timer) return;
  clearTimeout(timer);
  timer = 0;
  remaining = Math.max(0, deadline - performance.now());
}

function stop() {
  pause();
  active = false;
  frame = 0;
  remaining = 300;
  paint();
}

function requestBreeze() {
  if (active || !theme || reduced.matches || root.dataset.skin !== "claude") return;
  active = true;
  playback();
}

function playback() {
  if (!active || !ready || root.dataset.themeTransition || document.hidden || !document.hasFocus()) {
    pause();
    return;
  }
  if (timer) return;
  deadline = performance.now() + remaining;
  timer = window.setTimeout(() => {
    timer = 0;
    if (++frame >= lastFrame) return stop();
    paint();
    remaining = frameMs;
    playback();
  }, remaining);
}

async function selectTheme(next) {
  const request = ++generation;
  theme = next;
  ready = false;
  pause();
  paper.style.removeProperty("--breeze-atlas");
  fibers.clear();
  if (!next) return stop();
  requestBreeze();
  try {
    const [left, right] = await Promise.all([loadAtlas("breeze", next), loadAtlas("fibers", next).catch(() => null)]);
    if (request !== generation) return;
    if (right) fibers.setAtlas(next, right);
    paper.style.setProperty("--breeze-atlas", `url("${left.src}")`);
    ready = true;
    paint();
    playback();
  } catch {
    if (request === generation) stop();
  }
}

function sync() {
  const next = root.dataset.skin === "claude" ? (root.dataset.theme === "dark" ? "dark" : "light") : null;
  if (next !== theme) selectTheme(next);
  playback();
}

paint();
new MutationObserver(sync).observe(root, {
  attributes: true,
  attributeFilter: ["data-theme", "data-skin", "data-theme-transition"],
});
window.addEventListener("focus", sync);
window.addEventListener("blur", sync);
document.addEventListener("visibilitychange", sync);
document.addEventListener("waifu:achievement-earned", requestBreeze);
reduced.addEventListener("change", () => {
  if (reduced.matches) stop();
});
sync();
