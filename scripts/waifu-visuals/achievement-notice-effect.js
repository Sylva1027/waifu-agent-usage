import { WebGLRenderer } from "three";
import { createNoticeScene } from "../../public/waifu-notice-scene.js";

const duration = 2000;
const frameMs = 1000 / 12;

export function playAchievementNoticeEffect({ button, canvas, onFinish }) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let renderer;
  let effect;
  let request = 0;
  let start;
  let lastSlot = -1;
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(request);
    canvas.removeEventListener("webglcontextlost", finish);
    effect?.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
  }

  function finish() {
    if (disposed) return;
    dispose();
    onFinish();
  }

  function frame(now) {
    if (document.hidden || motion.matches || button.hidden || !canvas.isConnected) {
      finish();
      return;
    }

    try {
      const elapsed = start === undefined ? 0 : Math.max(0, now - start);
      const slot = Math.floor((elapsed + 0.5) / frameMs);
      const done = elapsed + 0.5 >= duration;
      if (done || slot > lastSlot) {
        lastSlot = slot;
        const { width, height } = canvas.getBoundingClientRect();
        if (width <= 0 || height <= 0) {
          finish();
          return;
        }
        const ratio = Math.min(devicePixelRatio || 1, 2);
        const bufferWidth = Math.round(width * ratio);
        const bufferHeight = Math.round(height * ratio);
        if (bufferWidth !== canvas.width || bufferHeight !== canvas.height) {
          renderer.setSize(bufferWidth, bufferHeight, false);
        }
        effect.configure({ target: button, canvas, variant: "orbit", theme: document.documentElement.dataset.theme });
        effect.render({ renderer, width, height, progress: done ? 1 : elapsed / duration });
        start ??= performance.now();
      }
      if (done) finish();
      else if (!disposed) request = requestAnimationFrame(frame);
    } catch {
      finish();
    }
  }

  request = requestAnimationFrame(() => {
    if (document.hidden || motion.matches || button.hidden || !canvas.isConnected) return finish();
    try {
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
      canvas.addEventListener("webglcontextlost", finish);
      effect = createNoticeScene();
      // Compile before starting the timeline so a cold shader doesn't consume its first frames.
      void effect.prepare(renderer).then(() => {
        if (!disposed) request = requestAnimationFrame(frame);
      }, finish);
    } catch {
      finish();
    }
  });
  return { dispose };
}
