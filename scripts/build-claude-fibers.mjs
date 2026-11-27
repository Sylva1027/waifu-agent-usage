import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeLayerPainter } from "./claude-breeze-cutout.mjs";
import { firstPose, lastPose } from "../public/dev/waifu-visuals/claude-ambient/breeze-patches.js";

import { lightFiberRims } from "./claude-light-traces.mjs";

const theme = process.argv[2] ?? "dark";
if (theme !== "dark" && theme !== "light") throw new Error("Expected light or dark");
const directory = new URL("../public/dev/waifu-visuals/claude-ambient/", import.meta.url);
const ffmpeg = (args, input) =>
  execFileSync("ffmpeg", ["-v", "error", ...args], { input, maxBuffer: 64 * 1024 * 1024 });
const rgb = ffmpeg([
  "-i",
  fileURLToPath(new URL(`art/right-${theme}.webp`, directory)),
  "-pix_fmt",
  "rgb24",
  "-f",
  "rawvideo",
  "-",
]);
const plateWidth = 1536,
  plateHeight = 1280;
if (rgb.length !== plateWidth * plateHeight * 3) throw new Error("Unexpected right plate dimensions");
// The second trace is the exposed edge of the overlapping flap in the notch.
const rims = [
  [
    [1541, 202], [1537, 202], [1533, 204], [1528, 203], [1524, 206], [1507, 211], [1498, 212],
    [1494, 211], [1480, 213], [1475, 215], [1464, 224], [1453, 228], [1430, 223], [1418, 224],
    [1401, 232], [1392, 233], [1383, 236], [1370, 238], [1360, 236], [1343, 238], [1325, 251],
    [1294, 256], [1289, 255], [1273, 257], [1269, 255], [1257, 262], [1228, 273], [1221, 277],
    [1203, 278], [1195, 282], [1187, 283], [1183, 282], [1175, 283], [1170, 281], [1152, 286],
    [1140, 291], [1138, 297], [1132, 303], [1112, 313], [1099, 317], [1092, 316], [1089, 320],
    [1085, 321], [1082, 325], [1058, 338], [1037, 356], [1024, 374], [1012, 382], [1002, 391],
    [998, 392], [994, 401], [976, 425], [956, 442], [948, 446], [936, 460], [926, 467],
    [915, 486], [907, 490], [904, 498], [901, 501], [894, 515], [891, 519], [886, 520],
    [879, 530], [872, 547], [862, 557], [856, 559], [857, 563], [853, 574], [853, 609],
    [858, 627], [859, 639], [858, 648], [864, 653], [870, 662], [891, 685], [905, 715],
    [915, 729], [920, 747], [921, 756], [919, 769], [909, 785], [894, 798], [890, 799],
    [883, 804], [881, 808], [869, 820], [863, 821], [864, 827], [851, 837], [844, 845],
    [850, 859], [848, 876], [845, 884], [841, 887], [839, 891], [837, 899], [834, 902],
    [825, 924], [820, 931], [818, 942], [818, 975], [822, 987], [827, 990], [828, 1004],
    [831, 1016], [834, 1019], [837, 1027], [859, 1048], [872, 1058], [890, 1083], [896, 1089],
    [926, 1107], [931, 1113], [935, 1115], [943, 1125], [967, 1142], [970, 1145], [971, 1149],
    [980, 1156], [987, 1168], [993, 1168], [1001, 1173], [1008, 1189], [1015, 1193], [1018, 1197],
    [1044, 1211], [1045, 1215], [1052, 1220], [1061, 1230], [1062, 1235], [1065, 1238], [1068, 1246],
    [1077, 1261], [1077, 1266], [1080, 1274], [1085, 1276], [1089, 1283],
  ],
  [
    [901, 702], [903, 715], [906, 719], [906, 724], [899, 727], [895, 736], [892, 754],
    [887, 770], [877, 784], [876, 789], [873, 793], [870, 794], [869, 799], [862, 809],
    [859, 822], [856, 825], [853, 834], [847, 840],
  ],
];
const left = 750,
  top = 120,
  width = plateWidth - left + 32,
  height = plateHeight - top + 32;
const count = width * height;
const clamp = (x) => Math.min(1, Math.max(0, x));
function smooth(x) {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
}
function source(x, y) {
  return (
    3 *
    (Math.max(0, Math.min(plateHeight - 1, top + y)) * plateWidth +
      Math.max(0, Math.min(plateWidth - 1, left + x)))
  );
}
const nearest = new Float32Array(count).fill(Infinity),
  distance = new Float32Array(count);
const dx = new Float32Array(count),
  dy = new Float32Array(count);
for (const rim of theme === "light" ? lightFiberRims : rims) {
  let length = 0;
  for (let i = 1; i < rim.length; i++) {
    const ax = rim[i - 1][0] - left,
      ay = rim[i - 1][1] - top;
    const bx = rim[i][0] - left,
      by = rim[i][1] - top;
    const vx = bx - ax,
      vy = by - ay,
      span = Math.hypot(vx, vy),
      nx = -vy / span,
      ny = vx / span;
    for (let y = Math.max(0, Math.min(ay, by) - 43); y <= Math.min(height - 1, Math.max(ay, by) + 43); y++) {
      for (let x = Math.max(0, Math.min(ax, bx) - 43); x <= Math.min(width - 1, Math.max(ax, bx) + 43); x++) {
        const t = clamp(((x - ax) * vx + (y - ay) * vy) / (span * span)),
          rx = x - ax - t * vx,
          ry = y - ay - t * vy;
        const i = y * width + x,
          squared = rx * rx + ry * ry;
        if (squared >= nearest[i]) continue;
        nearest[i] = squared;
        const d = Math.sign(rx * nx + ry * ny) * Math.sqrt(squared);
        distance[i] = d;
        // Contact with the lip pins the root; a few more tightly bonded groups yield less.
        const s = length + t * span;
        const adhesion = 1 - 0.69 * smooth((Math.cos(s / 44) - 0.83) / 0.17);
        const flex = Math.min(16, Math.max(0, d - 1.8) * 0.69) * smooth((d - 1.8) / 8) * adhesion;
        dx[i] = flex * (0.73 + 0.15 * nx);
        dy[i] = flex * (0.45 + 0.15 * ny);
      }
    }
    length += span;
  }
}

const cutout = new Float32Array(count * 4),
  paper = new Float32Array(count * 3);
const luma = new Float32Array(count);
const original = new Uint8Array(count * 3);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const i = y * width + x,
      p = source(x, y);
    for (let c = 0; c < 3; c++) paper[3 * i + c] = original[3 * i + c] = rgb[p + c];
    luma[i] = 0.3 * rgb[p] + 0.59 * rgb[p + 1] + 0.11 * rgb[p + 2];
  }
// Compare opposite sides of each narrow light ridge. A broad change in paper
// brightness lacks two darker sides and therefore stays on the fixed plate.
const offsets = [
  2,
  3,
  width * 2,
  width * 3,
  2 * width + 2,
  2 * width - 2,
  3 * width + 1,
  3 * width - 1,
  width + 3,
  width - 3,
];
for (let y = 4; y < height - 4; y++)
  for (let x = 4; x < width - 4; x++) {
    const i = y * width + x,
      d = distance[i];
    if (d < 1.9 || d > 37) continue;
    let score = 0,
      across = 0;
    for (const offset of offsets) {
      const contrast = luma[i] - Math.max(luma[i - offset], luma[i + offset]);
      if (contrast > score) {
        score = contrast;
        across = offset;
      }
    }
    if (score < 1.7) continue;
    const weight = smooth((score - 1) / 5) * smooth((d - 1.8) / 3) * smooth((38 - d) / 6);
    let alpha = 0;
    for (let c = 0; c < 3; c++) {
      const value = paper[3 * i + c];
      const donor = (original[3 * (i + across) + c] + original[3 * (i - across) + c]) / 2;
      const back = value - weight * Math.max(0, value - donor);
      paper[3 * i + c] = back;
      alpha = Math.max(alpha, (value - back) / Math.max(1, Math.min(255 - back, Math.max(70, 180 - back))));
    }
    alpha = clamp(alpha);
    if (alpha < 0.012) {
      for (let c = 0; c < 3; c++) paper[3 * i + c] = original[3 * i + c];
      continue;
    }
    cutout[4 * i + 3] = alpha;
    for (let c = 0; c < 3; c++) cutout[4 * i + c] = original[3 * i + c] - (1 - alpha) * paper[3 * i + c];
  }
// Require continuity along a filament to discard isolated flecks of paper grain.
const visited = new Uint8Array(count);
for (let i = 0; i < count; i++) {
  if (visited[i] || !cutout[4 * i + 3]) continue;
  const group = [i];
  visited[i] = 1;
  let near = distance[i],
    strong = 0,
    x0 = i % width,
    x1 = x0,
    y0 = Math.floor(i / width),
    y1 = y0;
  for (let k = 0; k < group.length; k++) {
    const p = group[k],
      x = p % width,
      y = Math.floor(p / width);
    near = Math.min(near, distance[p]);
    strong = Math.max(strong, cutout[4 * p + 3]);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    for (const off of [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1]) {
      const j = p + off;
      if (!visited[j] && cutout[4 * j + 3]) {
        visited[j] = 1;
        group.push(j);
      }
    }
  }
  if (strong >= 0.052 && Math.max(x1 - x0, y1 - y0) >= 4 && near <= 12) continue;
  for (const p of group) {
    cutout.fill(0, 4 * p, 4 * p + 4);
    for (let c = 0; c < 3; c++) paper[3 * p + c] = original[3 * p + c];
  }
}
function interpolate(field, x, y) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    a = x - ix,
    b = y - iy,
    i = iy * width + ix;
  return (
    (1 - b) * ((1 - a) * field[i] + a * field[i + 1]) + b * ((1 - a) * field[i + width] + a * field[i + width + 1])
  );
}
const paint = makeLayerPainter(width, cutout, paper, (x, y, amount) => {
  const i = y * width + x;
  if (dx[i] < 0.02) return;
  let u = x,
    v = y;
  for (let k = 0; k < 4; k++) {
    const next = x + amount * interpolate(dx, u, v);
    v = y + amount * interpolate(dy, u, v);
    u = next;
  }
  return [u, v];
});

// Tight strips along the two-dimensional tear are packed together. A single
// native-resolution canvas recombines them before CSS scales the whole sheet.
const strips = [];
for (let y = 0; y < plateHeight - top; y += 24) {
  let min = width,
    max = -1;
  for (let yy = Math.max(0, y - 12); yy < Math.min(height, y + 24 + 12); yy++)
    for (let x = 0; x < width; x++)
      if (cutout[4 * (yy * width + x) + 3]) {
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
  if (max < min) continue;
  const x0 = Math.max(0, min - 14),
    x1 = Math.min(plateWidth - left, max + 15);
  if (x1 > x0) strips.push([x0, y, x1 - x0, Math.min(24, plateHeight - top - y)]);
}
const sheetWidth = Math.max(384, ...strips.map((r) => r[2]));
let u = 0,
  v = 0,
  band = 0;
for (const r of strips) {
  if (u + r[2] > sheetWidth) {
    v += band;
    u = 0;
    band = 0;
  }
  r.push(u, v);
  u += r[2];
  band = Math.max(band, r[3]);
}
const poseHeight = v + band,
  sheetHeight = poseHeight * (lastPose - firstPose + 1);
const atlas = Buffer.alloc(sheetWidth * sheetHeight * 4);
for (let pose = firstPose; pose <= lastPose; pose++) {
  if (!pose) continue;
  for (const [rx, ry, w, h, sx, sy] of strips)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const out = 4 * (((pose - firstPose) * poseHeight + sy + y) * sheetWidth + sx + x);
        paint(rx + x, ry + y, pose / lastPose, atlas, out);
      }
}
ffmpeg(
  [
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-video_size",
    `${sheetWidth}x${sheetHeight}`,
    "-i",
    "-",
    "-frames:v",
    "1",
    "-c:v",
    "libwebp",
    "-lossless",
    "1",
    "-compression_level",
    "6",
    fileURLToPath(new URL(`art/fibers-${theme}.webp`, directory)),
  ],
  atlas,
);
const layout = {
  left,
  top,
  width: plateWidth - left,
  height: plateHeight - top,
  plateWidth,
  plateHeight,
  poseHeight,
};
writeFileSync(
  new URL(theme === "light" ? "fiber-layout-light.js" : "fiber-layout.js", directory),
  [
    "// Generated by scripts/build-claude-fibers.mjs",
    "export const fiberLayout = {",
    ...Object.entries(layout).map(([key, value]) => `  ${key}: ${value},`),
    "  strips: [",
    ...strips.map(strip => `    [${strip.join(", ")}],`),
    "  ],",
    "};",
    "",
  ].join("\n"),
);
