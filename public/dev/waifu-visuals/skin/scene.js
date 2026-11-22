import {
  BufferGeometry,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  Vector3,
} from "../three.js";
import { createPreview } from "../preview.js";

const tau = Math.PI * 2;

function orbitalPoint(angle) {
  return new Vector3(Math.cos(angle), Math.sin(angle), 0);
}

export function createSkinScene(canvas, state, onStats, onUnavailable) {
  const scene = new Scene();
  const camera = new OrthographicCamera(0, 1, 1, 0, 1, 2000);
  camera.position.z = 1000;
  const haloBand = new RingGeometry(0.978, 1, 112);
  const haloAccent = new RingGeometry(1.09, 1.104, 72, 1, 0.17, 1.2 * Math.PI);
  const track = new BufferGeometry().setFromPoints(
    Array.from({ length: 113 }, (_, i) => orbitalPoint((i * tau) / 112)),
  );
  const beacons = new BufferGeometry().setFromPoints([0.1, 0.31, 0.58, 0.81, 0.94].map((t) => orbitalPoint(t * tau)));
  const metal = new MeshBasicMaterial({ transparent: true, opacity: 0.9, side: DoubleSide, depthWrite: false });
  const line = new LineBasicMaterial({ transparent: true, opacity: 0.5 });
  const dots = new PointsMaterial({ size: 3.75, sizeAttenuation: false, transparent: true, opacity: 0.95 });
  const groups = [1, -1].map((sign) => {
    const group = new Group();
    const halo = new Group();
    halo.add(new Mesh(haloBand, metal), new Mesh(haloAccent, metal));
    const orbit = new Group();
    orbit.add(new Line(track, line), new Points(beacons, dots));
    const inner = new Line(track, line);
    inner.rotation.y = 0.95 * sign;
    inner.rotation.z = 0.42 * sign;
    inner.scale.setScalar(0.87);
    orbit.add(inner);
    group.add(halo, orbit);
    scene.add(group);
    return { group, halo, orbit, sign };
  });

  const preview = createPreview({
    canvas,
    onStats,
    onUnavailable,
    render({ renderer, progress, width, height }) {
      camera.right = width;
      camera.top = height;
      camera.updateProjectionMatrix();
      const dx = state.pointer.x + Math.sin(tau * progress);
      const dy = state.pointer.y + 0.55 * Math.sin(tau * 2 * progress);
      metal.color.set(state.color);
      line.color.set(state.color);
      dots.color.set(state.color);
      for (const [index, { group, halo, orbit, sign }] of groups.entries()) {
        const anchor = state.anchors[index];
        group.visible = Boolean(anchor);
        if (!anchor) continue;
        const isHalo = state.effect === "halo";
        const radius = anchor.height * (isHalo ? 0.14 : 0.242);
        group.position.set(
          anchor.x + dx * radius * 0.13,
          anchor.height * (isHalo ? 0.97 : 0.65) + dy * radius * 0.1,
          0,
        );
        group.scale.setScalar(radius);
        group.rotation.set(
          isHalo ? 1.13 + dy * 0.16 : 0.28 + dy * 0.18,
          (isHalo ? 0.19 : 0.67) * sign + dx * 0.21,
          (isHalo ? 0.18 : 0.36) * sign,
        );
        halo.visible = isHalo;
        orbit.visible = !isHalo;
      }
      renderer.setClearColor(0x000000, 0);
      renderer.render(scene, camera);
    },
  });

  return {
    preview,
    dispose() {
      preview.dispose();
      for (const resource of [haloBand, haloAccent, track, beacons, metal, line, dots]) resource.dispose();
      scene.clear();
    },
  };
}
