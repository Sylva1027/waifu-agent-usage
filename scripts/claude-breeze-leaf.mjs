import { makeCutoutPainter } from "./claude-breeze-cutout.mjs";

// Pixel centers on the 144px leaf crop. Successive columns trace the top and underside
// separately, including the hook at the tip and the steep, shadowed lower edge.
const outline = [
  [20,100,100],[28,82,97],[35,70,94.5],[42,57,94.5],[48,55,94.5],
  [54,53,95],[60,50,95.5],[66,44.5,96],[72,41,95.5],[78,38,93],
  [84,35,88.5],[90,32,82.7],[94,30,78],[98,29.2,70.8],[100,29.5,66.5],
  [102,30.1,61.4],[103,30.5,56.0],[104,31,51.6],[106,31.4,46.9],
  [108,32.3,44],[110,33.5,41.8],[112,34.8,41],[114,36.3,40.6],
  [116,37.8,41.2],[118,39.6,41.6],[119.6,41.2,41.2],
];
export function makeLeafPainter(patch, size, sample, trace = outline) {
  const rim = [
    ...trace.map(([x, top]) => [x, top]),
    ...trace.slice(1, -1).reverse().map(([x, , bottom]) => [x, bottom]),
  ];
  function bend(x) {
    const t = Math.min(1, Math.max(0, (x - 41) / 78));
    return t * t * (3 - 2 * t);
  }

  return makeCutoutPainter(patch, size, sample, rim, (x, y, amount) => {
    if (x <= 41 || x > 124 || y < 20 || y > 102) return;
    // Invert the tip displacement; the petiole remains under the edge of the top sheet.
    let u = x;
    for (let i = 0; i < 4; i++) u = x + 6.4 * amount * bend(u);
    const v = y + 5.4 * amount * bend(u);
    return [u, v];
  });
}
