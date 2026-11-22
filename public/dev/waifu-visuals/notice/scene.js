import {
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
} from "../three.js";

const count = 27;
const rayStride = 3;

function seededParticles() {
  let seed = 0x260418;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  return Array.from({ length: count }, (_, i) => {
    const angle = ((i + random() * 0.65) / count) * Math.PI * 2;
    return {
      x: Math.cos(angle),
      y: Math.sin(angle),
      travel: 14 + random() * 26,
      radius: 1.05 + random() * 1.25,
      delay: random() * 0.1,
      life: 0.65 + random() * 0.25,
      trail: 5 + random() * 7,
    };
  });
}

export function createNoticeScene() {
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;
  const particles = seededParticles();
  const material = new MeshBasicMaterial({ depthWrite: false, depthTest: false, toneMapped: false });
  const dots = new InstancedMesh(new CircleGeometry(1, 12), material, count);
  const rays = new InstancedMesh(new PlaneGeometry(1, 1), material, Math.ceil(count / rayStride));
  const transform = new Object3D();
  for (const mesh of [rays, dots]) {
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  let anchor, style;
  function configure({ target, canvas, variant, theme }) {
    const box = target.getBoundingClientRect();
    const frame = canvas.getBoundingClientRect();
    anchor = { x: box.left + box.width / 2 - frame.left, y: box.top + box.height / 2 - frame.top };
    anchor.rx = box.width / 2 + 2;
    anchor.ry = box.height / 2 + 2;
    rays.visible = variant === "rays";
    if (theme === style) return;
    style = theme;
    const colors = theme === "dark" ? [0x76ecde, 0xc0fff3, 0xf3cb78] : [0x007b86, 0x198c96, 0xa26516];
    const palette = colors.map((value) => new Color(value));
    for (let i = 0; i < count; i++) {
      const color = palette[i % 7 === 0 ? 2 : i % 2];
      dots.setColorAt(i, color);
      if (i % rayStride === 0) rays.setColorAt(i / rayStride, color);
    }
    rays.instanceColor.needsUpdate = true;
    dots.instanceColor.needsUpdate = true;
  }

  function render({ renderer, progress, width, height }) {
    camera.left = 0;
    camera.right = width;
    camera.top = height;
    camera.bottom = 0;
    camera.updateProjectionMatrix();
    for (const [i, particle] of particles.entries()) {
      const t = Math.max(0, Math.min(1, (progress - particle.delay) / particle.life));
      const travel = particle.travel * (1 - (1 - t) ** 2);
      const envelope = Math.max(0, Math.min(1, t / 0.13, (1 - t) / 0.62));
      const radius = particle.radius * envelope;
      const x = anchor.x + particle.x * (anchor.rx + travel);
      const y = height - anchor.y + particle.y * (anchor.ry + travel * 0.78) + 5 * t;
      transform.position.set(x, y, 0);
      transform.rotation.z = 0;
      transform.scale.set(radius, radius, 1);
      transform.updateMatrix();
      dots.setMatrixAt(i, transform.matrix);
      if (rays.visible && i % rayStride === 0) {
        const length = envelope * particle.trail;
        const angle = Math.atan2(particle.y * 0.78, particle.x);
        transform.position.set(x - (Math.cos(angle) * length) / 2, y - (Math.sin(angle) * length) / 2, 0);
        transform.rotation.z = angle;
        transform.scale.set(length, 1.25 * envelope, 1);
        transform.updateMatrix();
        rays.setMatrixAt(i / rayStride, transform.matrix);
      }
    }
    dots.instanceMatrix.needsUpdate = true;
    if (rays.visible) rays.instanceMatrix.needsUpdate = true;
    renderer.setClearColor(0, 0);
    renderer.render(scene, camera);
  }

  function dispose() {
    for (const mesh of [dots, rays]) {
      mesh.dispose();
      mesh.geometry.dispose();
    }
    material.dispose();
    scene.clear();
  }
  return { configure, render, dispose };
}
