const canvas = document.querySelector("#noticeCanvas");
const target = document.querySelector("#achievementNotice");
const variant = document.querySelector("#variant");
const theme = document.querySelector("#theme");
const readout = document.querySelector("#renderStats");
const motion = matchMedia("(prefers-reduced-motion: reduce)");
const duration = 2000;
const fps = 12;
let effect,
  preview,
  loading,
  generation = 0;

function onStats({ frames, elapsedMs, intervals, state, fps: selectedFps }) {
  const previous = readout.dataset.state;
  readout.dataset.state = state;
  readout.dataset.frames = String(frames);
  readout.dataset.elapsedMs = String(Math.round(elapsedMs));
  if (state === "playing") {
    if (previous !== "playing") readout.textContent = "播放中";
  } else if (state === "idle" && previous === "playing") {
    canvas.style.opacity = "0";
    readout.textContent = "已停止";
  } else if (state === "complete") {
    canvas.style.opacity = "0";
    const mean = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
    readout.textContent = `目标 ${selectedFps} FPS · 实绘 ${frames} 帧 · ${Math.round(elapsedMs)} ms · 平均帧间隔 ${mean.toFixed(1)} ms`;
  }
}

function unavailable() {
  canvas.style.opacity = "0";
  readout.dataset.state = "unavailable";
  readout.textContent = "已显示静态通知";
}

function configure() {
  effect?.configure({ target, canvas, variant: variant.value, theme: theme.value });
}

function load() {
  if (!loading) {
    loading = Promise.all([import("./scene.js"), import("../preview.js")]).then(
      ([{ createNoticeScene }, { createPreview }]) => {
        effect = createNoticeScene();
        configure();
        preview = createPreview({ canvas, render: effect.render, onStats, onUnavailable: unavailable });
      },
    );
  }
  return loading;
}

function stop() {
  generation++;
  preview?.stop();
  canvas.style.opacity = "0";
}

async function simulate() {
  stop();
  if (motion.matches) {
    readout.dataset.state = "idle";
    readout.textContent = "减少动态效果已开启，显示静态通知";
    return;
  }
  const request = generation;
  try {
    await load();
    if (request !== generation || document.hidden) return;
    configure();
    canvas.style.opacity = "1";
    preview.play({ fps, duration });
  } catch {
    unavailable();
  }
}

document.querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault();
  void simulate();
});
theme.addEventListener("change", () => {
  document.documentElement.dataset.theme = theme.value;
  configure();
});
function changeOptions() {
  stop();
  if (readout.dataset.state === "unavailable") return;
  readout.dataset.state = "idle";
  readout.dataset.frames = "0";
  readout.dataset.elapsedMs = "0";
  readout.textContent = motion.matches ? "减少动态效果已开启，显示静态通知" : "12 FPS · 就绪";
}
variant.addEventListener("change", changeOptions);
const observer = new ResizeObserver(configure);
observer.observe(canvas);
motion.addEventListener("change", () => {
  if (motion.matches) {
    stop();
    readout.dataset.state = "idle";
    readout.textContent = "减少动态效果已开启，显示静态通知";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stop();
  }
});
window.addEventListener("pagehide", (event) => {
  stop();
  if (event.persisted) return;
  observer.disconnect();
  preview?.dispose();
  effect?.dispose();
});
