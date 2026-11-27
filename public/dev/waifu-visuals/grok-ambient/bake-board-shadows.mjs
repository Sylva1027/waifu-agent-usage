// Bake visibility of the final left-hand area light. Camera and floor coordinates
// are shared with the rolling mesh. Heights in a light sample's board projection
// also tell us when the queen intercepts light on the pawn itself.
import { LatheGeometry, Vector2, Vector3 } from "three";

import { castBounds } from "./board-shadow.js";

export function createBoardShadowBaker({ normal, floor, screen, raster, indices, samples, rimY }) {
  const { x, y, width, height } = castBounds;
  const dx = 1932 - x,
    dy = 162 - y;
  const sw = width * samples,
    sh = height * samples;

  // Back-project the photographed centre of the queen's foot onto the board.
  const sx = 1889.5 - 1932,
    sy = 182.1 - 162;
  const intercept = normal.x * sx - normal.y * sy;
  const z = (floor - intercept) / (normal.z - intercept / 2200);
  const foot = new Vector3(sx * (1 - z / 2200), -sy * (1 - z / 2200), z);
  const across = new Vector3(1, -0.13, (0.13 * normal.y - normal.x) / normal.z).normalize();
  const along = new Vector3().crossVectors(normal, across).normalize();

  // The plinth, turned shaft, velvet cap and pearl have circular sections.
  // The brass crown has eight raised points around the cap.
  const profile = [
    [0, 32],
    [3, 34],
    [7, 34],
    [10, 32],
    [12, 29],
    [16, 28],
    [21, 25],
    [28, 23],
    [35, 21],
    [42, 19],
    [55, 15],
    [66, 13],
    [70, 14],
    [73, 19],
    [77, 20],
    [84, 20],
    [90, 22],
    [98, 21],
    [107, 16],
    [111, 8],
    [112, 4],
    [115, 6],
    [119, 5],
    [122, 1],
  ];
  const turn = new LatheGeometry(
    profile.map(([h, r]) => new Vector2(r, h)),
    96,
  );
  const queenIndices = Array.from(turn.index.array);
  const queen = [];
  const position = turn.attributes.position;
  const onQueen = (h, a, r) =>
    foot
      .clone()
      .addScaledVector(normal, h)
      .addScaledVector(across, r * Math.cos(a))
      .addScaledVector(along, r * Math.sin(a));
  for (let i = 0; i < position.count; i++) {
    queen.push(
      foot
        .clone()
        .addScaledVector(normal, position.getY(i))
        .addScaledVector(across, position.getX(i))
        .addScaledVector(along, -position.getZ(i)),
    );
  }
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4,
      first = queen.length;
    queen.push(onQueen(88, a - 0.31, 21), onQueen(88, a + 0.31, 21), onQueen(116, a, 23.5));
    // A thin brass point has two casting faces.
    queenIndices.push(first, first + 1, first + 2, first, first + 2, first + 1);
  }

  function project(pos, h, ray) {
    const [u, v] = screen(pos.clone().addScaledVector(ray, -h));
    return { x: u + dx, y: v + dy, z: h };
  }
  const sampleCount = 24;
  const lights = Array.from({ length: sampleCount }, (_, i) => {
    const r = Math.sqrt((i + 0.5) / sampleCount),
      a = i * 2.39996323;
    // Upper-left source, projected to the right and slightly down on the board.
    // Sampling its aperture gives the elevated crown a wider penumbra than the foot.
    const ray = normal
      .clone()
      .addScaledVector(across, -1.05 + 0.09 * r * Math.cos(a))
      .addScaledVector(along, 0.13 * r * Math.sin(a));
    ray.divideScalar(ray.dot(normal));
    const depth = new Float32Array(sw * sh);
    const projection = queen.map((pos) => project(pos, Math.max(0, pos.dot(normal) - floor), ray));
    raster(
      projection,
      (k, _i, _j, _l, _a, _b, _c, h) => {
        depth[k] = Math.max(depth[k], h);
      },
      queenIndices,
      sw,
      sh,
    );
    return { ray, depth };
  });

  return function cast(points) {
    const heights = points.map((p) => Math.max(0, p.pos.dot(normal) - floor));
    const mesh = points.map((p) => ({ x: p.x + dx, y: p.y + dy, z: p.z }));
    const visible = new Map();
    raster(
      mesh,
      (k, i, j, l, a, b, c, z) => {
        if (visible.has(k) && visible.get(k).pos.z >= z) return;
        const pos = points[i].pos
          .clone()
          .multiplyScalar(a)
          .addScaledVector(points[j].pos, b)
          .addScaledVector(points[l].pos, c);
        visible.set(k, { pos, h: Math.max(0, pos.dot(normal) - floor) });
      },
      indices,
      sw,
      sh,
    );
    const sum = new Float32Array(width * height);
    for (const { ray, depth } of lights) {
      const blocked = new Uint8Array(sw * sh);
      const projected = points.map((p, i) => project(p.pos, heights[i], ray));
      raster(
        projected,
        (k) => {
          blocked[k] = 1;
        },
        indices,
        sw,
        sh,
      );
      for (let j = 0; j < sh; j++)
        for (let i = 0; i < sw; i++) {
          const k = j * sw + i;
          if ((j + 0.5) / samples - dy > rimY((i + 0.5) / samples - dx)) blocked[k] = 0;
          else if (depth[k] > 0) blocked[k] = 1;
        }
      // Where the pawn is visible, sample the queen at the pawn's height instead of the floor.
      for (const [k, { pos, h }] of visible) {
        const p = project(pos, h, ray);
        const u = Math.floor(p.x * samples),
          v = Math.floor(p.y * samples);
        blocked[k] = u >= 0 && u < sw && v >= 0 && v < sh && depth[v * sw + u] > h + 0.4 ? 1 : 0;
      }
      for (let j = 0; j < sh; j++)
        for (let i = 0; i < sw; i++)
          sum[Math.floor(j / samples) * width + Math.floor(i / samples)] += blocked[j * sw + i];
    }
    const rgba = Buffer.alloc(width * height * 4);
    const norm = 255 / (sampleCount * samples * samples);
    for (let i = 0; i < sum.length; i++) rgba[i * 4 + 3] = Math.round(sum[i] * norm);
    return rgba;
  };
}
