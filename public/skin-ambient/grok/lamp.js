import { loadImage } from "./image.js";

const width = 512,
  height = 288;

const PAN_START = 0.75,
  PAN_END = 4.6;
export const LAMP_AT_DESK_CENTER = (PAN_START + PAN_END) / 2;

function ease(from, to, seconds) {
  const t = Math.max(0, Math.min(1, (seconds - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

const pan = (seconds) => ease(PAN_START, PAN_END, seconds);
const lampStrength = (seconds) => ease(0, 0.72, seconds) * (1 - ease(4.95, 6.35, seconds));

export function boardLight(seconds) {
  return lampStrength(seconds) * ease(0.46, 0.97, pan(seconds));
}

export async function createLamp(stage, signal) {
  const atlas = await loadImage(new URL("./lamp-dark.webp", import.meta.url).href, signal);

  const canvas = document.createElement("canvas");
  canvas.className = "grok-lamp";
  canvas.width = width;
  canvas.height = height;
  canvas.hidden = true;
  const ctx = canvas.getContext("2d");
  stage.append(canvas);
  let lastPose = -1;

  function draw(index, weight) {
    ctx.globalAlpha = weight;
    ctx.drawImage(atlas, (index % 3) * width, Math.floor(index / 3) * height, width, height, 0, 0, width, height);
  }

  return {
    paint(seconds) {
      const strength = lampStrength(seconds);
      canvas.hidden = strength === 0;
      if (!strength) return;
      canvas.style.opacity = String(strength);

      // Turn continuously through the desk-center bearing, linger on brass, then let the lamp fade.
      const pose = 8 * pan(seconds);
      if (pose === lastPose) return;
      lastPose = pose;
      const index = Math.floor(pose);
      const fraction = pose - index;
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";
      draw(index, 1 - fraction);
      if (fraction) draw(index + 1, fraction);
    },
    destroy() {
      atlas.removeAttribute("src");
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    },
  };
}
