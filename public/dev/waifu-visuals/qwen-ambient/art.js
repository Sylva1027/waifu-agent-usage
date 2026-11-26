// Coordinates correspond to the original 1254px-square Qwen textile.
export const materialBounds = { left: 0, top: 300, right: 1120, bottom: 1036 };
export const atlasLayout = { columns: 4, rows: 4, sampleScale: 0.5, steps: 16 };

export async function loadMaterial(mode) {
  const image = new Image();
  image.src = new URL(`./art/${mode === "dark" ? "dark" : "light"}.webp`, import.meta.url).href;
  await image.decode();
  return image;
}

// The host supplies a cleared transparent canvas, with x/y/size in its coordinate system.
export function drawLight(ctx, material, x, y, size, phase) {
  if (phase <= 0 || phase >= 1) return;
  const { left, top, right, bottom } = materialBounds;
  const { columns, rows, steps } = atlasLayout;
  const tileW = material.naturalWidth / columns;
  const tileH = material.naturalHeight / rows;
  const sourceScale = size / 1254;
  const t = phase * steps;
  const start = Math.floor(t);
  const mix = t - start;

  ctx.save();
  // Add premultiplied samples on transparency so shadows and highlights interpolate equally.
  ctx.globalCompositeOperation = "lighter";
  for (let sample = start; sample <= start + 1; sample++) {
    const weight = sample === start ? 1 - mix : mix;
    if (sample <= 0 || sample >= steps || weight === 0) continue;
    const tile = sample - 1;
    ctx.globalAlpha = weight;
    ctx.drawImage(
      material,
      (tile % columns) * tileW,
      Math.floor(tile / columns) * tileH,
      tileW,
      tileH,
      x + left * sourceScale,
      y + top * sourceScale,
      (right - left) * sourceScale,
      (bottom - top) * sourceScale,
    );
  }
  ctx.restore();
}
