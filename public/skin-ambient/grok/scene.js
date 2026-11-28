import { createLamp } from "./lamp.js";
import { createPawn, pawnSettlesAt } from "./pawn.js";

export function mount({ root, characters }) {
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  const backdrop = document.createElement("div");
  backdrop.id = "grok-ambient";
  backdrop.setAttribute("aria-hidden", "true");
  characters.before(backdrop);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let settled = false;
  let fromRim = false;
  const frameInterval = 1000 / 30;
  let mode = "",
    scene,
    loading,
    active = false;
  let elapsed = 0,
    started = null,
    timer = 0;

  function placeStage() {
    if (!scene) return;
    const { clientWidth: w, clientHeight: h } = backdrop;
    const scale = Math.max(w / 2048, h / 1152);
    const x = (w - 2048 * scale) * 0.5,
      y = (h - 1152 * scale) * 0.08;
    scene.stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  async function build(theme, signal) {
    const stage = document.createElement("div");
    stage.className = "grok-stage";
    stage.hidden = true;
    const artwork = [createPawn(stage, theme, signal)];
    if (theme === "dark") artwork.push(createLamp(stage, signal));
    const results = await Promise.allSettled(artwork);
    const layers = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const destroy = () => {
      stage.remove();
      for (const layer of layers) layer.destroy();
    };
    const failure = results.find((r) => r.status === "rejected");
    if (failure) {
      destroy();
      throw failure.reason;
    }

    return {
      stage,
      destroy,
      paint(seconds) {
        for (const layer of layers) layer.paint(seconds, fromRim);
      },
    };
  }

  function pause() {
    clearTimeout(timer);
    timer = 0;
    if (started !== null) elapsed = performance.now() - started;
    started = null;
  }

  function stop(hold = false, endTime = 0) {
    pause();
    active = false;
    elapsed = 0;
    settled = hold;
    if (scene) {
      if (hold) scene.paint(endTime);
      scene.stage.hidden = !hold;
    }
  }

  function tick() {
    const ms = performance.now() - started;
    const duration = Math.max(6.4, pawnSettlesAt(fromRim));
    if (ms >= duration * 1000) return stop(true, duration);
    scene.paint(ms / 1000);
    scene.stage.hidden = false;
    timer = setTimeout(tick, Math.ceil(frameInterval - (ms % frameInterval)));
  }

  function syncPlayback() {
    if (
      !active ||
      !scene ||
      root.dataset.skin !== "grok" ||
      document.hidden ||
      !document.hasFocus() ||
      root.dataset.themeTransition
    )
      return pause();
    if (started !== null) return;
    started = performance.now() - elapsed;
    tick();
  }

  function requestPass() {
    if (!mode || root.dataset.skin !== "grok" || active || reduced.matches) return;
    fromRim = settled;
    settled = false;
    active = true;
    prepare();
  }

  function prepare() {
    if (scene) return syncPlayback();
    if (loading) return;
    const job = new AbortController();
    loading = job;
    build(mode, job.signal).then(
      (result) => {
        if (loading !== job || root.dataset.skin !== "grok") return result.destroy();
        loading = null;
        scene = result;
        backdrop.append(scene.stage);
        placeStage();
        syncPlayback();
      },
      (error) => {
        if (loading !== job) return;
        loading = null;
        stop();
        console.error("Grok motion artwork failed to load", error);
      },
    );
  }

  function releaseArtwork() {
    loading?.abort();
    loading = null;
    scene?.destroy();
    scene = undefined;
  }

  function syncTheme() {
    const next = root.dataset.theme === "dark" ? "dark" : "light";
    if (next === mode) return syncPlayback();
    pause();
    releaseArtwork();
    mode = next;
    if (reduced.matches) return stop();
    if (active) prepare();
    else requestPass();
  }

  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-theme-transition"] });
  const resizeObserver = new ResizeObserver(placeStage);
  resizeObserver.observe(backdrop);
  for (const event of ["focus", "blur"]) window.addEventListener(event, syncPlayback, { signal });
  document.addEventListener("visibilitychange", syncPlayback, { signal });
  document.addEventListener("waifu:achievement-earned", requestPass, { signal });
  reduced.addEventListener(
    "change",
    () => {
      if (reduced.matches) {
        stop();
        releaseArtwork();
      }
    },
    { signal },
  );

  syncTheme();
  return () => {
    lifecycle.abort();
    themeObserver.disconnect();
    resizeObserver.disconnect();
    stop();
    releaseArtwork();
    backdrop.remove();
  };
}
