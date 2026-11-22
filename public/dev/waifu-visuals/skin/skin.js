import { SKINS, paletteDeclarations, paletteTokens, skinFaceTarget, skinVariant } from "../../../skins.js";

const el = (id) => document.getElementById(id);
const stage = el("stage");
const board = el("board");
const canvas = el("fx");
const art = el("art");
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
const state = { color: "", effect: "halo", pointer: { x: 0, y: 0 }, anchors: [] };
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

function canDraw() {
  return (
    !disposed &&
    !document.hidden &&
    visible &&
    !narrow.matches &&
    !art.hidden &&
    opacity.valueAsNumber > 0 &&
    effect.value !== "original" &&
    !unavailable &&
    state.anchors.some(Boolean)
  );
}

function showStats(snapshot) {
  stage.dataset.state = snapshot.state;
  stage.dataset.frames = String(snapshot.frames);
  stop.disabled = snapshot.state !== "playing";
  play.disabled = !canDraw() || reducedMotion.matches || !scene || snapshot.state === "playing";
  if (unavailable || snapshot.state === "unavailable") {
    stats.textContent = "WebGL 无法使用，已显示原图";
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

function markUnavailable() {
  unavailable = true;
  canvas.hidden = true;
  showStats({ state: "unavailable", frames: 0 });
}

async function drawStatic() {
  if (!canDraw()) return;
  try {
    loading ??= import("./scene.js");
    const { createSkinScene } = await loading;
    if (!canDraw()) return;
    scene ??= createSkinScene(canvas, state, showStats, markUnavailable);
    if (scene.preview.getStats().state === "playing") return;
    canvas.hidden = false;
    scene.preview.draw();
    showStats({ state: unavailable ? "unavailable" : "idle", frames: 0 });
  } catch {
    markUnavailable();
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
    return { x: target, height: size.height };
  });
}

function refresh() {
  refreshFrame = 0;
  resetPointer();
  scene?.preview.stop();
  position();
  canvas.hidden = !canDraw();
  showStats({ state: unavailable ? "unavailable" : "idle", frames: 0 });
  if (canDraw()) void drawStatic();
}

function scheduleRefresh() {
  if (!refreshFrame && !disposed) refreshFrame = requestAnimationFrame(refresh);
}

function applyArt() {
  const current = ++sequence;
  const variant = skinVariant(skin.value, theme.value);
  const stageTheme = theme.value;
  document.documentElement.dataset.theme = stageTheme;
  for (const [key, value] of paletteDeclarations(skin.value, stageTheme)) stage.style.setProperty(key, value);
  state.color = paletteTokens(skin.value, stageTheme).accent;
  canvas.hidden = true;
  for (const view of views) {
    const image = el(view);
    delete image.dataset.ready;
    image.style.setProperty("--scale", variant.display[view].scale);
    image.style.setProperty("--shift", `${-100 * variant.display[view].face.faceX}%`);
    image.src = variant.assets[view];
    image
      .decode()
      .then(() => {
        if (current !== sequence || disposed) return;
        image.dataset.ready = "";
        scheduleRefresh();
      })
      .catch(() => {});
  }
  refresh();
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
  state.effect = effect.value;
  refresh();
});
opacity.addEventListener("input", updateVisibility);
showCharacters.addEventListener("change", updateVisibility);
fps.addEventListener("change", refresh);
parallax.addEventListener("change", refresh);
play.addEventListener("click", () => {
  if (!canDraw() || reducedMotion.matches || !scene) return;
  resetPointer();
  scene.preview.play({ fps: Number(fps.value), duration: 4000 });
});
stop.addEventListener("click", () => scene?.preview.stop());
stage.addEventListener("pointermove", movePointer, { passive: true });
stage.addEventListener("pointerleave", () => {
  if (!parallax.checked || !scene || scene.preview.getStats().state === "playing") return;
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
visibility.observe(stage);
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
