import { createStudy, duration as leftDuration, rightDuration } from "./nacre-study.js";

const art = {
  light: [
    "/assets/achievement-share/chatgpt/background-light.webp",
    new URL("./art/left-rim-light.webp", import.meta.url).href,
    new URL("./art/right-rim-light.webp", import.meta.url).href,
  ],
  dark: [
    "/assets/achievement-share/chatgpt/background-dark.webp",
    new URL("./art/left-rim-dark.webp", import.meta.url).href,
    new URL("./art/right-rim-dark.webp", import.meta.url).href,
  ],
};

export function mount({ root, characters }) {
  const events = new AbortController();
  const { signal } = events;
  const scene = document.createElement("div");
  scene.id = "chatgpt-ambient";
  scene.setAttribute("aria-hidden", "true");
  const panels = ["left", "right"].map((side) => {
    const wing = document.createElement("div");
    wing.className = `wing ${side}`;
    const surface = document.createElement("div");
    surface.className = "surface";
    const lip = document.createElement("div");
    lip.className = "lip";
    const reflection = document.createElement("div");
    reflection.className = "reflection";
    lip.append(reflection);
    surface.append(lip);
    wing.append(surface);
    scene.append(wing);
    return { side, wing, surface, reflection, canvas: null, study: null, detachCanvasListeners: null };
  });
  characters.before(scene);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let raf = 0;
  let lastFrame = -1;
  const resize = new ResizeObserver(() => {
    lastFrame = -1;
  });
  let theme = "";
  let plate = null;
  let generation = 0;
  let pendingImages = [];
  let pass = null;

  function preparePanel(panel) {
    if (!plate || reduced.matches) return;
    const { wing, surface } = panel;
    if (!panel.canvas) {
      const canvas = document.createElement("canvas");
      panel.canvas = canvas;
      canvas.className = "silk";
      canvas.hidden = true;
      surface.append(canvas);
      resize.observe(surface);
      const onLost = (event) => {
        event.preventDefault();
        canvas.hidden = true;
        panel.study = null;
        delete wing.dataset.silk;
      };
      const onRestored = () => {
        preparePanel(panel);
        lastFrame = -1;
        playback();
      };
      canvas.addEventListener("webglcontextlost", onLost);
      canvas.addEventListener("webglcontextrestored", onRestored);
      panel.detachCanvasListeners = () => {
        canvas.removeEventListener("webglcontextlost", onLost);
        canvas.removeEventListener("webglcontextrestored", onRestored);
      };
    }
    try {
      panel.study ??= createStudy(panel.canvas, panel.side);
      panel.study.prepare(theme, plate);
      wing.dataset.silk = "ready";
    } catch {
      panel.canvas.hidden = true;
      delete wing.dataset.silk;
    }
  }

  function releasePanel(panel) {
    resize.unobserve(panel.surface);
    panel.detachCanvasListeners?.();
    panel.detachCanvasListeners = null;
    panel.canvas?.remove();
    panel.canvas = null;
    panel.study?.dispose();
    panel.study = null;
    delete panel.wing.dataset.silk;
  }

  function hideSilk() {
    cancelAnimationFrame(raf);
    for (const { canvas } of panels) {
      if (canvas) canvas.hidden = true;
    }
    lastFrame = -1;
  }

  function paintSilk() {
    if (!plate || !pass) return;
    // Map a theme change onto the existing pass so it keeps its original duration.
    const clock = pass[1];
    const time = (rightDuration * Number(clock.currentTime ?? 0)) / clock.effect.getComputedTiming().endTime;
    const frame = Math.floor(time * 24);
    if (frame !== lastFrame) {
      for (const { canvas, study, side, wing } of panels) {
        if (!wing.dataset.silk) continue;
        canvas.hidden = side === "right" ? time < 1 : time >= leftDuration;
        if (!canvas.hidden) study.draw(time, 1, theme);
      }
      lastFrame = frame;
    }
    if (clock.playState === "running" && !document.hidden && document.hasFocus()) {
      raf = requestAnimationFrame(paintSilk);
    }
  }

  function stop() {
    hideSilk();
    if (!pass) return;
    pass[1].onfinish = null;
    for (const animation of pass) animation.cancel();
    pass = null;
  }

  function playback() {
    cancelAnimationFrame(raf);
    if (!pass) return;
    const visible = plate && !document.hidden && document.hasFocus() && !root.dataset.themeTransition;
    for (const animation of pass) {
      if (!visible && animation.playState === "running") animation.pause();
      if (visible && animation.playState === "paused") animation.play();
    }
    if (visible) paintSilk();
  }

  function illuminate() {
    if (!theme || reduced.matches || pass) return;
    const start = "translateX(-101%)";
    const end = "translateX(279%)";
    pass = panels.map(({ reflection }, i) => {
      // The right plate is rotated, so its local sweep travels in reverse.
      const duration = i ? rightDuration * 1000 - 3000 : 4400;
      const animation = reflection.animate([{ transform: i ? end : start }, { transform: i ? start : end }], {
        duration,
        delay: i ? 3000 : 0,
        easing: `steps(${Math.round((duration * 12) / 1000)}, end)`,
        fill: "both",
      });
      animation.pause();
      return animation;
    });
    pass[1].onfinish = stop;
    playback();
  }

  function cancelLoad() {
    generation += 1;
    for (const image of pendingImages) image.removeAttribute("src");
    pendingImages = [];
  }

  async function loadPlate() {
    const version = generation;
    pendingImages = art[theme].map((src) => {
      const image = new Image();
      image.src = src;
      return image;
    });
    try {
      const [background] = pendingImages;
      await Promise.all(pendingImages.map((image) => image.decode()));
      if (version !== generation) return;
      plate = background;
      panels.forEach(preparePanel);
      playback();
    } catch {
      if (version === generation) stop();
    } finally {
      if (version === generation) pendingImages = [];
    }
  }

  function sync() {
    const next = root.dataset.skin === "chatgpt" ? (root.dataset.theme === "dark" ? "dark" : "light") : "";
    if (next === theme) {
      playback();
      return;
    }
    theme = next;
    hideSilk();
    cancelLoad();
    plate = null;
    for (const { wing } of panels) delete wing.dataset.silk;
    if (!theme) {
      stop();
      panels.forEach(releasePanel);
      return;
    }
    if (reduced.matches) return;
    playback();
    illuminate();
    void loadPlate();
  }

  const attributes = new MutationObserver(sync);
  attributes.observe(root, {
    attributes: true,
    attributeFilter: ["data-skin", "data-theme", "data-theme-transition"],
  });
  for (const event of ["focus", "blur"]) window.addEventListener(event, playback, { signal });
  document.addEventListener("visibilitychange", playback, { signal });
  document.addEventListener("waifu:achievement-earned", illuminate, { signal });
  reduced.addEventListener(
    "change",
    () => {
      if (reduced.matches) {
        stop();
        cancelLoad();
        plate = null;
        panels.forEach(releasePanel);
      } else if (theme) {
        void loadPlate();
      }
    },
    { signal },
  );
  sync();

  return () => {
    events.abort();
    attributes.disconnect();
    resize.disconnect();
    stop();
    cancelLoad();
    plate = null;
    panels.forEach(releasePanel);
    scene.remove();
  };
}
