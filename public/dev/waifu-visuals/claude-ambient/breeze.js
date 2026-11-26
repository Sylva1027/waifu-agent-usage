import { createFiberLayer } from "./fibers.js";
import { firstPose, lastPose, patches, plate, tile } from "./breeze-patches.js";

const root = document.documentElement;
const paper = document.querySelector("#claude-ambient .claude-paper-left");
const fibers = createFiberLayer(document.querySelector("#claude-ambient .claude-paper-right"));
const atlases = new Map();
async function loadAtlas(name, theme) {
  const image = new Image();
  image.src = new URL(`./art/${name}-${theme}.webp`, import.meta.url).href;
  await image.decode();
  return image;
}
const frameMs = 1000 / 12;
const restMs = 6500;
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

function canPlay() {
  return ready && !root.dataset.themeTransition && !document.hidden && document.hasFocus();
}

function schedule() {
  deadline = performance.now() + remaining;
  timer = window.setTimeout(() => {
    timer = 0;
    if (!canPlay()) return;
    paint();
    remaining = frame === lastFrame ? restMs : frameMs;
    frame = frame === lastFrame ? 0 : frame + 1;
    schedule();
  }, remaining);
}

function selectTheme(next) {
  theme = next;
  ready = false;
  clearTimeout(timer);
  timer = 0;
  frame = 0;
  remaining = 300;
  paint();
  paper.style.removeProperty("--breeze-atlas");
  if (!next) return;
  if (!atlases.has(next)) {
    const assets = Promise.all([loadAtlas("breeze", next), loadAtlas("fibers", next).catch(() => null)]);
    atlases.set(next, assets);
    assets.catch(() => atlases.delete(next));
  }
  atlases
    .get(next)
    .then(([left, right]) => {
      if (theme !== next) return;
      fibers.setAtlas(next, right);
      paper.style.setProperty("--breeze-atlas", `url("${left.src}")`);
      ready = true;
      sync();
    })
    .catch(() => {});
}

function sync() {
  const next = root.dataset.skin === "claude" ? (root.dataset.theme === "dark" ? "dark" : "light") : null;
  if (next !== theme) selectTheme(next);
  if (timer && !canPlay()) {
    clearTimeout(timer);
    timer = 0;
    remaining = Math.max(0, deadline - performance.now());
  }
  if (canPlay() && !timer) schedule();
}

paint();
new MutationObserver(sync).observe(root, {
  attributes: true,
  attributeFilter: ["data-theme", "data-skin", "data-theme-transition"],
});
window.addEventListener("focus", sync);
window.addEventListener("blur", sync);
document.addEventListener("visibilitychange", sync);
sync();
