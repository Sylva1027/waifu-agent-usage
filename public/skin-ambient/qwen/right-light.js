import { loadImage } from "./image.js";

// Pixels in the original 1536 × 2304 photograph, before the host's cover crop.
export const rightLightBounds = { left: 324, top: 252, right: 1536, bottom: 2304 };
export const rightLightWindow = { start: 0.55, end: 0.96 };
export const rightAtlas = { columns: 4, rows: 3, steps: 12, downsample: 3 };

const atlasUrls = {
  dark: new URL("./art/right-sweep-dark.webp", import.meta.url).href,
  light: new URL("./art/right-sweep-light.webp", import.meta.url).href,
};

export function loadRightLight(mode, signal) {
  return loadImage(atlasUrls[mode], signal);
}

// x and y refer to the image itself, including the portion clipped by object-fit: cover.
export function drawRightLight(ctx, material, x, y, width, phase) {
  if (phase <= rightLightWindow.start || phase >= rightLightWindow.end) return;
  const { columns, rows, steps } = rightAtlas;
  const tileW = material.naturalWidth / columns;
  const tileH = material.naturalHeight / rows;
  const time = ((phase - rightLightWindow.start) / (rightLightWindow.end - rightLightWindow.start)) * steps;
  const start = Math.floor(time);
  const { left, right, top, bottom } = rightLightBounds;
  const scale = width / 1536;
  ctx.save();
  // Weighted premultiplied samples are accumulated on a cleared transparent surface.
  ctx.globalCompositeOperation = "lighter";
  for (let sample = start; sample <= start + 1; sample++) {
    const weight = 1 - Math.abs(time - sample);
    if (sample < 1 || sample >= steps || weight <= 0) continue;
    const tile = sample - 1;
    ctx.globalAlpha = weight;
    ctx.drawImage(
      material,
      (tile % columns) * tileW,
      Math.floor(tile / columns) * tileH,
      tileW,
      tileH,
      x + left * scale,
      y + top * scale,
      (right - left) * scale,
      (bottom - top) * scale,
    );
  }
  ctx.restore();
}
