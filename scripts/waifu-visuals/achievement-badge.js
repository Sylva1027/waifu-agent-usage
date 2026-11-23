import {
  AmbientLight,
  DirectionalLight,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector2,
  WebGLRenderer,
} from "three";
import { backBevel, findRim, frontBevel, metals } from "../../public/waifu-badge-shape.js";

const frameMs = 1000 / 12;
const settleMs = 420;

export function mountAchievementBadge({ image, canvas, host, grade, onReady, onUnavailable }) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  let renderer;
  let resize;
  let scene;
  let camera;
  let badge;
  let texture;
  let face;
  let rim;
  let timeout = 0;
  let frame = 0;
  let lastDraw = -Infinity;
  let started;
  let ready = false;
  let disposed = false;
  let pointerX = 0;
  let pointerY = 0;
  let pointing = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelDraw();
    resize?.disconnect();
    host.removeEventListener("pointermove", onMove);
    host.removeEventListener("pointerleave", resetPointer);
    document.removeEventListener("visibilitychange", onVisibility);
    motion.removeEventListener("change", onMotion);
    canvas.removeEventListener("webglcontextlost", unavailable);
    face?.geometry.dispose();
    face?.material.dispose();
    rim?.geometry.dispose();
    rim?.material.dispose();
    texture?.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
  }

  function unavailable() {
    if (disposed) return;
    dispose();
    onUnavailable();
  }

  function onMotion() {
    if (motion.matches) unavailable();
  }

  function cancelDraw() {
    clearTimeout(timeout);
    cancelAnimationFrame(frame);
    timeout = 0;
    frame = 0;
  }

  function onVisibility() {
    if (document.hidden) {
      cancelDraw();
      pointerX = 0;
      pointerY = 0;
      pointing = false;
    } else {
      requestDraw();
    }
  }

  function requestDraw() {
    if (!renderer || disposed || document.hidden || timeout || frame) return;
    const delay = Math.max(0, lastDraw + frameMs - performance.now() - 16);
    timeout = setTimeout(() => {
      timeout = 0;
      frame = requestAnimationFrame(draw);
    }, delay);
  }

  function draw() {
    frame = 0;
    if (disposed || document.hidden) return;
    const now = performance.now();
    if (now - lastDraw < frameMs - 0.5) {
      requestDraw();
      return;
    }
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;

    try {
      started ??= now;
      const settle = pointing ? 0 : Math.max(0, 1 - (now - started) / settleMs);
      badge.rotation.set(-0.055 + pointerY * 0.24 - 0.07 * settle ** 2, 0.13 + pointerX * 0.36 + 0.29 * settle ** 2, 0);
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const bufferWidth = Math.round(width * ratio);
      const bufferHeight = Math.round(height * ratio);
      if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
        renderer.setSize(bufferWidth, bufferHeight, false);
        camera.left = -width / height;
        camera.right = width / height;
        camera.updateProjectionMatrix();
      }
      renderer.render(scene, camera);
      lastDraw = now;
      if (!ready) {
        ready = true;
        onReady();
      }
      if (settle > 0) requestDraw();
    } catch {
      unavailable();
    }
  }

  function resetPointer() {
    if (!pointing) return;
    pointing = false;
    pointerX = 0;
    pointerY = 0;
    requestDraw();
  }

  function onMove(event) {
    if (event.pointerType !== "mouse" || !finePointer.matches) return;
    const { x, y, width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    const px = (event.clientX - x) / width;
    const py = (event.clientY - y) / height;
    if (px < 0 || px > 1 || py < 0 || py > 1) {
      resetPointer();
      return;
    }
    pointing = true;
    pointerX = px * 2 - 1;
    pointerY = py * 2 - 1;
    requestDraw();
  }

  async function initialize() {
    try {
      await image.decode();
      if (disposed || motion.matches) return;
      const bounds = findRim(image);
      const metal = metals[grade];
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setClearColor(0x000000, 0);
      scene = new Scene();
      camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 15);
      camera.position.z = 4;
      badge = new Group();
      scene.add(badge);

      texture = new Texture(image);
      texture.colorSpace = SRGBColorSpace;
      texture.needsUpdate = true;
      face = new Mesh(
        new PlaneGeometry(2, 2),
        new MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.04, toneMapped: false }),
      );
      face.position.z = 0.102;

      const profile = [...frontBevel, ...backBevel].map(([radius, depth]) => new Vector2(radius, depth));
      rim = new Mesh(
        new LatheGeometry(profile, 96).rotateX(Math.PI / 2),
        new MeshPhongMaterial({ color: metal.color, specular: metal.specular, shininess: metal.shine }),
      );
      rim.position.set(bounds.x, bounds.y, 0);
      rim.scale.set(bounds.radiusX * 0.989, bounds.radiusY * 0.989, 1);
      badge.add(rim, face);
      const key = new DirectionalLight(0xfff4df, 2);
      key.position.set(-3, 4, 3);
      const fill = new DirectionalLight(0xcbd9f0, 1.05);
      fill.position.set(2, -1, 2);
      scene.add(key, fill, new AmbientLight(0xffffff, 0.8));

      resize = new ResizeObserver(requestDraw);
      resize.observe(canvas);
      host.addEventListener("pointermove", onMove, { passive: true });
      host.addEventListener("pointerleave", resetPointer);
      canvas.addEventListener("webglcontextlost", unavailable);
      requestDraw();
    } catch {
      unavailable();
    }
  }

  document.addEventListener("visibilitychange", onVisibility);
  motion.addEventListener("change", onMotion);
  void initialize();
  return { dispose };
}
