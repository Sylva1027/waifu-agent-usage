import { makeFoldPainter } from "./claude-breeze-folds.mjs";
import { makeLeafPainter } from "./claude-breeze-leaf.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firstPose, lastPose, patches, plate, tile } from "../public/dev/waifu-visuals/claude-ambient/breeze-patches.js";

import { lightFolds, lightLeaf } from "./claude-light-traces.mjs";

const theme = process.argv[2] ?? "dark";
if (theme !== "dark" && theme !== "light") throw new Error("Expected light or dark");
const directory = new URL("../public/dev/waifu-visuals/claude-ambient/art/", import.meta.url);
const ffmpeg = (args, input) => execFileSync("ffmpeg", ["-v", "error", ...args], { input, maxBuffer: 32 * 1024 * 1024 });
const source = ffmpeg(["-i", fileURLToPath(new URL(`left-${theme}.webp`, directory)), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
if (source.length !== plate.width * plate.height * 3) throw new Error("Unexpected Claude plate dimensions");
const width = tile * patches.length;
const height = tile * (lastPose - firstPose + 1);
const pixels = Buffer.alloc(width * height * 4);

function sample(x, y, channel) {
  const ix = Math.max(0, Math.min(plate.width - 2, Math.floor(x)));
  const iy = Math.max(0, Math.min(plate.height - 2, Math.floor(y)));
  const tx = Math.max(0, Math.min(1, x - ix));
  const ty = Math.max(0, Math.min(1, y - iy));
  const src = (iy * plate.width + ix) * 3 + channel;
  const below = src + plate.width * 3;
  const upper = source[src] + tx * (source[src + 3] - source[src]);
  const lower = source[below] + tx * (source[below + 3] - source[below]);
  return Math.round(upper + ty * (lower - upper));
}

for (const [column, patch] of patches.entries()) {
  const paint = patch.center
    ? makeFoldPainter(patch, tile, sample, theme === "light" ? lightFolds[patch.name] : undefined)
    : makeLeafPainter(patch, tile, sample, theme === "light" ? lightLeaf : undefined);
  for (let pose = firstPose; pose <= lastPose; pose++) {
    if (pose === 0) continue; // The transparent rest pose reveals the approved still plate.
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const out = (((pose - firstPose) * tile + y) * width + column * tile + x) * 4;
        paint(x, y, pose / lastPose, pixels, out);
      }
    }
  }
}

ffmpeg(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "-",
  "-frames:v", "1", "-c:v", "libwebp", "-lossless", "1", "-compression_level", "6",
  fileURLToPath(new URL(`breeze-${theme}.webp`, directory))], pixels);
