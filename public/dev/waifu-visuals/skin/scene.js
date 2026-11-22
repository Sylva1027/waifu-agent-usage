import {
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  TextureLoader,
} from "../three.js";
import { createPreview } from "../preview.js";
import { logoPlacement } from "./labs.js";

const tau = Math.PI * 2;

export function createSkinScene(canvas, state, onStats, onUnavailable) {
  const scene = new Scene();
  const camera = new OrthographicCamera(0, 1, 1, 0, 1, 2000);
  camera.position.z = 1000;
  const geometry = new PlaneGeometry();
  const marks = [0.74, 0.5].map((opacity) => {
    const material = new MeshBasicMaterial({ opacity, transparent: true, depthWrite: false });
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    return mesh;
  });
  const loader = new TextureLoader();
  let texture;
  let appliedUrl;
  let pending;
  let disposed = false;

  function setLogo(url) {
    if (disposed) return Promise.resolve(false);
    if (url === appliedUrl) {
      pending = undefined;
      return Promise.resolve(true);
    }
    if (url === pending?.url) return pending.promise;
    const request = { url };
    pending = request;
    request.promise = loader.loadAsync(url).then(
      (next) => {
        if (pending !== request || disposed) {
          next.dispose();
          return false;
        }
        next.colorSpace = SRGBColorSpace;
        for (const mark of marks) {
          mark.material.map = next;
          mark.material.needsUpdate = true;
        }
        texture?.dispose();
        texture = next;
        appliedUrl = url;
        pending = undefined;
        return true;
      },
      (error) => {
        if (pending !== request || disposed) return false;
        pending = undefined;
        throw error;
      },
    );
    return request.promise;
  }

  const preview = createPreview({
    canvas,
    onStats,
    onUnavailable,
    render({ renderer, progress, width, height }) {
      camera.right = width;
      camera.top = height;
      camera.updateProjectionMatrix();
      const dx = state.pointer.x + Math.sin(tau * progress);
      const dy = state.pointer.y + 0.32 * Math.sin(tau * 2 * progress);
      const aspect = texture ? texture.image.width / texture.image.height : 1;
      for (const [index, mark] of marks.entries()) {
        const anchor = state.anchors[index];
        mark.visible = Boolean(texture && anchor && appliedUrl === state.logo);
        if (!mark.visible) continue;
        const box = logoPlacement(anchor, index, width, height, aspect);
        const depth = index === 0 ? 1 : 0.75;
        const travel = Math.min(9, box.width * 0.085) * depth;
        mark.position.set(box.x + dx * travel, box.y + dy * travel, 0);
        mark.scale.set(box.width, box.height, 1);
      }
      renderer.setClearColor(0x000000, 0);
      renderer.render(scene, camera);
    },
  });

  return {
    preview,
    setLogo,
    dispose() {
      disposed = true;
      preview.dispose();
      texture?.dispose();
      geometry.dispose();
      for (const mark of marks) mark.material.dispose();
      scene.clear();
    },
  };
}
