import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const width = 768;
const height = 512;
const radius = 10;
const themes = {
  light: { color: [229, 246, 255], floor: 1.1, span: 12, alpha: 163 },
  dark: { color: [137, 194, 234], floor: 0.9, span: 12, alpha: 129 },
};

function ffmpeg(args, input) {
  const result = spawnSync("ffmpeg", ["-v", "error", ...args], { input, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status) throw new Error(result.stderr.toString());
  return result.stdout;
}

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ramp(x, start, end) {
  const t = Math.min(1, Math.max(0, (x - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

// Compress only the bright reflections around the left silhouette.
function prepareDarkBackground(input) {
  const width = 1536;
  const height = 1024;
  const output = fileURLToPath(new URL("./background-dark.webp", import.meta.url));
  const rgb = ffmpeg(["-i", input, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  if (rgb.length !== width * height * 3) throw new Error("DeepSeek dark source must be 1536 × 1024");
  for (let i = 0; i < rgb.length; i += 3) {
    const x = ((i / 3) % width) / width;
    const tone = luminance(rgb[i], rgb[i + 1], rgb[i + 2]);
    const protection = 1 - ramp(x, 0.29, 0.59);
    const reduction = Math.max(0, tone - 62) * 0.56 * protection;
    if (reduction === 0) continue;
    const gain = 1 - reduction / tone;
    rgb[i] = Math.round(rgb[i] * gain);
    rgb[i + 1] = Math.round(rgb[i + 1] * gain);
    rgb[i + 2] = Math.round(rgb[i + 2] * gain);
  }
  ffmpeg(
    [
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${width}x${height}`,
      "-i",
      "-",
      "-c:v",
      "libwebp",
      "-quality",
      "94",
      "-preset",
      "photo",
      output,
    ],
    rgb,
  );
}

const darkOriginal = process.argv[2];
if (darkOriginal) prepareDarkBackground(darkOriginal);

// The local average removes broad illumination, leaving the fine ridges that can catch light.
function blur(source, horizontal) {
  const target = new Float32Array(width * height);
  const rows = horizontal ? width : 1;
  const columns = horizontal ? 1 : width;
  const rowCount = horizontal ? height : width;
  const columnCount = horizontal ? width : height;
  for (let row = 0; row < rowCount; row++) {
    const base = row * rows;
    let sum = source[base] * radius;
    for (let column = 0; column <= radius; column++) sum += source[base + column * columns];
    for (let column = 0; column < columnCount; column++) {
      target[base + column * columns] = sum / (2 * radius + 1);
      sum += source[base + Math.min(columnCount - 1, column + radius + 1) * columns];
      sum -= source[base + Math.max(0, column - radius) * columns];
    }
  }
  return target;
}

for (const [theme, { color, floor, span, alpha }] of Object.entries(themes)) {
  const input = fileURLToPath(new URL(`./background-${theme}.webp`, import.meta.url));
  const output = fileURLToPath(new URL(`./glints-${theme}.webp`, import.meta.url));
  const rgb = ffmpeg([
    "-i",
    input,
    "-vf",
    `scale=${width}:${height}:flags=lanczos`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  if (rgb.length !== width * height * 3) throw new Error(`Unexpected DeepSeek image dimensions for ${theme}`);
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) {
    values[i] = luminance(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  }
  const smooth = blur(blur(values, true), false);
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < values.length; i++) {
    // Keep the reflections on the quieter right-hand ridges readable without flattening their detail.
    const extension = theme === "dark" ? ramp((i % width) / width, 0.5, 0.92) : 0;
    const contrast = values[i] - smooth[i] - (floor - extension * 0.65);
    const ridge = Math.min(1, Math.max(0, contrast / (span - extension * 5.5)));
    const offset = i * 4;
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    const gain = theme === "dark" ? 0.63 + 0.37 * ramp((i % width) / width, 0.31, 0.59) : 1;
    rgba[offset + 3] = Math.round(alpha * gain * ridge ** 0.9);
  }
  ffmpeg(
    [
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${width}x${height}`,
      "-i",
      "-",
      "-c:v",
      "libwebp",
      "-lossless",
      "1",
      output,
    ],
    rgba,
  );
}
