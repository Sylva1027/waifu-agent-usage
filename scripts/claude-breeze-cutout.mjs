import { makeCastShadow } from "./claude-breeze-shadow.mjs";

const clamp = v => Math.min(1, Math.max(0, v));

function closestEdge(rim, x, y) {
  let closest = Infinity, edgeX = 0, edgeY = 0, nx = 0, ny = 0, inside = false;
  for (let i = 0; i < rim.length; i++) {
    const [ax, ay] = rim[i];
    const [bx, by] = rim[(i + 1) % rim.length];
    const vx = bx - ax, vy = by - ay;
    if ((ay > y) !== (by > y) && x < ax + (y - ay) * vx / vy) inside = !inside;
    const t = clamp(((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy));
    const px = ax + t * vx, py = ay + t * vy;
    const distance = Math.hypot(x - px, y - py);
    if (distance >= closest) continue;
    closest = distance;
    edgeX = px;
    edgeY = py;
    const length = Math.hypot(vx, vy);
    nx = vy / length;
    ny = -vx / length;
  }
  return { edgeX, edgeY, nx, ny, depth: inside ? closest : -closest };
}

export function makeCutoutPainter(patch, size, sample, rim, sourcePoint) {
  const cutout = new Float32Array(size * size * 4); // Premultiplied foreground RGB + coverage.
  const cleanPaper = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const {edgeX, edgeY, nx, ny, depth} = closestEdge(rim, x, y);
      const rgb = channel => sample(patch.x + x, patch.y + y, channel);
      for (let c = 0; c < 3; c++) cleanPaper[3 * idx + c] = rgb(c);
      if (depth <= -1.6) continue;

      // A fixed donor just outside this edge supplies texture only where the resting
      // material covers the paper. Reflect inward distance so newly exposed grain has scale.
      const distance = 2.8 + Math.max(0, depth);
      const donor = [];
      const inner = [];
      for (let c = 0; c < 3; c++) {
        donor.push(sample(patch.x + edgeX + nx * distance, patch.y + edgeY + ny * distance, c));
        inner.push(sample(patch.x + edgeX - nx * 2.2, patch.y + edgeY - ny * 2.2, c));
      }
      const geometric = clamp(0.5 + depth / 2.4);
      let dot = 0, norm = 0;
      for (let c = 0; c < 3; c++) {
        const contrast = inner[c] - donor[c];
        dot += (rgb(c) - donor[c]) * contrast;
        norm += contrast * contrast;
      }
      // Refine antialiasing with the actual foreground/paper color contrast in the trimap.
      const trust = clamp(norm / 900) * clamp(1.6 - Math.abs(depth));
      let alpha = depth >= 1.6 ? 1 : geometric + trust * (clamp(dot / (norm || 1)) - geometric);
      for (let c = 0; c < 3; c++) {
        const src = rgb(c);
        const back = src + clamp(depth + 1.6) * (donor[c] - src);
        cleanPaper[3 * idx + c] = back;
        // Keep the recovered foreground in gamut even at the brightest thin margin.
        alpha = Math.max(alpha, src > back ? (src - back) / (255 - back) : (back - src) / (back || 1));
      }
      cutout[4 * idx + 3] = alpha;
      for (let c = 0; c < 3; c++) cutout[4 * idx + c] = rgb(c) - (1 - alpha) * cleanPaper[3 * idx + c];
    }
  }

  const castShadow = makeCastShadow(patch, size, rim, sample, sourcePoint);
  return makeLayerPainter(size, cutout, cleanPaper, sourcePoint, castShadow);
}

// Move the isolated premultiplied foreground over its stationary backing.
export function makeLayerPainter(size, cutout, cleanPaper, sourcePoint, castShadow) {
  return (x, y, amount, pixels, out) => {
    const position = sourcePoint(x, y, amount);
    const gain = castShadow?.(x, y, amount) ?? 1;
    const relight = Math.abs(gain - 1) >= 1 / 255;
    if (!position && !relight) return;
    const [u, v] = position ?? [x, y];
    const ix = Math.floor(u), iy = Math.floor(v);
    const tx = u - ix, ty = v - iy;
    const from = (iy * size + ix) * 4;
    const below = from + size * 4;
    function moved(c) {
      const top = (1 - tx) * cutout[from + c] + tx * cutout[from + 4 + c];
      const bottom = (1 - tx) * cutout[below + c] + tx * cutout[below + 4 + c];
      return (1 - ty) * top + ty * bottom;
    }

    const idx = y * size + x;
    const oldAlpha = cutout[4 * idx + 3];
    const newAlpha = moved(3);
    if (relight && newAlpha < 1) {
      // Illumination acts on the stationary receiver under the moving cutout.
      // In the exposed penumbra keep the correction translucent, preserving grain.
      // A bright receiver needs more coverage to encode the same gain in sRGB.
      const backIndex = 3 * idx;
      const brightest = Math.max(cleanPaper[backIndex], cleanPaper[backIndex + 1], cleanPaper[backIndex + 2]);
      const headroom = gain > 1 ? Math.max(1, brightest / Math.max(1, 255 - brightest)) : 1;
      const shadowAlpha = Math.min(1, Math.abs(gain - 1) * headroom);
      const alpha = oldAlpha > 0 ? 1 : newAlpha + (1 - newAlpha) * shadowAlpha;
      for (let c = 0; c < 3; c++) {
        const back = cleanPaper[3 * idx + c];
        const background = oldAlpha > 0 ? back * gain : (gain > 1 ? back * (shadowAlpha + (gain - 1)) : 0);
        const value = (moved(c) + (1 - newAlpha) * background) / alpha;
        pixels[out + c] = Math.max(0, Math.min(255, Math.round(value)));
      }
      pixels[out + 3] = Math.round(255 * alpha);
      return;
    }
    if (!position || (oldAlpha === 0 && newAlpha < 1 / 510)) return;
    // Inside the old footprint, reveal the stationary paper. Outside it, only the
    // antialiased foreground is drawn, and the browser keeps its original paper pixels.
    for (let c = 0; c < 3; c++) {
      const value = oldAlpha > 0 ? moved(c) + (1 - newAlpha) * cleanPaper[3 * idx + c] : moved(c) / newAlpha;
      pixels[out + c] = Math.max(0, Math.min(255, Math.round(value)));
    }
    pixels[out + 3] = oldAlpha > 0 ? 255 : Math.round(newAlpha * 255);
  };
}
