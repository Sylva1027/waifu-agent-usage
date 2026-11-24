import { createNoticeScene as createScene, fade, phase } from "../../../waifu-notice-scene.js";

const bursts = [
  { side: 1, up: 1, start: 0.01, span: 0.23, climb: 29, run: 25, size: 13.5 },
  { side: -1, up: 1, start: 0.13, span: 0.24, climb: 18, run: 29, size: 9 },
  { side: 1, up: -1, start: 0.29, span: 0.22, climb: 24, run: 13, size: 8.1 },
];
function drawBloom(t, { rx, ry, reach, seeds, comet, glint, mark, stroke }) {
  for (const [k, burst] of bursts.entries()) {
    const { side, up, start, span, run, climb, size } = burst;
    const path = (u) => ({
      x: side * (rx + 2 + reach * (run * u + Math.sin(Math.PI * u) * 5)),
      y: up * (ry + 1 + climb * u * u),
    });
    const launch = phase(t, start, span);
    const tint = k === 1 ? 0 : 1;
    const apex = path(1);
    comet(path, launch, 0.65, fade(launch), tint, 1.65);
    const light = phase(t, start + span - 0.035, 0.33);
    const flash = fade(light);
    mark(apex.x, apex.y, size * 0.49, size * 0.52, side * 0.85, flash * 0.68, 1, tint);
    glint(apex.x, apex.y, size * (1 + 0.24 * light), side * 0.19, flash, tint);
    for (let j = 0; j < 8; j++) {
      const seed = seeds[k * 8 + j];
      const u = phase(t, start + span - 0.025 + seed.time * 0.055, 0.3 + seed.speed * 0.11);
      if (u <= 0 || u >= 1) continue;
      const angle = ((j + seed.turn * 0.65) / 8) * 3.4 - 1.22;
      const dx = side * Math.cos(angle) * (13 + 21 * seed.speed) * reach;
      const dy = up * Math.sin(angle) * (12 + 18 * seed.speed);
      const drift = 1 - (1 - u) ** 2;
      const x = apex.x + dx * drift;
      const y = apex.y + dy * drift - 5 * u * u;
      const size = (1.65 + 2.65 * seed.size) * (1 - u * 0.32);
      const alpha = fade(u);
      if (j % 3 === 0)
        stroke({ x: x - dx * 0.23 * (1 - u), y: y - dy * 0.23 * (1 - u) }, { x, y }, 1.05, alpha * 0.7, tint);
      mark(x, y, size * 0.82, size * 1.55, side * angle + u * 0.7, alpha, j % 3 === 1 ? 1 : 2, j % 3 === 0 ? 0 : tint);
      if (j % 3 === 2) mark(x - dx * 0.16, y - dy * 0.16, 1.35, 1.35, 0, alpha * 0.57, 0, 1.2);
    }
  }
}

export function createNoticeScene() {
  return createScene(drawBloom);
}
