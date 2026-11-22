import {
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
} from "three";

const clamp = (x) => Math.min(1, Math.max(0, x));
export const phase = (t, start, length) => clamp((t - start) / length);
const smooth = (x) => x * x * (3 - 2 * x);
export const fade = (t) => smooth(clamp(t / 0.18)) * smooth(clamp((1 - t) / 0.47));
const tau = Math.PI * 2;

function makeSeeds() {
  let seed = 0x6a7c11;
  function next() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  return Array.from({ length: 28 }, () => ({ turn: next(), size: next(), time: next(), speed: next() }));
}

const vertexShader = `
  attribute vec4 frame;
  attribute vec4 paint;
  varying vec2 local, labelPosition;
  varying vec3 brush;
  void main() {
    local = position.xy;
    brush = paint.yzw;
    float c = cos(paint.x), s = sin(paint.x);
    vec2 offset = mat2(c, s, -s, c) * (local * frame.zw);
    labelPosition = frame.xy + offset;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(labelPosition, 0.0, 1.0);
  }
`;

const fragmentShader = `
  uniform vec3 accent, champagne, pearl;
  uniform float highlight;
  uniform vec2 labelHalf;
  varying vec2 local, labelPosition;
  varying vec3 brush;
  void main() {
    vec2 p = abs(local);
    float r = length(local);
    float star = mix(p.x + p.y, pow(sqrt(p.x) + sqrt(p.y), 2.0), 0.72);
    float d = r;
    if (brush.y > 0.5) d = star;
    if (brush.y > 1.5) d = p.x + p.y;
    if (brush.y > 2.5) d = max(p.y, p.x * 0.68);
    float aa = clamp(fwidth(d), 0.012, 0.29);
    float core = 1.0 - smoothstep(0.61 - aa, 0.61 + aa, d);
    float edge = 1.0 - smoothstep(0.86 - aa, 0.86 + aa, d);
    float halo = exp(-5.8 * r * r) * (1.0 - smoothstep(0.7, 1.0, r));
    float alpha = (brush.y > 3.5 ? halo : max(edge * 0.97, halo * 0.32)) * brush.x;
    vec2 margin = abs(labelPosition) - labelHalf;
    alpha *= smoothstep(0.75, 3.0, max(margin.x, margin.y));
    vec3 tint = mix(accent, champagne, min(brush.z, 1.0));
    tint = mix(tint, pearl, max(brush.z - 1.0, 0.0));
    float facet = brush.y < 0.5 ? 0.18 : 0.26 + 0.32 * smoothstep(-0.1, 0.7, local.y - local.x);
    vec3 ink = mix(tint, pearl, core * facet * highlight);
    gl_FragColor = vec4(ink, alpha);
    #include <colorspace_fragment>
  }
`;

// Both scenes draw their ordered trail, glint, crystal and dust layers in one GPU batch.
export function createNoticeScene(drawBloom) {
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;
  const material = new ShaderMaterial({
    uniforms: {
      labelHalf: { value: new Vector2() },
      accent: { value: new Color() },
      champagne: { value: new Color() },
      pearl: { value: new Color() },
      highlight: { value: 1 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  const frame = new InstancedBufferAttribute(new Float32Array(180 * 4), 4).setUsage(DynamicDrawUsage);
  const paint = new InstancedBufferAttribute(new Float32Array(180 * 4), 4).setUsage(DynamicDrawUsage);
  geometry.setAttribute("frame", frame);
  geometry.setAttribute("paint", paint);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const seeds = makeSeeds();
  let cx = 0,
    top = 0,
    rx = 20,
    ry = 10,
    reach = 1,
    variant = "orbit",
    used = 0;

  function configure({ target, canvas, variant: selection, theme }) {
    const label = target.getBoundingClientRect(),
      stage = canvas.getBoundingClientRect();
    cx = label.left + label.width / 2 - stage.left;
    top = label.top + label.height / 2 - stage.top;
    rx = label.width / 2;
    ry = label.height / 2;
    material.uniforms.labelHalf.value.set(rx, ry);
    reach = clamp((stage.width - cx - rx - 3) / 60);
    variant = selection;
    material.uniforms.accent.value.set(getComputedStyle(target).color);
    material.uniforms.champagne.value.set(theme === "dark" ? 0xeeb85f : 0x9a6320);
    material.uniforms.highlight.value = theme === "dark" ? 1 : 0.54;
    material.uniforms.pearl.value.set(theme === "dark" ? 0xfff0ce : 0xffecbd);
  }

  // Brush indices select a bead, four-point star, faceted diamond, trail strip, or soft halo.
  function mark(x, y, halfWidth, halfHeight, rotation, opacity, shape, tint) {
    if (opacity <= 0.006) return;
    frame.setXYZW(used, x, y, halfWidth, halfHeight);
    paint.setXYZW(used, rotation, opacity, shape, tint);
    used++;
  }
  function stroke(a, b, width, opacity, tint) {
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length > 0.15)
      mark((a.x + b.x) / 2, (a.y + b.y) / 2, length / 2 + 0.22, width, Math.atan2(dy, dx), opacity, 3, tint);
  }
  function comet(at, t, tail, alpha, tint, width) {
    if (alpha <= 0) return;
    const begin = Math.max(0, t - tail);
    let a = at(begin);
    for (let j = 1; j <= 17; j++) {
      const u = j / 17;
      const b = at(begin + (t - begin) * u);
      stroke(a, b, width * (0.35 + u * 0.65), alpha * u * u, tint);
      a = b;
    }
    mark(a.x, a.y, 3.1, 3.1, 0, alpha, 0, tint);
  }
  function glint(x, y, size, angle, light, tint) {
    mark(x, y, size * 1.45, size * 1.45, 0, light * 0.34, 4, tint);
    mark(x, y, size * 0.75, size, angle, light, 1, tint);
    mark(x, y, 1.7, 1.7, 0, light, 0, 1.85);
  }

  function orbit(t) {
    function point(u, lane) {
      const angle = (-0.46 + 0.96 * u + lane * 0.51) * tau;
      const x = Math.cos(angle) * (rx + (11 + 10 * u) * reach);
      const y = Math.sin(angle) * (ry + 5 + 7 * u);
      return { x, y: y + x * 0.13 };
    }
    for (let lane = 0; lane < 2; lane++) {
      const u = phase(t, lane * 0.1, 0.72);
      const head = u * (2 - u);
      const alpha = fade(u);
      comet((v) => point(v, lane), head, 0.26, alpha, lane === 0 ? 1.0 : 0, lane === 0 ? 2.05 : 1.5);
      const p = point(head, lane);
      glint(p.x, p.y, lane === 0 ? 9 : 6, -0.17, alpha, lane === 0 ? 1 : 0);
    }
    for (let i = 0; i < 22; i++) {
      const seed = seeds[i];
      const start = 0.04 + ((i + seed.time * 0.5) / 22) * 0.6;
      const u = phase(t, start, 0.29 + seed.speed * 0.1);
      const lane = i % 2;
      const emitted = phase(start, lane * 0.1, 0.72);
      const p = point(emitted * (2 - emitted), lane);
      const angle = Math.atan2(p.y, p.x) + (seed.turn - 0.5);
      const drift = (3 + 12 * seed.speed) * u;
      const radius = 1.55 + 2.2 * seed.size;
      mark(
        p.x + Math.cos(angle) * drift,
        p.y + Math.sin(angle) * drift + 3 * u,
        radius,
        radius * 1.4,
        angle + 0.7 * u,
        fade(u),
        i % 4 === 0 ? 1 : 2,
        lane === 0 ? 1 : 0,
      );
    }
    const end = point(1, 0);
    glint(end.x, end.y, 9.5, -0.1, fade(phase(t, 0.57, 0.39)), 1.2);
  }

  function render({ renderer, progress, width, height }) {
    camera.left = 0;
    camera.right = width;
    camera.top = height;
    camera.bottom = 0;
    camera.updateProjectionMatrix();
    mesh.position.set(cx, height - top, 0);
    used = 0;
    if (variant === "orbit") orbit(progress);
    else drawBloom?.(progress, { rx, ry, reach, seeds, comet, glint, mark, stroke });
    geometry.instanceCount = used;
    frame.needsUpdate = paint.needsUpdate = true;
    renderer.setClearColor(0, 0);
    renderer.render(scene, camera);
  }
  return {
    configure,
    render,
    dispose() {
      geometry.dispose();
      material.dispose();
      scene.clear();
    },
  };
}
