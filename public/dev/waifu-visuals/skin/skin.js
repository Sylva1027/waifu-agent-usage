import { SKINS, paletteDeclarations, skinFaceTarget, skinVariant } from "../../../skins.js";

import { LABS, logoPlacement } from "./labs.js";

const el = (id) => document.getElementById(id);
const stage = el("stage");
const board = el("board");
const canvas = el("fx");
const art = el("art");
const fallback = el("logo-fallback");
const labName = el("lab-name");
const skin = el("skin");
const theme = el("theme");
const effect = el("effect");
const opacity = el("opacity");
const showCharacters = el("characters");
const parallax = el("parallax");
const play = el("play");
const stop = el("stop");
const fps = el("fps");
const stats = el("stats");
const views = ["side", "front"];
const narrow = matchMedia("(max-width: 720px)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const state = { effect: "lab", logo: null, pointer: { x: 0, y: 0 }, anchors: [] };
let preferredEffect = effect.value;
let readyLogo = null;
let failedLogo = null;
let sequence = 0;
let scene;
let loading;
let unavailable = false;
let visible = true;
let disposed = false;
let pointerTimer = 0;
let refreshFrame = 0;

for (const character of SKINS.filter((item) => !item.isClassic)) skin.add(new Option(character.name, character.id));
skin.value = "deepseek";

function needsFallback() {
  return unavailable || Boolean(state.logo && failedLogo === state.logo);
}

function canDraw() {
  return (
    !disposed &&
    !document.hidden &&
    visible &&
    !narrow.matches &&
    !art.hidden &&
    opacity.valueAsNumber > 0 &&
    state.effect === "lab" &&
    Boolean(state.logo) &&
    !needsFallback() &&
    state.anchors.some(Boolean)
  );
}

function showStats(snapshot) {
  stage.dataset.state = snapshot.state;
  stage.dataset.frames = String(snapshot.frames);
  stop.disabled = snapshot.state !== "playing";
  const motionReady = canDraw() && !reducedMotion.matches && readyLogo === state.logo;
  play.disabled = !motionReady || snapshot.state === "playing";
  parallax.disabled = !motionReady;
  if (needsFallback() && state.effect === "lab" && state.logo) {
    stats.textContent = "静态标识";
  } else if (snapshot.frames) {
    const seconds = snapshot.elapsedMs / 1000;
    const rate = seconds > 0 ? ((snapshot.frames - 1) / seconds).toFixed(1) : "0.0";
    stats.textContent = `${snapshot.frames} 帧 · ${seconds.toFixed(2)} 秒 · ${rate} FPS`;
  } else {
    stats.textContent = reducedMotion.matches ? "减少动态效果 · 静态预览" : "静止";
  }
}

function resetPointer() {
  clearTimeout(pointerTimer);
  pointerTimer = 0;
  state.pointer = { x: 0, y: 0 };
}

function syncFallback() {
  fallback.hidden = !needsFallback() || state.effect !== "lab" || !state.logo || art.hidden || narrow.matches;
  if (fallback.hidden) return;
  if (!fallback.children.length) {
    for (const _view of views) {
      const image = new Image();
      image.alt = "";
      image.addEventListener("load", syncFallback);
      fallback.append(image);
    }
  }
  Array.from(fallback.children).forEach((image, index) => {
    if (image.getAttribute("src") !== state.logo) image.src = state.logo;
    const anchor = state.anchors[index];
    image.hidden = !anchor || !image.complete || image.currentSrc !== state.logo || !image.naturalWidth;
    if (image.hidden) return;
    const box = logoPlacement(
      anchor,
      index,
      art.clientWidth,
      art.clientHeight,
      image.naturalWidth / image.naturalHeight,
    );
    Object.assign(image.style, {
      left: `${box.x}px`,
      bottom: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      opacity: index === 0 ? "0.74" : "0.50",
    });
  });
}

function markUnavailable() {
  unavailable = true;
  canvas.hidden = true;
  syncFallback();
  showStats({ state: "unavailable", frames: 0 });
}

async function drawStatic(retry = true) {
  if (!canDraw()) return;
  const url = state.logo;
  try {
    loading ??= import("./scene.js");
    const { createSkinScene } = await loading;
    if (!canDraw() || url !== state.logo) return;
    scene ??= createSkinScene(canvas, state, showStats, markUnavailable);
    const loaded = await scene.setLogo(url).catch(() => {
      if (canDraw() && url === state.logo) {
        failedLogo = url;
        refresh();
      }
      return false;
    });
    if (!loaded || !canDraw() || url !== state.logo || scene.preview.getStats().state === "playing") return;
    if (scene.preview.draw()) {
      readyLogo = url;
      canvas.hidden = false;
    } else if (retry && canDraw()) {
      // The shared observer may see a restored layer one frame after this page's observer.
      requestAnimationFrame(() => {
        if (url === state.logo) void drawStatic(false);
      });
    }
    showStats({ state: needsFallback() ? "unavailable" : "idle", frames: 0 });
  } catch {
    if (canDraw() && url === state.logo) markUnavailable();
  }
}

function position() {
  const { width, left } = art.getBoundingClientRect();
  const bounds = board.getBoundingClientRect();
  const variant = skinVariant(skin.value, theme.value);
  state.anchors = views.map((view) => {
    const image = el(view);
    if (!image.hasAttribute("data-ready") || !width) return null;
    const size = image.getBoundingClientRect();
    const face = variant.display[view].face;
    const marginCenter = view === "side" ? (bounds.left - left) / 2 : (bounds.right - left + width) / 2;
    const target = skinFaceTarget(face, size.width, width, marginCenter);
    if (target === null) return null;
    image.style.left = `${target}px`;
    const gutterWidth = view === "side" ? bounds.left - left : width - (bounds.right - left);
    return { x: target, height: size.height, gutterWidth };
  });
}

function refresh() {
  refreshFrame = 0;
  resetPointer();
  scene?.preview.stop();
  position();
  if (!canDraw()) readyLogo = null;
  canvas.hidden = !readyLogo || readyLogo !== state.logo;
  syncFallback();
  showStats({ state: needsFallback() ? "unavailable" : "idle", frames: 0 });
  if (canDraw()) void drawStatic();
}

function scheduleRefresh() {
  if (!refreshFrame && !disposed) refreshFrame = requestAnimationFrame(refresh);
}

function selectEffect() {
  const lab = LABS[skin.value];
  state.logo = theme.value === "dark" ? (lab?.darkLogo ?? lab?.logo ?? null) : (lab?.logo ?? null);
  state.effect = state.logo ? preferredEffect : "original";
  effect.querySelector("[value=lab]").disabled = !state.logo;
  effect.value = state.effect;
  labName.textContent = lab?.name ?? "";
  labName.hidden = state.effect !== "lab" || !labName.textContent;
}

function applyArt() {
  const current = ++sequence;
  selectEffect();
  readyLogo = null;
  const variant = skinVariant(skin.value, theme.value);
  const stageTheme = theme.value;
  document.documentElement.dataset.theme = stageTheme;
  for (const [key, value] of paletteDeclarations(skin.value, stageTheme)) stage.style.setProperty(key, value);
  canvas.hidden = true;
  const portraits = views.map((view) => {
    const image = el(view);
    delete image.dataset.ready;
    image.style.setProperty("--scale", variant.display[view].scale);
    image.style.setProperty("--shift", `${-100 * variant.display[view].face.faceX}%`);
    image.src = variant.assets[view];
    return image.decode().then(
      () => image,
      () => null,
    );
  });
  refresh();
  Promise.all(portraits).then((decoded) => {
    if (current !== sequence || disposed) return;
    for (const image of decoded) {
      if (image) image.dataset.ready = "";
    }
    refresh();
  });
}

function updateVisibility() {
  art.hidden = !showCharacters.checked;
  art.style.opacity = String(opacity.valueAsNumber / 100);
  el("opacity-value").value = `${opacity.value}%`;
  refresh();
}

function movePointer(event) {
  if (
    !parallax.checked ||
    readyLogo !== state.logo ||
    reducedMotion.matches ||
    event.pointerType === "touch" ||
    !canDraw() ||
    !scene ||
    scene.preview.getStats().state === "playing"
  )
    return;
  const { left, top, width, height } = stage.getBoundingClientRect();
  state.pointer = { x: (2 * (event.clientX - left)) / width - 1, y: 1 - (2 * (event.clientY - top)) / height };
  if (!pointerTimer) {
    pointerTimer = setTimeout(() => {
      pointerTimer = 0;
      if (canDraw() && scene.preview.getStats().state !== "playing") scene.preview.draw();
    }, 1000 / Number(fps.value));
  }
}

skin.addEventListener("change", applyArt);
theme.addEventListener("change", applyArt);
effect.addEventListener("change", () => {
  preferredEffect = effect.value;
  selectEffect();
  refresh();
});
opacity.addEventListener("input", updateVisibility);
showCharacters.addEventListener("change", updateVisibility);
fps.addEventListener("change", refresh);
parallax.addEventListener("change", refresh);
play.addEventListener("click", () => {
  if (!canDraw() || reducedMotion.matches || readyLogo !== state.logo || !scene) return;
  resetPointer();
  scene.preview.play({ fps: Number(fps.value), duration: 4000 });
});
stop.addEventListener("click", () => scene?.preview.stop());
stage.addEventListener("pointermove", movePointer, { passive: true });
stage.addEventListener("pointerleave", () => {
  if (!parallax.checked || readyLogo !== state.logo || !scene || scene.preview.getStats().state === "playing") return;
  resetPointer();
  if (canDraw()) scene.preview.draw();
});
const observer = new ResizeObserver(scheduleRefresh);
observer.observe(stage);
const visibility = new IntersectionObserver(([entry]) => {
  if (visible === entry.isIntersecting) return;
  visible = entry.isIntersecting;
  refresh();
});
visibility.observe(canvas);
narrow.addEventListener("change", refresh);
reducedMotion.addEventListener("change", refresh);
document.addEventListener("visibilitychange", refresh);
window.addEventListener("pagehide", (event) => {
  resetPointer();
  cancelAnimationFrame(refreshFrame);
  refreshFrame = 0;
  if (event.persisted) return;
  disposed = true;
  observer.disconnect();
  visibility.disconnect();
  scene?.dispose();
});
applyArt();
