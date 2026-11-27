// Offline Three.js mesh rendering. Runtime playback only composites the baked poses.
import { createBoardShadowBaker } from "./bake-board-shadows.mjs";
import { castBounds } from "./board-shadow.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LatheGeometry, Vector2, Vector3, Quaternion } from "three";

const dir = process.argv[2] || fileURLToPath(new URL(".", import.meta.url));
const out = process.argv[3] || dir;
const W = 105,
  H = 90,
  F = 49,
  columns = 7,
  samples = 3;
const v3 = (x, y, z) => new Vector3(x, y, z);
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const mix = (a, b, t) => a * (1 - t) + b * t;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const run = (args, options = {}) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { maxBuffer: 24 * 1024 * 1024, ...options });

// Axisymmetric turned profile in photograph pixels, from the felt disk to the crown.
// The crown is a low rounded button beyond a narrow collar. The brown cast shadow
// beneath the button has no corresponding surface in this profile.
const profile = [
  [0.15, 0.01],
  [0.14, 18.8],
  [0.12, 20.6],
  [0.02, 20.95],
  [-0.08, 21.55],
  [0, 22.3],
  [0.5, 23.15],
  [1.5, 23.9],
  [3.2, 24.05],
  [5.3, 23.8],
  [7, 23.2],
  [9, 22.1],
  [11.1, 20.6],
  [13.1, 18.7],
  [15.2, 16.4],
  [17.5, 14.6],
  [20.8, 12.75],
  [24.5, 11.85],
  [28.6, 11.6],
  [32.8, 11.8],
  [35.0, 12.15],
  [36.0, 13.6],
  [36.6, 14.1],
  [38, 14.35],
  [39.5, 13.95],
  [40.9, 12.8],
  [41.8, 11.8],
  [43.3, 11.5],
  [44.5, 12.4],
  [46, 14.6],
  [48.2, 16.3],
  [50.6, 17.25],
  [53, 17.8],
  [55.4, 17.7],
  [57.0, 17.0],
  [58.1, 16.15],
  [59.15, 15.95],
  [60, 16.05],
  [61.2, 15.7],
  [63, 14.85],
  [64.7, 13.25],
  [66, 11.25],
  [67.2, 8.25],
  [68.1, 4.15],
  [68.35, 0.01],
];
const geom = new LatheGeometry(
  profile.map(([s, r]) => new Vector2(r, s)),
  144,
);
const axis = v3(0.853, 0.107, -0.508).normalize();
const up = v3(0, 1, 0),
  toCamera = v3(0, 0, 1);
const mount = new Quaternion().setFromUnitVectors(up, axis);
const origin = v3(22.8, -34.0, 0);

// Find the common tangent under the two turned rings. This keeps both
// bearings on the board at every heading and pins the actual small-end contact.
const lift = v3(0.006, 0.88, 0.452);
lift.addScaledVector(axis, -lift.dot(axis)).normalize();
function bearing(slope, from, to) {
  let best = from;
  for (let i = from + 1; i < to; i++)
    if (profile[i][1] - slope * profile[i][0] > profile[best][1] - slope * profile[best][0]) best = i;
  return best;
}
const split = profile.findIndex(([s]) => s > 40);
function tangentError(slope) {
  const [a, ra] = profile[bearing(slope, 0, split)],
    [b, rb] = profile[bearing(slope, split, profile.length)];
  return (b - a) * slope - (rb - ra);
}
let slopeMin = -0.4,
  slopeMax = 0;
for (let i = 0; i < 48; i++) {
  const m = (slopeMin + slopeMax) / 2;
  if (tangentError(m) < 0) slopeMin = m;
  else slopeMax = m;
}
const slope = (slopeMin + slopeMax) / 2;
const boardNormal = lift.clone().addScaledVector(axis, slope).normalize();
const heelIndex = bearing(slope, 0, split),
  headIndex = bearing(slope, split, profile.length);
function contact(i) {
  const [s, r] = profile[i];
  return origin.clone().addScaledVector(axis, s).addScaledVector(lift, -r);
}
const radius = profile[heelIndex][1];
const heel = contact(heelIndex),
  head = contact(headIndex);
const floorHeight = boardNormal.dot(heel);
assert.ok(Math.abs(floorHeight - boardNormal.dot(head)) < 1e-8);
const distance = heel.distanceTo(head);
const key = v3(-0.52, 0.8, 0.62).normalize(),
  half = key.clone().add(toCamera).normalize();
const screen = (p) => [(p.x * 2200) / (2200 - p.z), (-p.y * 2200) / (2200 - p.z)];
const idx = geom.index.array;
const vertices = Array.from({ length: geom.attributes.position.count }, (_, i) => {
  const p = new Vector3().fromBufferAttribute(geom.attributes.position, i);
  const n = new Vector3().fromBufferAttribute(geom.attributes.normal, i).applyQuaternion(mount);
  return { s: p.y, r: Math.hypot(p.x, p.z), p: p.applyQuaternion(mount).add(origin), n };
});

const tip = profile.length - 1;
const referenceLength = vertices[0].p.distanceTo(vertices[tip].p);
function pose(angle) {
  const orbit = new Quaternion().setFromAxisAngle(boardNormal, angle);
  const spin = new Quaternion().setFromAxisAngle(axis, (angle * distance) / radius);
  const quat = orbit.clone().multiply(spin);
  const points = vertices.map(({ p, n }) => {
    const pos = p.clone().sub(origin).applyQuaternion(spin).add(origin).sub(head).applyQuaternion(orbit).add(head);
    const [x, y] = screen(pos);
    return { x, y, z: pos.z, pos, n: n.clone().applyQuaternion(quat) };
  });
  assert.ok(Math.abs(points[0].pos.distanceTo(points[tip].pos) - referenceLength) < 1e-8);
  for (const p of points) assert.ok(p.pos.dot(boardNormal) >= floorHeight - 1e-5, "Pawn penetrates the board");
  return points;
}
const rimY = (x) => 75.5 - 0.095 * x;
let low = 0,
  high = 1.2;
const gap = (t) => Math.min(...pose(t).map((p) => rimY(p.x) - p.y));
assert.ok(gap(0) > 0 && gap(high) < 0, "Rolling arc must intersect the brass rim");
for (let i = 0; i < 30; i++) {
  const t = (low + high) / 2;
  if (gap(t) > 0) low = t;
  else high = t;
}
const limit = high;
const rimPose = pose(limit);
const closest = rimPose.reduce((a, b, i) => (rimY(b.x) - b.y < rimY(rimPose[a].x) - rimPose[a].y ? i : a), 0);
assert.ok(vertices[closest].s < 12 && Math.abs(gap(limit)) < 1e-6, "Only the base lip should meet the rim");
console.log(
  "rest contact projections",
  screen(head),
  screen(heel),
  "rim angle",
  limit,
  "axial roll",
  (limit * distance) / radius,
);
const rw = W * samples,
  rh = H * samples;
function raster(points, visit, triangles = idx, rasterWidth = rw, rasterHeight = rh) {
  for (let j = 0; j < triangles.length; j += 3) {
    const a = points[triangles[j]],
      b = points[triangles[j + 1]],
      c = points[triangles[j + 2]];
    const dx1 = b.x - a.x,
      dy1 = b.y - a.y,
      dx2 = c.x - a.x,
      dy2 = c.y - a.y;
    const det = dx1 * dy2 - dy1 * dx2;
    if (det >= -1e-6) continue;
    const xs = Math.max(0, Math.floor(samples * Math.min(a.x, b.x, c.x))),
      xe = Math.min(rasterWidth, Math.ceil(samples * Math.max(a.x, b.x, c.x)));
    const ys = Math.max(0, Math.floor(samples * Math.min(a.y, b.y, c.y))),
      ye = Math.min(rasterHeight, Math.ceil(samples * Math.max(a.y, b.y, c.y)));
    for (let y = ys; y < ye; y++)
      for (let x = xs; x < xe; x++) {
        const px = (x + 0.5) / samples - a.x,
          py = (y + 0.5) / samples - a.y;
        const u = (px * dy2 - py * dx2) / det,
          v = (dx1 * py - dy1 * px) / det,
          w = 1 - u - v;
        if (u >= 0 && v >= 0 && w >= 0)
          visit(
            y * rasterWidth + x,
            triangles[j],
            triangles[j + 1],
            triangles[j + 2],
            w,
            u,
            v,
            a.z * w + b.z * u + c.z * v,
          );
      }
  }
}
const rest = pose(0);
const restDepth = new Float32Array(rw * rh).fill(-Infinity);
raster(rest, (k, i, j, l, a, b, c, z) => {
  restDepth[k] = Math.max(restDepth[k], z);
});
function light(nx, ny, nz, felt) {
  const nl = Math.max(0, nx * key.x + ny * key.y + nz * key.z);
  const nh = Math.max(0, nx * half.x + ny * half.y + nz * half.z);
  return (felt ? 0.71 : 0.44) + (felt ? 0.39 : 0.66) * nl + (felt ? 0.03 : 0.17) * nh ** (felt ? 9 : 22);
}

// Reconstruct the photographed stones once, in the desk image's pixel space.
// Each seam is registered on exposed pixels on BOTH sides of the original pawn.
function repairBoard(desk, silhouette) {
  const rgba = Buffer.alloc(W * H * 4);
  const source = (x, y, c) => desk[((162 + y) * 2048 + 1932 + x) * 3 + c];
  const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < 68 && silhouette[y * W + x] > 90;
  const boundary = [];
  for (let y = 0; y < 68; y++)
    for (let x = 0; x < W; x++)
      if (solid(x, y) && (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1)))
        boundary.push([x, y]);
  function distance(x, y) {
    if (solid(x, y)) return 0;
    let d = Infinity;
    for (const [px, py] of boundary) d = Math.min(d, (x - px) ** 2 + (y - py) ** 2);
    return Math.sqrt(d);
  }
  function coverage(x, y) {
    const piece = 1 - smooth(0.8, 3.8, distance(x, y));
    const penumbra = Math.min(distance(x - 4, y - 6), distance(x - 10, y - 11));
    const shadow = 1 - smooth(4, 17, penumbra);
    const rightFeather = 1 - smooth(W - 7, W - 0.5, x);
    return Math.max(piece, shadow * rightFeather) * (1 - smooth(-2, -0.8, y + 0.5 - rimY(x + 0.5)));
  }
  function edges(x, y) {
    const left = mix(4.1 + 0.67 * (y - 16), 32.58 + 0.62 * (y - 64), smooth(16, 64, y));
    const right = 82.35 + 0.765 * y;
    const cross = 31.91 - 0.1105 * x;
    return [x - left, x - right, y - cross];
  }
  const groups = Array.from({ length: 6 }, () => []);
  for (let y = -10; y < 73; y += 2)
    for (let x = -17; x < 116; x += 2) {
      if ((x < -5 && y < 38) || y >= rimY(x) - 4 || coverage(x, y) > 0.015) continue;
      const ds = edges(x + 0.5, y + 0.5);
      if (ds.some((t) => Math.abs(t) < 2.3)) continue;
      const cell = Number(ds[0] > 0) + Number(ds[1] > 0) + (ds[2] > 0 ? 3 : 0);
      groups[cell].push([x, y, source(x, y, 0), source(x, y, 1), source(x, y, 2)]);
    }
  // Use the lighting of this individual square, then add a little measured stone grain.
  function stoneGrain(group, x, y) {
    // These two interior samples come from the same photograph and stay
    // clear of piece silhouettes, gold trim and checker edges in both themes.
    const fold = (v, size) => size - Math.abs(size - (Math.abs(v) % (2 * size)));
    const pale = group % 2 === 0;
    const sy = (pale ? 78 : 47) + fold(y, 16);
    const sx = Math.round((pale ? 1960 : 1938) + 0.8 * (sy - (pale ? 78 : 47)) + fold(x - 0.7 * y, 54));
    const channel = (dx, dy) => desk[((sy + dy) * 2048 + sx + dx) * 3];
    return channel(0, 0) - (channel(-3, -1) + channel(3, -1) + channel(-2, 2) + channel(2, 2)) / 4;
  }
  function color(group, x, y) {
    const color = [0, 0, 0];
    let total = 0;
    for (const [px, py, r, g, b] of groups[group]) {
      const w = (25 + (px - x) ** 2 + (py - y) ** 2) ** -1.35;
      total += w;
      color[0] += r * w;
      color[1] += g * w;
      color[2] += b * w;
    }
    assert.ok(total > 0);
    const grain = 0.44 * stoneGrain(group, x, y);
    return color.map((value) => value / total + grain);
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const m = coverage(x, y);
      if (m < 0.5 / 255) continue;
      const [l, r, h] = edges(x + 0.5, y + 0.5).map((v) => smooth(-0.95, 0.95, v));
      const cols = [1 - l, l - r, r],
        rows = [1 - h, h];
      const i = (y * W + x) * 4;
      const result = [0, 0, 0];
      for (let row = 0; row < 2; row++)
        for (let col = 0; col < 3; col++) {
          const w = rows[row] * cols[col];
          if (w <= 0) continue;
          const rgb = color(row * 3 + col, x, y);
          for (let c = 0; c < 3; c++) result[c] += w * rgb[c];
        }
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(clamp(result[c], 0, 255));
      rgba[i + 3] = Math.round(m * 255);
    }
  return rgba;
}

// Sample the penumbra of a finite lamp. Each surface casts onto the board
// along the light direction, so shaft, lip, and head have different offsets.
const lampSamples = Array.from({ length: 28 }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / 28),
    a = i * 2.39996323;
  return v3(-0.28 + 0.41 * r * Math.cos(a), 0.91 + 0.12 * r * Math.sin(a), 0.39 + 0.43 * r * Math.sin(a)).normalize();
});
function castShadow(points) {
  const opacity = new Float32Array(W * H);
  for (const light of lampSamples) {
    const projected = points.map(({ pos }) => {
      const h = Math.max(0, boardNormal.dot(pos) - floorHeight);
      const [x, y] = screen(pos.clone().addScaledVector(light, -h / boardNormal.dot(light)));
      return { x, y, z: 0 };
    });
    const shadow = new Uint8Array(rw * rh);
    raster(projected, (k) => {
      shadow[k] = 1;
    });
    for (let y = 0; y < rh; y++)
      for (let x = 0; x < rw; x++)
        if (shadow[y * rw + x]) opacity[Math.floor(y / samples) * W + Math.floor(x / samples)]++;
  }
  const norm = lampSamples.length * samples * samples;
  const kernel = [1, 4, 7, 10, 7, 4, 1];
  function soften(buffer, dx, dy) {
    return buffer.map(
      (_, i) =>
        kernel.reduce((sum, w, j) => {
          const x = clamp((i % W) + (j - 3) * dx, 0, W - 1),
            y = clamp(Math.floor(i / W) + (j - 3) * dy, 0, H - 1);
          return sum + w * buffer[y * W + x];
        }, 0) / 34,
    );
  }
  return soften(soften(opacity, 1, 0), 0, 1).map((o, i) => (0.8 * o + 0.2 * opacity[i]) / norm);
}

function ambientShadow(pts, angle) {
  const shadow = castShadow(pts);
  const contacts = [head, heel.clone().sub(head).applyAxisAngle(boardNormal, angle).add(head)].map(screen);
  return shadow.map((coverage, i) => {
    const x = (i % W) + 0.5,
      y = Math.floor(i / W) + 0.5;
    const board = 1 - smooth(-1, 0.1, y - rimY(x));
    const contact = Math.max(
      ...contacts.map(([px, py]) => Math.exp(-((x - px) ** 2 / 82 + (y - py - 0.2) ** 2 / 7.5))),
    );
    return 1 - (1 - board * coverage * 0.18) * (1 - board * contact * 0.38);
  });
}

function frame(photo, mode, pts, angle) {
  const rgb = new Uint8Array(rw * rh * 4),
    depth = new Float32Array(rw * rh).fill(-Infinity);
  const base = mode === "dark" ? [146, 119, 89] : [214, 183, 143],
    feltColor = mode === "dark" ? [82, 30, 37] : [105, 40, 48];
  raster(pts, (k, i, j, l, a, b, c, z) => {
    if (z <= depth[k]) return;
    depth[k] = z;
    const va = vertices[i],
      vb = vertices[j],
      vc = vertices[l];
    const coord = (a0, b0, c0) => a * a0 + b * b0 + c * c0;
    const get = (field, component) => coord(va[field][component], vb[field][component], vc[field][component]);
    const x = get("p", "x"),
      y = get("p", "y"),
      oz = get("p", "z"),
      ox = (x * 2200) / (2200 - oz),
      oy = (-y * 2200) / (2200 - oz);
    const r = coord(va.r, vb.r, vc.r),
      s = coord(va.s, vb.s, vc.s);
    const felt = s < 0.25 && r < 20.9;
    const material = felt ? feltColor : base;
    const normal = (source, part) => coord(source[i].n[part], source[j].n[part], source[l].n[part]);
    const nx = get("n", "x"),
      ny = get("n", "y"),
      nz = get("n", "z");
    const before = light(nx, ny, nz, felt),
      now = light(normal(pts, "x"), normal(pts, "y"), normal(pts, "z"), felt);
    const sx = clamp(Math.floor(ox * samples), 0, rw - 1),
      sy = clamp(Math.floor(oy * samples), 0, rh - 1);
    const seen = smooth(0.02, 0.38, nz) * (1 - smooth(0.45, 2.1, Math.max(0, restDepth[sy * rw + sx] - oz)));
    const ix = Math.floor(ox - 0.5),
      iy = Math.floor(oy - 0.5),
      fx = ox - 0.5 - ix,
      fy = oy - 0.5 - iy;
    const upward =
      normal(pts, "x") * boardNormal.x + normal(pts, "y") * boardNormal.y + normal(pts, "z") * boardNormal.z;
    const h =
      a * pts[i].pos.dot(boardNormal) + b * pts[j].pos.dot(boardNormal) + c * pts[l].pos.dot(boardNormal) - floorHeight;
    const ambient = felt ? 1 : 1 - (0.26 + 0.12 * (1 - smooth(0, 7, h))) * (1 - smooth(-0.75, 0.1, upward));
    const cut = 1 - 0.1 * Math.exp(-((s - 59.1) ** 2) / 0.68) - 0.068 * Math.exp(-((s - 42.65) ** 2) / 1.7);
    for (let ch = 0; ch < 3; ch++) {
      const pix = (dx, dy) => photo[((iy + dy) * W + ix + dx) * 3 + ch];
      const tex = mix(mix(pix(0, 0), pix(1, 0), fx), mix(pix(0, 1), pix(1, 1), fx), fy);
      const grain = clamp(tex / before - material[ch], felt ? -55 : -56, felt ? 55 : 56);
      rgb[k * 4 + ch] = clamp(
        (material[ch] + grain * seen * (felt ? 1 : 0.82)) * now * ambient * (felt ? 1 : cut),
        0,
        255,
      );
    }
    rgb[k * 4 + 3] = 255;
  });
  const shadow = mode === "dark" ? ambientShadow(pts, angle) : null;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sum = [0, 0, 0];
      let n = 0;
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const k = ((y * samples + sy) * rw + x * samples + sx) * 4;
          if (!rgb[k + 3]) continue;
          for (let c = 0; c < 3; c++) sum[c] += rgb[k + c];
          n++;
        }
      const dst = (y * W + x) * 4;
      const i = y * W + x,
        alpha = n / (samples * samples);
      const shade = shadow?.[i] ?? 0;
      const opacity = alpha + (1 - alpha) * shade;
      rgba[dst + 3] = Math.round(255 * opacity);
      if (n) for (let c = 0; c < 3; c++) rgba[dst + c] = Math.round(sum[c] / (samples * samples * opacity));
    }
  return rgba;
}
function writeWebp(name, width, height, pixels) {
  run(
    [
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      width + "x" + height,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-lossless",
      "1",
      name,
    ],
    { cwd: out, input: pixels },
  );
}
// The stationary backdrop and the first moving frame use the same shadow-free stones and pose.
function writeLightRest(body) {
  const left = 1838,
    top = 147,
    width = 210,
    height = 94;
  const clean = run(["-i", "pawn-board-light.webp", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { cwd: dir });
  assert.equal(clean.length, width * height * 3);
  const overlay = Buffer.alloc(2048 * 1152 * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bx = x + left - 1932,
        by = y + top - 162;
      const src = 4 * (by * W + bx);
      const alpha = bx >= 0 && bx < W && by >= 0 && by < H ? body[src + 3] / 255 : 0;
      const dst = 4 * ((y + top) * 2048 + x + left);
      for (let c = 0; c < 3; c++) {
        const stone = clean[3 * (y * width + x) + c];
        overlay[dst + c] = alpha ? Math.round(mix(stone, body[src + c], alpha)) : stone;
      }
      overlay[dst + 3] = 255;
    }
  }
  writeWebp("board-rest-light.webp", 2048, 1152, overlay);
}
for (const mode of ["light", "dark"]) {
  const desk = run(["-i", "desk-" + mode + ".webp", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { cwd: dir });
  const photo = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const first = ((162 + y) * 2048 + 1932) * 3;
    desk.copy(photo, y * W * 3, first, first + W * 3);
  }
  if (mode === "dark") {
    const matte = run(
      [
        "-i",
        "pawn-" + mode + ".webp",
        "-vf",
        "crop=105:68:105:0:exact=1,alphaextract",
        "-pix_fmt",
        "gray",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { cwd: dir },
    );
    writeWebp("pawn-board-" + mode + ".webp", W, H, repairBoard(desk, matte));
  }
  const atlas = Buffer.alloc(W * columns * H * columns * 4);
  const cast =
    mode === "dark" &&
    createBoardShadowBaker({
      normal: boardNormal,
      floor: floorHeight,
      screen,
      raster,
      indices: idx,
      samples,
      rimY,
    });
  const castAtlas = cast && Buffer.alloc(castBounds.width * castBounds.height * F * 4);
  for (let f = 0; f < F; f++) {
    const angle = (f / (F - 1)) * limit;
    const points = pose(angle);
    const pixels = frame(photo, mode, points, angle);
    if (mode === "light" && f === 0) writeLightRest(pixels);
    if (cast) {
      const shade = cast(points);
      const { width, height } = castBounds;
      for (let y = 0; y < height; y++) {
        const row = (Math.floor(f / columns) * height + y) * width * columns + (f % columns) * width;
        shade.copy(castAtlas, row * 4, y * width * 4, (y + 1) * width * 4);
      }
    }
    for (let y = 0; y < H; y++)
      pixels.copy(
        atlas,
        ((Math.floor(f / columns) * H + y) * W * columns + (f % columns) * W) * 4,
        y * W * 4,
        (y + 1) * W * 4,
      );
  }
  if (cast) writeWebp("board-cast-dark.webp", castBounds.width * columns, castBounds.height * columns, castAtlas);
  writeWebp("pawn-roll-" + mode + ".webp", W * columns, H * columns, atlas);
}
