import { WebGLRenderer } from "./three.js";

let renderer;
let previews = 0;

function getRenderer() {
  renderer ??= new WebGLRenderer({ alpha: true, antialias: true });
  return renderer;
}

export function createPreview({ canvas, render, onStats = () => {}, onUnavailable = () => {} }) {
  const layer = canvas.getContext("2d");
  let request = 0;
  let state = "idle";
  let fps = 0;
  let frames = 0;
  let elapsedMs = 0;
  let intervals = [];
  let disposed = false;
  let visible = true;
  let engine;
  previews += 1;

  function getStats() {
    return { frames, elapsedMs, intervals: [...intervals], state, fps };
  }

  function report() {
    onStats(getStats());
  }

  function cancel() {
    cancelAnimationFrame(request);
    request = 0;
  }

  function unavailable(error) {
    cancel();
    state = "unavailable";
    onUnavailable(error);
    report();
  }

  function contextLost() {
    layer?.clearRect(0, 0, canvas.width, canvas.height);
    unavailable(new Error("WebGL context lost"));
  }

  function draw(progress = 0) {
    if (disposed || state === "unavailable" || document.hidden || !visible) return false;
    const { width, height } = canvas.getBoundingClientRect();
    if (width <= 0 || height <= 0) return false;
    try {
      if (!layer) throw new Error("Canvas 2D is unavailable");
      if (!engine) {
        engine = getRenderer();
        engine.domElement.addEventListener("webglcontextlost", contextLost);
      }
      const pixelRatio = Math.min(devicePixelRatio || 1, 2);
      const bufferWidth = Math.max(1, Math.round(width * pixelRatio));
      const bufferHeight = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== bufferWidth) canvas.width = bufferWidth;
      if (canvas.height !== bufferHeight) canvas.height = bufferHeight;
      if (engine.domElement.width !== bufferWidth || engine.domElement.height !== bufferHeight) {
        engine.setSize(bufferWidth, bufferHeight, false);
      }
      render({ renderer: engine, progress, width, height });
      layer.clearRect(0, 0, bufferWidth, bufferHeight);
      layer.drawImage(engine.domElement, 0, 0);
      return true;
    } catch (error) {
      unavailable(error);
      return false;
    }
  }

  function stop() {
    cancel();
    if (state === "playing") {
      state = "idle";
      report();
    }
  }

  function play({ fps: target, duration }) {
    stop();
    if (disposed || state === "unavailable" || document.hidden || !visible) return;
    if (![12, 15, 30].includes(target) || !Number.isFinite(duration) || duration <= 0) {
      throw new RangeError("Expected 12, 15 or 30 FPS and a positive duration in milliseconds");
    }
    fps = target;
    frames = 0;
    elapsedMs = 0;
    intervals = [];
    state = "playing";
    const interval = 1000 / target;
    let start;
    let lastDraw;
    let previousSlot = -1;

    function tick(timestamp) {
      request = 0;
      start ??= timestamp;
      const elapsed = timestamp - start;
      // A small tolerance absorbs timestamp rounding when the refresh rate is a multiple of the target.
      const slot = Math.floor((elapsed + 0.5) / interval);
      const done = elapsed + 0.5 >= duration;
      if (done || slot > previousSlot) {
        previousSlot = slot;
        if (!draw(done ? 1 : elapsed / duration)) {
          stop();
          return;
        }
        if (lastDraw !== undefined) intervals.push(timestamp - lastDraw);
        lastDraw = timestamp;
        elapsedMs = elapsed;
        frames += 1;
        if (done) state = "complete";
        report();
      }
      if (state === "playing") request = requestAnimationFrame(tick);
    }

    report();
    request = requestAnimationFrame(tick);
  }

  function onVisibilityChange() {
    if (document.hidden) stop();
  }

  function onPageHide(event) {
    if (event.persisted) stop();
    else dispose();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel();
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    engine?.domElement.removeEventListener("webglcontextlost", contextLost);
    previews -= 1;
    if (previews === 0 && renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
      renderer = undefined;
    }
  }

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (!visible) stop();
  });
  observer.observe(canvas);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  return { draw, play, stop, dispose, getStats };
}
