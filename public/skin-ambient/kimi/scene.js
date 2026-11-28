import { loadScore } from "./score.js";

export function mount({ root, characters }) {
  const layer = document.createElement("div");
  layer.id = "kimi-ambient";
  layer.setAttribute("aria-hidden", "true");
  characters.before(layer);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const listeners = new AbortController();
  const { signal } = listeners;
  const options = { signal };
  let theme = "";
  let score;
  let scoreLoad;
  let animations = [];
  let pendingTime = null;
  let generation = 0;

  function stop() {
    pendingTime = null;
    for (const animation of animations) animation.cancel();
    animations = [];
  }

  function layout() {
    score?.layout(layer.clientWidth, layer.clientHeight);
  }

  function syncPlayback() {
    if (!theme || reduced.matches) return;
    const paused = document.hidden || !document.hasFocus() || root.hasAttribute("data-theme-transition");
    if (pendingTime !== null && score && !paused) {
      animations = score.play();
      for (const animation of animations) animation.currentTime = pendingTime;
      pendingTime = null;
      const current = animations;
      Promise.allSettled(current.map((animation) => animation.finished)).then(() => {
        if (current === animations) animations = [];
      });
    }
    for (const animation of animations) {
      if (paused && animation.playState === "running") animation.pause();
      else if (!paused && animation.playState === "paused") animation.play();
    }
  }

  function requestPass() {
    if (!theme || !score || reduced.matches || pendingTime !== null || animations.length) return;
    pendingTime = 0;
    syncPlayback();
  }

  async function syncTheme() {
    const next = root.dataset.skin === "kimi" ? root.dataset.theme || "light" : "";
    if (theme === next) return syncPlayback();
    const version = ++generation;
    // Keep the same beat across a palette change, including while artwork decodes.
    const elapsed = animations.at(-1)?.currentTime ?? pendingTime ?? 0;
    stop();
    theme = next;
    score = undefined;
    layer.replaceChildren();
    if (!theme) {
      scoreLoad = undefined;
      return;
    }
    if (!reduced.matches) pendingTime = elapsed;
    try {
      scoreLoad ??= loadScore(characters, signal);
      const art = await scoreLoad;
      if (version !== generation) return;
      score = art;
      layer.replaceChildren(...art.nodes);
      layout();
      syncPlayback();
    } catch (error) {
      if (generation === version) {
        scoreLoad = undefined;
        stop();
        console.error("Kimi score artwork failed to load", error);
      }
    }
  }

  const alignPortraitMasks = () => score?.alignPortraitMasks();
  const portraitsResize = new ResizeObserver(alignPortraitMasks);
  portraitsResize.observe(characters);
  const portraitsChanges = new MutationObserver(alignPortraitMasks);
  portraitsChanges.observe(characters, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ["style", "data-loaded", "data-skin", "data-skin-characters"],
  });
  const layerResize = new ResizeObserver(layout);
  layerResize.observe(layer);
  const themeChanges = new MutationObserver(syncTheme);
  themeChanges.observe(root, {
    attributes: true,
    attributeFilter: ["data-theme", "data-skin", "data-theme-transition"],
  });
  for (const event of ["focus", "blur"]) window.addEventListener(event, syncPlayback, options);
  document.addEventListener("visibilitychange", syncPlayback, options);
  document.addEventListener("waifu:achievement-earned", requestPass, options);
  reduced.addEventListener(
    "change",
    () => {
      if (reduced.matches) stop();
    },
    options,
  );
  syncTheme();

  return () => {
    generation++;
    listeners.abort();
    portraitsResize.disconnect();
    portraitsChanges.disconnect();
    layerResize.disconnect();
    themeChanges.disconnect();
    stop();
    score = undefined;
    scoreLoad = undefined;
    layer.remove();
    layer.replaceChildren();
  };
}
