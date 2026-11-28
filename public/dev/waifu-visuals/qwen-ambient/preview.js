import { drawLight, loadMaterial, materialBounds } from "./art.js";
import { drawRightLight, loadRightLight, rightLightBounds, rightLightWindow } from "./right-light.js";

const root = document.documentElement;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const sourceSize = 1254;
const frameInterval = 1000 / 12;
const rightStartTime = 6200;
const rightGlideDuration = 7200;
const fadeDuration = 4100;
const fadeStartTime = rightStartTime + rightGlideDuration;
const totalDuration = fadeStartTime + fadeDuration;
const fadeStartPhase = 0.86;
const rightFocusY = 0.62;

const layer = document.createElement("div");
layer.id = "qwen-ambient";
layer.setAttribute("aria-hidden", "true");
const stage = document.createElement("div");
stage.className = "qwen-ambient-left";
const image = document.createElement("img");
image.alt = "";
const rightStage = document.createElement("div");
rightStage.className = "qwen-ambient-right";
const rightImage = document.createElement("img");
rightImage.alt = "";
const canvas = document.createElement("canvas");
const rightCanvas = document.createElement("canvas");
stage.append(image, canvas);
rightStage.append(rightImage, rightCanvas);
layer.append(rightStage, stage);
document.querySelector("#skinCharacters").before(layer);
const ctx = canvas.getContext("2d");
const rightCtx = rightCanvas.getContext("2d");

let mode;
let ready = false;
let material;
let rightMaterial;
let loadVersion = 0;
let phase = 0;
let draws = 0;
let elapsed = 0;
let started = null;
let timer = 0;
let nextTick = 0;
let placement;
let viewport;
let canvasRect;
let rightRect;
let rightCrop;
let drawnPhase;
let drawnRightPhase;

function prepareCanvas(context, { left, top, width, height }) {
  const target = context.canvas;
  context.resetTransform();
  context.clearRect(0, 0, target.width, target.height);
  const scaleX = target.width / width;
  const scaleY = target.height / height;
  context.setTransform(scaleX, 0, 0, scaleY, -left * scaleX, -top * scaleY);
}

function paint() {
  if (!ready || !(canvasRect || rightRect) || drawnPhase === phase) return;
  if (canvasRect) {
    prepareCanvas(ctx, canvasRect);
    if (phase > 0 && phase < 1) drawLight(ctx, material, 0, 0, placement, phase);
  }

  const rightPhase = phase > rightLightWindow.start && phase < rightLightWindow.end ? phase : 0;
  if (rightRect && drawnRightPhase !== rightPhase) {
    rightCanvas.hidden = rightPhase === 0;
    if (rightPhase) {
      prepareCanvas(rightCtx, rightRect);
      drawRightLight(rightCtx, rightMaterial, rightCrop.x, rightCrop.y, rightCrop.width, rightPhase);
    }
    drawnRightPhase = rightPhase;
  }
  drawnPhase = phase;
  layer.dataset.phase = String(phase);
  layer.dataset.draws = String(++draws);
}

function placeCanvas(target, left, top, right, bottom) {
  const width = right - left;
  const height = bottom - top;
  target.hidden = width <= 0 || height <= 0;
  if (target.hidden) return undefined;
  target.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
  target.width = Math.ceil(width * window.devicePixelRatio);
  target.height = Math.ceil(height * window.devicePixelRatio);
  return { left, top, width, height };
}

function layout() {
  if (!ready) return;
  const { clientWidth: width, clientHeight: height } = root;
  const dpr = window.devicePixelRatio;
  if (viewport?.width === width && viewport.height === height && viewport.dpr === dpr) return;
  viewport = { width, height, dpr };
  // Track the binding in source coordinates as the viewport narrows.
  const narrow = Math.min(1, Math.max(0, (1.5 - width / height) / 0.5));
  placement = Math.max(Math.min(width, 760), height * 1.14);
  const x = -placement * (0.07 + narrow * 0.1);
  const y = -placement * (0.07 + narrow * 0.015);
  stage.style.cssText = `left:${x}px;top:${y}px;width:${placement}px;height:${placement}px`;

  const rightStart = Math.min(x + placement * 0.77, width * 0.68);
  const rightWidth = width - rightStart;
  const overlap = Math.min(x + placement - rightStart, rightWidth * 0.7);
  rightStage.style.cssText = `width:${rightWidth}px;--qwen-overlap:${overlap}px;--qwen-right-position:${rightFocusY * 100}%`;
  // Match the image's object-fit cover crop so light stays registered to the fold.
  const rightScale = Math.max(rightWidth / rightImage.naturalWidth, height / rightImage.naturalHeight);
  const rightImageWidth = rightImage.naturalWidth * rightScale;
  const rightX = rightWidth - rightImageWidth;
  const rightY = (height - rightImage.naturalHeight * rightScale) * rightFocusY;
  rightCrop = { x: rightX, y: rightY, width: rightImageWidth };
  rightRect = placeCanvas(
    rightCanvas,
    Math.max(0, rightX + rightLightBounds.left * rightScale),
    Math.max(0, rightY + rightLightBounds.top * rightScale),
    Math.min(rightWidth, rightX + rightLightBounds.right * rightScale),
    Math.min(height, rightY + rightLightBounds.bottom * rightScale),
  );

  const scale = placement / sourceSize;
  canvasRect = placeCanvas(
    canvas,
    Math.max(-x, materialBounds.left * scale),
    Math.max(-y, materialBounds.top * scale),
    Math.min(width - x, materialBounds.right * scale),
    Math.min(height - y, materialBounds.bottom * scale),
  );
  drawnPhase = undefined;
  drawnRightPhase = undefined;
  paint();
}

function canRun() {
  return !reducedMotion.matches && ready && !root.dataset.themeTransition && !document.hidden && document.hasFocus();
}

function freeze() {
  clearTimeout(timer);
  timer = 0;
  if (started !== null) {
    elapsed = Math.min(totalDuration, performance.now() - started);
    started = null;
  }
  layer.dataset.running = "false";
}

function scheduleTick() {
  timer = setTimeout(tick, Math.max(0, Math.ceil(started + nextTick - performance.now())));
}

function tick() {
  timer = 0;
  if (!canRun()) return freeze();
  const time = performance.now() - started;
  if (time < nextTick) return scheduleTick();
  if (time < rightStartTime) {
    phase = (time / rightStartTime) * rightLightWindow.start;
  } else if (time < fadeStartTime) {
    const blend = (time - rightStartTime) / rightGlideDuration;
    phase = rightLightWindow.start + (fadeStartPhase - rightLightWindow.start) * blend;
  } else {
    const blend = Math.min(1, (time - fadeStartTime) / fadeDuration);
    phase = fadeStartPhase + (1 - fadeStartPhase) * blend;
  }
  if (time >= totalDuration) phase = 0;
  paint();
  if (time >= totalDuration) {
    started = performance.now();
    nextTick = frameInterval;
    scheduleTick();
    return;
  }
  nextTick = Math.min(totalDuration, (Math.floor(time / frameInterval) + 1) * frameInterval);
  scheduleTick();
}

function syncPlayback() {
  if (!canRun()) return freeze();
  if (started !== null) return;
  started = performance.now() - elapsed;
  layer.dataset.running = "true";
  scheduleTick();
}

async function syncMaterial() {
  const next = root.dataset.skin === "qwen" ? root.dataset.theme || "light" : "";
  if (mode === next) return syncPlayback();
  mode = next;
  const version = ++loadVersion;
  viewport = undefined;
  ready = false;
  freeze();
  elapsed = nextTick = 0;
  phase = 0;
  layer.hidden = true;
  layer.dataset.mode = mode;
  layer.dataset.phase = "0";
  layer.dataset.draws = String(draws);
  image.removeAttribute("src");
  canvas.width = 0;
  canvas.height = 0;
  rightCanvas.width = 0;
  rightCanvas.height = 0;
  material = undefined;
  rightMaterial = undefined;
  if (!mode) {
    rightImage.removeAttribute("src");
    return;
  }

  try {
    image.src = `/assets/achievement-share/qwen/background-${mode}.webp`;
    rightImage.src = new URL(`./art/right-${mode}.webp`, import.meta.url).href;
    const [loaded, loadedRight] = await Promise.all([
      loadMaterial(mode),
      loadRightLight(mode),
      image.decode(),
      rightImage.decode(),
    ]);
    if (version !== loadVersion) return;
    material = loaded;
    rightMaterial = loadedRight;
    ready = true;
    layout();
    layer.hidden = false;
    syncPlayback();
  } catch (error) {
    if (version !== loadVersion) return;
    console.error("Qwen preview assets failed to load", error);
  }
}

const themeObserver = new MutationObserver(syncMaterial);
themeObserver.observe(root, {
  attributes: true,
  attributeFilter: ["data-skin", "data-theme", "data-theme-transition"],
});
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) {
    freeze();
    elapsed = nextTick = 0;
    phase = 0;
    paint();
  }
  syncPlayback();
});
window.addEventListener("resize", layout, { passive: true });
window.addEventListener("focus", syncPlayback);
window.addEventListener("blur", freeze);
document.addEventListener("visibilitychange", syncPlayback);
window.addEventListener("pagehide", freeze);
window.addEventListener("pageshow", syncPlayback);
void syncMaterial();
