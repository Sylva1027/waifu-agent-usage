import { createStudy, duration as leftDuration, rightDuration } from "./nacre-study.js";

const root = document.documentElement;
const scene = document.createElement("div");
scene.id = "chatgpt-ambient";
scene.setAttribute("aria-hidden", "true");
const reflections = ["left", "right"].map((side) => {
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
  return reflection;
});
document.querySelector("#skinCharacters").before(scene);

let raf = 0,
  lastFrame = -1;
const resize = new ResizeObserver(() => {
  lastFrame = -1;
});
const panels = reflections.map((reflection) => {
  const wing = reflection.closest(".wing");
  const side = wing.classList.contains("right") ? "right" : "left";
  const surface = wing.querySelector(".surface");
  return { side, wing, surface, canvas: null, study: null };
});

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
    canvas.addEventListener("webglcontextlost", (event) => {
      if (panel.canvas !== canvas) return;
      event.preventDefault();
      canvas.hidden = true;
      panel.study = null;
      delete wing.dataset.silk;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      if (panel.canvas !== canvas) return;
      preparePanel(panel);
      lastFrame = -1;
      playback();
    });
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
  // Map an in-flight theme change onto the same pass without restarting or extending it.
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
  if (pass[1].playState === "running" && !document.hidden && document.hasFocus())
    raf = requestAnimationFrame(paintSilk);
}
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let theme = "",
  plate = null,
  generation = 0;
let pass;
function stop() {
  hideSilk();
  if (!pass) return;
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
  const start = "translateX(-101%)",
    end = "translateX(279%)";
  pass = reflections.map((element, i) => {
    // The right plate is turned half a revolution. Reverse its local travel to follow the same light.
    const duration = i ? rightDuration * 1000 - 3000 : 4400;
    const animation = element.animate([{ transform: i ? end : start }, { transform: i ? start : end }], {
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
function sync() {
  const next = root.dataset.skin === "chatgpt" ? root.dataset.theme || "light" : "";
  if (next === theme) {
    playback();
    return;
  }
  theme = next;
  hideSilk();
  plate = null;
  for (const { wing } of panels) delete wing.dataset.silk;
  const version = ++generation;
  if (!theme) {
    stop();
    panels.forEach(releasePanel);
    return;
  }
  playback();
  illuminate();
  const urls = [
    `/assets/achievement-share/chatgpt/background-${theme}.webp`,
    ...["left", "right"].map((side) => new URL(`./art/${side}-rim-${theme}.webp`, import.meta.url).href),
  ];
  const assets = urls.map((src) => {
    const image = new Image();
    image.src = src;
    return image.decode().then(() => image);
  });
  Promise.all(assets)
    .then(([background]) => {
      if (version === generation) {
        plate = background;
        panels.forEach(preparePanel);
        playback();
      }
    })
    .catch(() => {
      if (version === generation) stop();
    });
}
new MutationObserver(sync).observe(root, {
  attributes: true,
  attributeFilter: ["data-skin", "data-theme", "data-theme-transition"],
});
for (const event of ["focus", "blur"]) window.addEventListener(event, playback);
document.addEventListener("visibilitychange", playback);
document.addEventListener("waifu:achievement-earned", illuminate);
reduced.addEventListener("change", () => {
  if (reduced.matches) {
    stop();
    panels.forEach(releasePanel);
  } else {
    panels.forEach(preparePanel);
  }
});
sync();
