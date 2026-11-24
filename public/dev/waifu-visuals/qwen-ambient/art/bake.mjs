// Run with Node and ffmpeg to rebuild the two development-only light atlases.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atlasLayout, materialBounds } from "../art.js";

const originalSize = 1254;
const { columns, rows, sampleScale, steps } = atlasLayout;
const { left, top, right, bottom } = materialBounds;
const tileW = (right - left) * sampleScale;
const tileH = (bottom - top) * sampleScale;
const atlasW = tileW * columns;
const atlasH = tileH * rows;

// Points traced along the underside of the bound edge, left to right.
const hem = [
  [0, 479],
  [72, 435],
  [155, 393],
  [237, 359],
  [325, 333],
  [414, 317],
  [507, 310],
  [609, 315],
  [706, 329],
  [816, 357],
  [922, 389],
  [1023, 415],
  [1120, 430],
];

function smooth(a, b, v) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function bell(offset, width) {
  return Math.exp(-0.5 * (offset / width) ** 2);
}

function ffmpeg(args, input) {
  const result = spawnSync("ffmpeg", ["-v", "error", ...args], { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}

function makeAtlas(mode) {
  const dark = mode === "dark";
  const source = fileURLToPath(
    new URL(`../../../../assets/achievement-share/qwen/background-${mode}.webp`, import.meta.url),
  );
  const rgb = ffmpeg(["-i", source, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  if (rgb.length !== originalSize * originalSize * 3)
    throw new Error("The source size no longer matches the hand-traced folds.");
  const lum = (x, y) => {
    const i = (y * originalSize + Math.max(0, Math.min(originalSize - 1, x))) * 3;
    return rgb[i] * 0.2126 + rgb[i + 1] * 0.7152 + rgb[i + 2] * 0.0722;
  };
  const atlas = Buffer.alloc(atlasW * atlasH * 4);
  for (let px = 0; px < tileW; px++) {
    const x = left + (px + 0.5) / sampleScale;
    const knot = hem.findIndex(([end]) => end >= x);
    const [ax, ay] = hem[knot - 1];
    const [bx, by] = hem[knot];
    const edge = ay + ((x - ax) / (bx - ax)) * (by - ay);
    for (let py = 0; py < tileH; py++) {
      const y = top + (py + 0.5) / sampleScale;
      const occlusion = smooth(5, 37, y - edge) * (1 - smooth(852, bottom - 2, y));
      if (!occlusion) continue;
      // Oblique joins between the lattice brocade, plain satin, and floral jacquard.
      const edges = [
        165 - (y - 392) * 0.317,
        519 - (y - 311) * 0.671,
        827 - (y - 357) * 0.831,
        1150 - (y - 431) * 1.263,
      ];
      const face = edges.findIndex((end) => end > x) - 1;
      if (face < 0) continue;
      const u = (x - edges[face]) / (edges[face + 1] - edges[face]);
      const falloff = smooth(0.018, 0.09, u) * (1 - smooth(0.9, 0.982, u));
      const spot = occlusion * falloff * bell(y - (555 + (x - 450) * 0.06), 186);
      if (spot < 0.001) continue;

      // Recover the actual raised threads from a small neighborhood of the source.
      const luma = lum(x, y);
      const surround = (lum(x - 6, y - 5) + lum(x + 6, y + 5) + lum(x - 5, y + 4) + lum(x + 5, y - 4)) / 4;
      const ridge = smooth(-0.5, dark ? 7 : 9, luma - surround);
      const stitch = smooth(0.2, 5.3, Math.abs(luma - lum(x + 1, y + 2)));
      let angle, spread, response;
      if (face === 0) {
        angle = 0.12 + 0.24 * u + 0.02 * Math.sin(y / 108);
        spread = 0.078;
        response = 0.055 + 0.78 * ridge + 0.25 * ridge * stitch;
      } else if (face === 1) {
        angle = 0.32 + 0.29 * u + 0.055 * Math.sin(y / 124 + u * 1.1);
        spread = 0.081;
        response = (0.58 + 0.28 * ridge + 0.14 * stitch) * (0.74 + 0.26 * bell(u - 0.59, 0.23));
      } else {
        angle = 0.57 + 0.26 * u + 0.023 * Math.cos(y / 94);
        spread = 0.068;
        response = 0.038 + 0.87 * ridge + 0.26 * ridge * stitch;
      }
      // Subtract part of the photographed glancing light as the new angle departs.
      const oldSpecular = (face === 0 ? 0.78 : face === 1 ? 0.46 : 0.18) * bell(u - 0.34, 0.22) * bell(y - 602, 168);
      for (let sample = 1; sample < steps; sample++) {
        const t = sample / steps;
        const envelope = smooth(0, 0.16, t) * (1 - smooth(0.8, 1, t));
        const newLight = bell(t - angle, spread);
        const gain = spot * response * envelope * (newLight - oldSpecular * (1 - newLight));
        const tint = gain > 0 ? (dark ? [182, 215, 177] : [255, 253, 238]) : dark ? [2, 6, 5] : [66, 83, 65];
        const strength = gain > 0 ? (dark ? 0.19 : 0.535) : dark ? 0.57 : 0.107;
        const alpha = Math.min(255, Math.round(255 * Math.abs(gain) * strength));
        if (!alpha) continue;
        const tile = sample - 1;
        const i = ((Math.floor(tile / columns) * tileH + py) * atlasW + (tile % columns) * tileW + px) * 4;
        atlas[i] = tint[0];
        atlas[i + 1] = tint[1];
        atlas[i + 2] = tint[2];
        atlas[i + 3] = alpha;
      }
    }
  }
  const dest = fileURLToPath(new URL(`./${mode}.webp`, import.meta.url));
  ffmpeg(
    [
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${atlasW}x${atlasH}`,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-lossless",
      "1",
      "-y",
      dest,
    ],
    atlas,
  );
}

makeAtlas("dark");
makeAtlas("light");
