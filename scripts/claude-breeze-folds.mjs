import { makeCutoutPainter } from "./claude-breeze-cutout.mjs";

// Outer lips traced on the accepted 144px paper crops. Each number is the x
// coordinate at successive 3px scan lines; the final sample is on row 143.
const edges = {
  "low-fold": [
    119, 117, 115, 113, 111, 108, 104, 100, 96, 93, 91, 89, 87, 86, 83, 82, 81,
    80, 79, 78, 76, 75, 74, 75, 75, 75, 75, 74, 73, 73, 69, 67, 66, 65,
    65, 64, 63, 61, 60, 58, 47, 45, 43, 41, 41, 38, 34, 29, 28,
  ],
  "lower-fold": [
    127, 124, 120, 117, 115, 113, 113, 111, 110, 109, 109, 109, 108, 107, 106, 104, 103,
    100, 97, 93, 86, 82, 82, 81, 82, 79, 71, 67, 61, 56, 55, 52, 51, 51,
    50, 49, 47, 45, 44, 43, 43, 42, 42, 40, 39, 39, 40, 39, 39,
  ],
  "middle-fold": [
    95, 94, 94, 93, 93, 93, 91, 90, 88, 86, 85, 84, 84, 84, 83, 83, 82,
    82, 81, 81, 80, 80, 79, 77, 77, 75, 74, 74, 74, 72, 71, 71, 71, 70,
    69, 68, 66, 63, 62, 60, 58, 57, 57, 55, 55, 55, 53, 50, 49,
  ],
  "upper-fold": [
    98, 97, 96, 93, 92, 91, 90, 90, 90, 89, 88, 87, 87, 86, 86, 86, 86,
    84, 82, 82, 81, 80, 79, 77, 76, 76, 76, 76, 75, 74, 73, 72, 71, 69,
    67, 65, 64, 64, 63, 63, 63, 63, 64, 64, 64, 64, 63, 62, 61,
  ],
};

function smooth(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function makeFoldPainter(patch, size, sample, trace = edges[patch.name]) {
  const edge = trace;
  const end = 143; // Last measured scan line; the tile also holds the cast shadow.
  const rim = edge.map((x, i) => [x, Math.min(3 * i, end)]);
  // Close the top sheet beyond its pinned side. Only the free torn edge is exposed.
  rim.push([-2, end], [-2, 0]);
  function edgeAt(y) {
    const i = Math.floor(y / 3);
    const t = (y - 3 * i) / Math.min(3, end - 3 * i);
    return edge[i] + t * (edge[i + 1] - edge[i]);
  }

  const centerY = patch.center[1] - patch.y;
  const slopeScale = Math.hypot(1, patch.tilt);
  function lift(x, y) {
    const lengthwise = smooth(1 - Math.abs(y - centerY) / 48);
    const inset = Math.max(0, edgeAt(y) - x) / slopeScale;
    return patch.lift * lengthwise * smooth(1 - inset / 23);
  }

  return makeCutoutPainter(patch, size, sample, rim, (x, y, amount) => {
    if (Math.abs(y - centerY) >= 48 || x > edgeAt(y) + 6) return;
    let offset = amount * lift(x, y);
    if (Math.abs(offset) < 0.025) return;
    for (let i = 0; i < 4; i++) offset = amount * lift(x + offset, y + offset * 0.5);
    return [x + offset, y + offset * 0.5];
  });
}
