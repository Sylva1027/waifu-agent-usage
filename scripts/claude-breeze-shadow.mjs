// Work in rays on the receiving paper. The upper-left key in the artwork throws
// shadows down and right. Measure only the smooth illumination along each ray;
// the receiving sheet's fine grain stays in its original image coordinates.
const lightX = 0.54;
const lightY = Math.sqrt(1 - lightX * lightX);
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const mix = (a, b, t) => a + (b - a) * t;

export function makeCastShadow(patch, size, rim, sample, sourcePoint) {
  const leaf = patch.name === "loose-leaf";
  const extent = leaf ? 108 : 43;
  const points = rim.map(([x, y]) => ({ x, y, s: -lightY * x + lightX * y, t: lightX * x + lightY * y }));
  const first = Math.ceil(Math.min(...points.map(p => p.s))) + 1;
  const last = Math.floor(Math.max(...points.map(p => p.s))) - 1;
  const rays = [];

  for (let s = first; s <= last; s++) {
    let end = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if ((a.s > s) === (b.s > s)) continue;
      end = Math.max(end, mix(a.t, b.t, (s - a.s) / (b.s - a.s)));
    }
    const x = end * lightX - s * lightY, y = end * lightY + s * lightX;
    // sourcePoint is the inverse material warp. Recover the actual motion of
    // this silhouette point so the contact end of its shadow follows the edge.
    let u = x, v = y;
    for (let k = 0; k < 4; k++) {
      const [sx, sy] = sourcePoint(u, v, 1) ?? [u, v];
      u += x - sx;
      v += y - sy;
    }
    const dx = u - x, dy = v - y;
    const radiance = new Float32Array(extent + 1);
    for (let r = 0; r <= extent; r++) {
      // Bypass the tiny bright antialiasing fringe on the occluder's edge.
      const d = Math.max(r, leaf ? 3.5 : 2.6);
      const px = patch.x + x + lightX * d, py = patch.y + y + lightY * d;
      radiance[r] = 0.299 * sample(px, py, 0) + 0.587 * sample(px, py, 1) + 0.114 * sample(px, py, 2);
    }
    rays.push({ end, ds: -lightY * dx + lightX * dy, dt: lightX * dx + lightY * dy, radiance });
  }

  const spread = leaf ? 3 : 2;
  const kernel = [1, 4, 6, 4, 1];
  const density = rays.map((ray, i) => {
    const filtered = new Float32Array(extent + 1);
    for (let r = 0; r <= extent; r++) {
      for (let j = -2; j <= 2; j++) {
        const neighbor = rays[clamp(i + j * spread, 0, rays.length - 1)].radiance;
        for (let k = -2; k <= 2; k++) {
          filtered[r] += kernel[j + 2] * kernel[k + 2] * neighbor[clamp(r + k * spread, 0, extent)] / 256;
        }
      }
    }
    const lit = filtered.slice(-8).reduce((sum, v) => sum + v, 0) / 8;
    let reach = 0;
    for (let r = 0; r <= extent; r++) {
      const measured = Math.log(Math.max(1, lit) / Math.max(1, filtered[r]));
      // Sub-pixel paper contact disappears in the low-pass radiance estimate.
      // Retain a short diffuse contact lobe where the sheet nearly touches down.
      const contact = leaf ? 0 : 0.15 * Math.min(1, 65 / lit) * Math.exp(-r / 7);
      const opticalDepth = Math.max(measured, contact);
      filtered[r] = Math.max(0, opticalDepth - 0.018) * clamp((extent - r) / 12, 0, 1);
      if (filtered[r] > 0.045) reach = r;
    }
    // An artistic depth estimate from the measured penumbra and the travel of
    // the local lip. Keep the anchor and the lower-amplitude recoil continuous.
    ray.squeeze = clamp(-0.9 * ray.dt / Math.max(leaf ? 24 : 10, reach), 0, 0.24);
    return filtered;
  });

  function depth(i, r) {
    const d = clamp(r, 0, extent), k = Math.floor(d);
    return mix(density[i][k], density[i][Math.min(k + 1, extent)], d - k);
  }

  return (x, y, amount) => {
    const s = -lightY * x + lightX * y - first, t = lightX * x + lightY * y;
    const i = Math.floor(s);
    if (i < 0 || i + 1 >= rays.length) return 1;
    const f = s - i, a = rays[i], b = rays[i + 1];
    const dt = amount * mix(a.dt, b.dt, f);
    if (Math.abs(dt) < 0.02) return 1;
    const r = t - mix(a.end, b.end, f);
    if (r < -10 || r > extent + 4) return 1;
    const originalS = clamp(s - amount * mix(a.ds, b.ds, f), 0, rays.length - 1.0001);
    const j = Math.floor(originalS), g = originalS - j;
    const originalR = (t - dt - mix(rays[j].end, rays[j + 1].end, g)) /
      (1 - amount * mix(rays[j].squeeze, rays[j + 1].squeeze, g));
    const resting = mix(depth(i, r), depth(i + 1, r), f);
    const posed = mix(depth(j, originalR), depth(j + 1, originalR), g);
    const fade = clamp(Math.min(s, rays.length - 1 - s) / 5, 0, 1) * clamp((r + 10) / 3, 0, 1);
    const margin = clamp(Math.min(x, y, size - 1 - x, size - 1 - y) / 7, 0, 1);
    return Math.exp(clamp((resting - posed) * fade * margin, -0.38, 0.38));
  };
}
