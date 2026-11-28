import { createFiberLayer } from "./fibers.js";
import { firstPose, lastPose, patches, plate, tile } from "./breeze-patches.js";

const atlases = {
  light: [
    new URL("./art/breeze-light.webp", import.meta.url).href,
    new URL("./art/fibers-light.webp", import.meta.url).href,
  ],
  dark: [
    new URL("./art/breeze-dark.webp", import.meta.url).href,
    new URL("./art/fibers-dark.webp", import.meta.url).href,
  ],
};
const frameMs = 1000 / 12;
const leafPoses = [0, 1, 3, 6, 9, 11, 12, 10, 8, 9, 10, 8, 5, 2, 0, -2, -3, -2, 0, 1, 2, 1, 0];
const foldPoses = [0, 1, 3, 6, 9, 11, 12, 11, 9, 7, 5, 6, 7, 6, 4, 2, 0, -1, -2, -1, 0];
const fiberPoses = [0, 2, 5, 8, 11, 12, 12, 10, 9, 9, 8, 6, 4, 2, 0, -1, -2, -1, 0, 1, 0];
const lastFrame = Math.max(
  fiberPoses.length,
  ...patches.map((patch) => patch.delay + (patch.center ? foldPoses : leafPoses).length),
);

export function mount({ root, characters }) {
  const events = new AbortController();
  const { signal } = events;
  const scene = document.createElement("div");
  scene.id = "claude-ambient";
  scene.setAttribute("aria-hidden", "true");
  const paper = document.createElement("div");
  paper.className = "claude-paper-left";
  const rightPaper = document.createElement("div");
  rightPaper.className = "claude-paper-right";
  scene.append(paper, rightPaper);
  characters.before(scene);

  const fibers = createFiberLayer(rightPaper);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
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
  let pendingImages = [];
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

  function clearAssets() {
    generation += 1;
    ready = false;
    for (const image of pendingImages) image.removeAttribute("src");
    pendingImages = [];
    paper.style.removeProperty("--breeze-atlas");
    fibers.clear();
  }

  async function selectTheme(next, play = true) {
    theme = next;
    pause();
    clearAssets();
    if (!next || reduced.matches) return stop();
    if (play) requestBreeze();
    const version = generation;
    pendingImages = atlases[next].map((src) => {
      const image = new Image();
      image.src = src;
      return image;
    });
    const [leftAtlas, rightAtlas] = pendingImages;
    try {
      const [, rightReady] = await Promise.all([
        leftAtlas.decode(),
        rightAtlas.decode().then(
          () => true,
          () => false,
        ),
      ]);
      if (version !== generation) return;
      if (rightReady) fibers.setAtlas(next, rightAtlas);
      paper.style.setProperty("--breeze-atlas", `url("${leftAtlas.src}")`);
      ready = true;
      paint();
      playback();
    } catch {
      if (version === generation) stop();
    } finally {
      if (version === generation) pendingImages = [];
    }
  }

  function sync() {
    const next = root.dataset.skin === "claude" ? (root.dataset.theme === "dark" ? "dark" : "light") : null;
    if (next !== theme) void selectTheme(next);
    playback();
  }

  paint();
  const attributes = new MutationObserver(sync);
  attributes.observe(root, {
    attributes: true,
    attributeFilter: ["data-theme", "data-skin", "data-theme-transition"],
  });
  for (const event of ["focus", "blur"]) window.addEventListener(event, sync, { signal });
  document.addEventListener("visibilitychange", sync, { signal });
  document.addEventListener("waifu:achievement-earned", requestBreeze, { signal });
  reduced.addEventListener("change", () => void selectTheme(theme, false), { signal });
  sync();

  return () => {
    events.abort();
    attributes.disconnect();
    stop();
    clearAssets();
    scene.remove();
  };
}
