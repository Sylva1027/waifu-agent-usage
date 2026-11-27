// Rebuild the right-hand sweep with Node and ffmpeg; the base photographs are read-only.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rightAtlas, rightLightBounds } from "../right-light.js";

const { columns, rows, steps, downsample } = rightAtlas;
const { left, top, right, bottom } = rightLightBounds;
const tileWidth = (right - left) / downsample;
const tileHeight = (bottom - top) / downsample;
const atlasWidth = tileWidth * columns;
const atlasHeight = tileHeight * rows;

// Each knot follows the photographed satin lip and the glancing highlight above it.
// The jacquard return is on the other side of the lip.
const fold = [
  [320, 2293, 2281],
  [400, 2184, 2164],
  [500, 2068, 2055],
  [600, 1967, 1917],
  [720, 1868, 1736],
  [840, 1776, 1612],
  [960, 1695, 1490],
  [1080, 1621, 1365],
  [1200, 1554, 1268],
  [1320, 1489, 1182],
  [1440, 1431, 1088],
  [1536, 1383, 1045],
];

function smooth(a, b, v) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function bell(distance, width) {
  return Math.exp(-0.5 * (distance / width) ** 2);
}

function ffmpeg(args, input) {
  const run = spawnSync("ffmpeg", ["-v", "error", ...args], { input, maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(run.stderr.toString());
  return run.stdout;
}

function bake(mode) {
  const dark = mode === "dark";
  const file = (name) => fileURLToPath(new URL(name, import.meta.url));
  const rgb = ffmpeg([
    "-i",
    file(`right-${mode}.webp`),
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ]);
  if (rgb.length !== 1536 * 2304 * 3) throw new Error("Right-hand fold coordinates need to be retraced.");
  const lum = (x, y) => {
    const i = 3 * (Math.max(0, Math.min(2303, y)) * 1536 + Math.max(0, Math.min(1535, x)));
    return rgb[i] * 0.2126 + rgb[i + 1] * 0.7152 + rgb[i + 2] * 0.0722;
  };
  const out = Buffer.alloc(atlasWidth * atlasHeight * 4);
  const lift = dark ? [182, 208, 173] : [253, 250, 232];
  const shade = dark ? [3, 8, 6] : [90, 102, 87];
  const tintLuma = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  for (let px = 0; px < tileWidth; px++) {
    const x = left + px * downsample + 1;
    const knot = fold.findIndex((point) => point[0] >= x);
    const a = fold[knot - 1];
    const b = fold[knot];
    const t = (x - a[0]) / (b[0] - a[0]);
    const lip = a[1] + t * (b[1] - a[1]);
    const highlight = a[2] + t * (b[2] - a[2]);
    const spread = 32 + 0.11 * (lip - highlight);
    // Light first skims the brocade tip, then follows the fold toward the right edge.
    const lightTime = dark ? (x - 425) / 1160 : (x - 470) / 1300;
    // The wider upper shoulder is exposed on the right even when the dashboard covers the middle.
    const outerCloth = smooth(840, 1220, x);
    const grainDirection = (x - 1320) * 0.26 + 24 * Math.sin((x - 1080) / 210);
    for (let py = 0; py < tileHeight; py++) {
      const y = top + py * downsample + 1;
      const fromLip = y - lip;
      const ribbonWidth = Math.min(173, 37 + (x - 315) * 0.14);
      if ((y < highlight - 255 && !outerCloth) || fromLip >= ribbonWidth) continue;
      const source = lum(x, y);
      const surround = (lum(x - 8, y - 6) + lum(x + 8, y + 6) + lum(x - 6, y + 7) + lum(x + 6, y - 7)) * 0.25;
      // The stronger celadon highlight picks up several neighboring filaments per atlas texel.
      const threadLuma = dark ? source : (source + lum(x - 1, y) + lum(x + 1, y) + lum(x, y - 1) + lum(x, y + 1)) / 5;
      const yarn = smooth(-1, dark ? 7 : 8, threadLuma - surround);
      const satin = 1 - smooth(-7, -2, fromLip);
      const brocade = smooth(4, 18, fromLip) * (1 - smooth(ribbonWidth * 0.7, ribbonWidth, fromLip));
      const retreat = bell(y - highlight, spread * (dark ? 0.8 : 0.99));
      // The pale fabric needs a broad lit shoulder separated from its old bright ridge.
      const approach = dark
        ? bell(y - highlight - 0.9 * spread, 1.03 * spread)
        : bell(y - highlight - 1.45 * spread, 1.23 * spread);
      const field = bell(y - highlight + 60, spread * 1.9) * smooth(-250, -180, y - highlight);
      const boundary = smooth(left, left + 95, x) * smooth(top + 5, top + 105, y);
      // Average along the filaments, then compare against neighboring bundles across the weave.
      const alongYarn = (threadLuma + lum(x - 9, y + 2) + lum(x + 9, y - 2)) / 3;
      const acrossYarn = (lum(x, y - 23) + lum(x, y + 23) + lum(x + 7, y + 35) + lum(x - 7, y - 35)) / 4;
      const bundle = smooth(-5, 7, alongYarn - acrossYarn);
      const upperCloth = outerCloth * (1 - smooth(highlight - 75, highlight + 115, y));
      for (let sample = 1; sample < steps; sample++) {
        const progress = sample / steps;
        const angle = progress - lightTime;
        const beam = bell(angle, 0.18);
        const wake = bell(angle - 0.14, 0.16);
        // The lit shoulder moves slightly across the fold as it travels along it.
        // Darkening the old peak keeps the fixed photographic shine from doubling.
        const grazing =
          satin *
          ((dark ? 30 : 36) * beam * approach * (0.68 + 0.32 * yarn) -
            (dark ? 14 : 30) * wake * retreat +
            (dark ? 6 : 6.5) * beam * field * (0.3 + 0.7 * yarn));
        const flowerLight = brocade * bell(angle - 0.055, 0.13);
        const stitch = flowerLight * (dark ? 28 : 34) * yarn - (dark ? 0 : flowerLight * 5 * (1 - yarn));
        // The broad sheen crosses the mostly plain upper silk before the lower lip catches it.
        const heightFromLight = y + grainDirection + 30 * (bundle - 0.5) - (400 + progress * 910);
        const shoulder = 0.66 * bell(heightFromLight, 111) + 0.34 * bell(heightFromLight - 52, 175);
        const trailingShade = bell(heightFromLight + 184, 116);
        const swing =
          upperCloth *
          bell(x - (1235 + 240 * progress), 405) *
          ((dark ? 46 : 51) * shoulder * (0.69 + 0.28 * bundle + 0.12 * yarn) -
            (dark ? 15 : 26) * trailingShade * (0.85 + 0.15 * bundle));
        const delta =
          (swing + grazing + stitch) * boundary * smooth(0, 0.16, progress) * (1 - smooth(0.84, 1, progress));
        const tint = delta >= 0 ? lift : shade;
        const alpha = Math.round(
          255 * Math.min(0.68, Math.abs(delta) / Math.max(1, Math.abs(tintLuma(tint) - source))),
        );
        if (!alpha) continue;
        const tile = sample - 1;
        const i =
          4 * ((Math.floor(tile / columns) * tileHeight + py) * atlasWidth + ((tile % columns) * tileWidth + px));
        out[i] = tint[0];
        out[i + 1] = tint[1];
        out[i + 2] = tint[2];
        out[i + 3] = alpha;
      }
    }
  }
  ffmpeg(
    [
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${atlasWidth}x${atlasHeight}`,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-lossless",
      "1",
      "-y",
      file(`right-sweep-${mode}.webp`),
    ],
    out,
  );
}

bake("dark");
bake("light");
