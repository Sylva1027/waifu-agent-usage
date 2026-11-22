const byId = (id) => document.getElementById(id);
const grade = byId("grade");
const fps = byId("fps");
const size = byId("size");
const edge = byId("edge");
const tilt = byId("tilt");
const reference = byId("reference");
const fallback = byId("fallback");
const interactive = byId("interactive");
const canvas = byId("badgeCanvas");
const play = byId("play");
const stats = byId("stats");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
const stages = { idle: "静止", playing: "播放中", complete: "已完成", unavailable: "WebGL 不可用" };
let scene,
  requested = 0,
  ready = false,
  unavailable = false;
let pointerTimer = 0,
  pointerLast = 0;
let pointerAngles = [0, 0];
let disposed = false;

function showFallback(message) {
  interactive.dataset.ready = "false";
  byId("previewLabel").textContent = "静态回退";
  stats.textContent = message;
  stats.dataset.state = "unavailable";
  play.disabled = true;
}

function showStats({ state, frames, elapsedMs, intervals, fps: target }) {
  if (state === "unavailable" || unavailable) return;
  const timing =
    intervals?.length && elapsedMs > 0
      ? ` · 平均间隔 ${(intervals.reduce((sum, ms) => sum + ms, 0) / intervals.length).toFixed(1)} ms`
      : "";
  stats.textContent = `${stages[state]} · ${frames} 次渲染 · ${Math.round(elapsedMs)} ms${timing}`;
  stats.dataset.state = state;
  stats.dataset.frames = String(frames);
  stats.dataset.fps = String(target);
}

function cancelPointer() {
  clearTimeout(pointerTimer);
  pointerTimer = 0;
  pointerAngles = [0, 0];
  scene?.setTilt(0, 0);
}

function rest() {
  cancelPointer();
  scene?.preview.stop();
  if (ready && !unavailable && !document.hidden && scene.preview.draw(0)) {
    stats.textContent = "静态预览";
    stats.dataset.state = "idle";
    stats.dataset.frames = "0";
  }
}

async function setBadge() {
  const version = ++requested;
  const level = grade.value;
  ready = false;
  play.disabled = true;
  cancelPointer();
  scene?.preview.stop();
  interactive.dataset.ready = "false";
  byId("previewLabel").textContent = "3D 徽章";
  const url = `../../../assets/achievements/${level === "stone" ? "A69" : "A01"}/${level}.webp`;
  reference.src = url;
  fallback.src = url;
  reference.alt = `${grade.selectedOptions[0].textContent}级原始徽章`;
  const artwork = new Image();
  artwork.src = url;
  try {
    const [{ createBadgePreview }] = await Promise.all([import("./scene.js"), artwork.decode()]);
    if (disposed || version !== requested) return;
    scene ??= createBadgePreview({
      canvas,
      onFrame() {
        interactive.dataset.ready = "true";
        byId("previewLabel").textContent = "3D 徽章";
      },
      onUnavailable() {
        unavailable = true;
        cancelPointer();
        showFallback("WebGL 不可用");
      },
      onStats: showStats,
    });
    if (unavailable) return showFallback("WebGL 不可用");
    scene.setBadge(artwork, level);
    scene.setEdge(edge.value);
    ready = true;
    play.disabled = false;
    rest();
  } catch {
    if (!disposed && version === requested) showFallback("立体预览未载入");
  }
}
grade.addEventListener("change", setBadge);
edge.addEventListener("change", () => {
  scene?.setEdge(edge.value);
  rest();
});
byId("theme").addEventListener("change", (event) => {
  document.documentElement.dataset.theme = event.target.value;
});
byId("locked").addEventListener("change", (event) => {
  document.querySelector(".stage").dataset.locked = String(event.target.checked);
});
size.addEventListener("change", () => {
  document.querySelector(".badge-page").style.setProperty("--badge-size", `${size.value}px`);
  rest();
});
fps.addEventListener("change", rest);
tilt.addEventListener("change", rest);
play.addEventListener("click", () => {
  if (!ready || unavailable || document.hidden) return;
  cancelPointer();
  scene.preview.play({ fps: Number(fps.value), duration: 3000 });
});

interactive.addEventListener("pointermove", (event) => {
  if (
    !ready ||
    unavailable ||
    !tilt.checked ||
    document.hidden ||
    !finePointer.matches ||
    reducedMotion.matches ||
    scene.preview.getStats().state === "playing"
  )
    return;
  const rect = interactive.getBoundingClientRect();
  pointerAngles = [
    ((event.clientY - rect.top) / rect.height - 0.5) * 0.5,
    ((event.clientX - rect.left) / rect.width - 0.5) * 0.7,
  ];
  if (pointerTimer) return;
  pointerTimer = setTimeout(
    () => {
      pointerTimer = 0;
      if (document.hidden || unavailable) return;
      scene.setTilt(...pointerAngles);
      scene.preview.draw(0);
      pointerLast = performance.now();
    },
    Math.max(0, 1000 / Number(fps.value) - (performance.now() - pointerLast)),
  );
});
interactive.addEventListener("pointerleave", () => {
  if (pointerAngles.some((angle) => angle !== 0)) rest();
});
reducedMotion.addEventListener("change", rest);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelPointer();
    scene?.preview.stop();
  } else {
    rest();
  }
});
window.addEventListener("pagehide", (event) => {
  cancelPointer();
  if (event.persisted) scene?.preview.stop();
  else {
    disposed = true;
    scene?.dispose();
  }
});
setBadge();
