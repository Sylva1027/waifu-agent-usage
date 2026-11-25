import { drawLight, loadMaterial, materialBounds } from "./art.js";

const root = document.documentElement;
const sourceSize = 1254;
const sweepDuration = 7200;
const holdDuration = 1000;
const returnDuration = 2700;
const totalDuration = sweepDuration + holdDuration + returnDuration;
const turn = 0.72;

const layer = document.createElement("div");
layer.id = "qwen-ambient";
layer.setAttribute("aria-hidden", "true");
const stage = document.createElement("div");
const image = document.createElement("img");
image.alt = "";
const canvas = document.createElement("canvas");
stage.append(image, canvas);
layer.append(stage);
document.querySelector("#skinCharacters").before(layer);
const ctx = canvas.getContext("2d");

const controls = document.createElement("details");
controls.id = "qwen-ambient-controls";
controls.innerHTML = "<summary>Qwen 光照对照</summary>";
controls.insertAdjacentHTML(
  "beforeend",
  '<div class="qwen-ambient-actions" role="group" aria-label="固定光位">' +
    '<button type="button" id="qwen-ambient-original" data-phase="0">原图</button>' +
    '<button type="button" id="qwen-ambient-entry" data-phase="0.24">织纹</button>' +
    '<button type="button" id="qwen-ambient-satin" data-phase="0.46">素缎</button>' +
    '<button type="button" id="qwen-ambient-jacquard" data-phase="0.72">暗花</button>' +
    "</div>" +
    '<div class="qwen-ambient-actions">' +
    '<button type="button" id="qwen-ambient-play">播放转光</button>' +
    '<label>更新频率 <select id="qwen-ambient-fps"><option>12</option><option selected>15</option><option>30</option></select> FPS</label>' +
    "</div>",
);
document.body.append(controls);

const poses = Array.from(controls.querySelectorAll("button[data-phase]"));
const play = controls.querySelector("#qwen-ambient-play");
const fps = controls.querySelector("#qwen-ambient-fps");
let mode;
let ready = false;
let material;
let loadVersion = 0;
let active = false;
let phase = 0;
let draws = 0;
let elapsed = 0;
let started = null;
let timer = 0;
let nextTick = 0;
let placement;
let canvasRect;
let drawnPhase;

function paint() {
  if (!ready || !canvasRect || drawnPhase === phase) return;
  const { left, top, width, height } = canvasRect;
  ctx.resetTransform();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (phase > 0 && phase < 1) {
    const scaleX = canvas.width / width;
    const scaleY = canvas.height / height;
    ctx.setTransform(scaleX, 0, 0, scaleY, -left * scaleX, -top * scaleY);
    drawLight(ctx, material, 0, 0, placement, phase);
  }
  drawnPhase = phase;
  layer.dataset.phase = String(phase);
  layer.dataset.draws = String(++draws);
}

function layout() {
  if (!ready) return;
  const { clientWidth: width, clientHeight: height } = root;
  // Track the binding in source coordinates as the viewport narrows.
  const narrow = Math.min(1, Math.max(0, (1.5 - width / height) / 0.5));
  placement = Math.max(Math.min(width, 760), height * 1.14);
  const x = -placement * (0.07 + narrow * 0.1);
  const y = -placement * (0.07 + narrow * 0.015);
  stage.style.cssText = `left:${x}px;top:${y}px;width:${placement}px;height:${placement}px`;

  const scale = placement / sourceSize;
  const left = Math.max(-x, materialBounds.left * scale);
  const top = Math.max(-y, materialBounds.top * scale);
  const right = Math.min(width - x, materialBounds.right * scale);
  const bottom = Math.min(height - y, materialBounds.bottom * scale);
  const patchWidth = right - left;
  const patchHeight = bottom - top;
  if (patchWidth <= 0 || patchHeight <= 0) {
    canvas.hidden = true;
    canvasRect = undefined;
    return;
  }
  canvas.hidden = false;
  canvasRect = { left, top, width: patchWidth, height: patchHeight };
  canvas.style.cssText = `left:${left}px;top:${top}px;width:${patchWidth}px;height:${patchHeight}px`;
  canvas.width = Math.ceil(patchWidth * window.devicePixelRatio);
  canvas.height = Math.ceil(patchHeight * window.devicePixelRatio);
  drawnPhase = undefined;
  paint();
}

function canRun() {
  return active && ready && !document.hidden && document.hasFocus();
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

function showControls() {
  const unavailable = !ready;
  play.disabled = unavailable;
  play.textContent = active ? "停止播放" : "播放转光";
  for (const pose of poses) {
    pose.disabled = unavailable;
    pose.setAttribute("aria-pressed", String(!active && phase === Number(pose.dataset.phase)));
  }
}

function scheduleTick() {
  timer = setTimeout(tick, Math.max(0, Math.ceil(started + nextTick - performance.now())));
}

function tick() {
  timer = 0;
  if (!canRun()) return freeze();
  const time = performance.now() - started;
  if (time < nextTick) return scheduleTick();
  const turnEnd = sweepDuration + holdDuration;
  phase = time < sweepDuration ? (time / sweepDuration) * turn : turn;
  if (time > turnEnd) {
    const blend = Math.min(1, (time - turnEnd) / returnDuration);
    phase = turn + (1 - turn) * blend;
  }
  if (time >= totalDuration) phase = 0;
  paint();
  if (time >= totalDuration) {
    active = false;
    freeze();
    showControls();
    return;
  }
  const interval = 1000 / Number(fps.value);
  // Sleep through the hold, then draw at the selected cadence.
  nextTick =
    time >= sweepDuration && time < turnEnd
      ? turnEnd
      : Math.min(totalDuration, (Math.floor(time / interval) + 1) * interval);
  scheduleTick();
}

function syncPlayback() {
  if (!canRun()) return freeze();
  if (started !== null) return;
  started = performance.now() - elapsed;
  layer.dataset.running = "true";
  scheduleTick();
}

for (const pose of poses) {
  pose.addEventListener("click", () => {
    active = false;
    freeze();
    phase = Number(pose.dataset.phase);
    paint();
    showControls();
  });
}

play.addEventListener("click", () => {
  active = !active;
  if (active) {
    elapsed = 0;
    nextTick = 0;
    phase = 0;
    paint();
  }
  syncPlayback();
  showControls();
});

async function syncMaterial() {
  const next = root.dataset.skin === "qwen" ? root.dataset.theme || "light" : "";
  if (mode === next) return;
  mode = next;
  const version = ++loadVersion;
  ready = false;
  active = false;
  freeze();
  phase = 0;
  layer.hidden = true;
  layer.dataset.mode = mode;
  layer.dataset.phase = "0";
  layer.dataset.draws = String(draws);
  controls.hidden = !mode;
  controls.removeAttribute("data-unavailable");
  image.removeAttribute("src");
  canvas.width = 0;
  canvas.height = 0;
  material = undefined;
  showControls();
  if (!mode) return;

  try {
    image.src = `/assets/achievement-share/qwen/background-${mode}.webp`;
    const [loaded] = await Promise.all([loadMaterial(mode), image.decode()]);
    if (version !== loadVersion) return;
    material = loaded;
    ready = true;
    layout();
    layer.hidden = false;
    showControls();
  } catch (error) {
    if (version !== loadVersion) return;
    controls.dataset.unavailable = "true";
    console.error("Qwen preview assets failed to load", error);
  }
}

const themeObserver = new MutationObserver(syncMaterial);
themeObserver.observe(root, { attributes: true, attributeFilter: ["data-skin", "data-theme"] });
window.addEventListener("resize", layout, { passive: true });
window.addEventListener("focus", syncPlayback);
window.addEventListener("blur", freeze);
document.addEventListener("visibilitychange", syncPlayback);
window.addEventListener("pagehide", freeze);
window.addEventListener("pageshow", syncPlayback);
void syncMaterial();
