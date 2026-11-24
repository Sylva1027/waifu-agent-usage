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
} from "../three.js";
import { createPreview } from "../preview.js";
import { backBevel, findRim, frontBevel, metals } from "../../../waifu-badge-shape.js";

function edgeGeometry(grooved) {
  // A radial profile gives the sidewall and both bevels real thickness.
  const profile = [
    ...frontBevel,
    ...(grooved
      ? [
          [1, -0.046],
          [0.969, -0.037],
          [0.969, -0.025],
          [1, -0.017],
          [1, 0.017],
          [0.969, 0.025],
          [0.969, 0.037],
          [1, 0.046],
        ]
      : []),
    ...backBevel,
  ];
  return new LatheGeometry(
    profile.map(([radius, depth]) => new Vector2(radius, depth)),
    96,
  ).rotateX(Math.PI / 2);
}

export function createBadgePreview({ canvas, onStats, onUnavailable, onFrame }) {
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 15);
  camera.position.z = 4;
  const badge = new Group();
  scene.add(badge);
  const faceMaterial = new MeshBasicMaterial({ transparent: true, alphaTest: 0.04, toneMapped: false });
  const face = new Mesh(new PlaneGeometry(2, 2), faceMaterial);
  face.position.z = 0.102;
  const profiles = { smooth: edgeGeometry(false), grooved: edgeGeometry(true) };
  const rimMaterial = new MeshPhongMaterial();
  const rim = new Mesh(profiles.smooth, rimMaterial);
  badge.add(rim, face);
  const key = new DirectionalLight(0xfff4df, 2.0);
  key.position.set(-3, 4, 3);
  const fill = new DirectionalLight(0xcbd9f0, 1.05);
  fill.position.set(2, -1, 2);
  scene.add(key, fill, new AmbientLight(0xffffff, 0.8));
  let tiltX = 0,
    tiltY = 0;

  const preview = createPreview({
    canvas,
    onStats,
    onUnavailable,
    render({ renderer, progress, width, height }) {
      const aspect = width / height;
      camera.left = -aspect;
      camera.right = aspect;
      camera.updateProjectionMatrix();
      // Every FPS follows the same time-parametrized turn and returns to its starting pose.
      const envelope = Math.sin(Math.PI * progress) ** 2;
      badge.rotation.y = 0.19 + 1.33 * envelope * Math.sin(2 * Math.PI * progress + 0.92) + tiltY;
      badge.rotation.x = -0.075 - 0.22 * envelope + tiltX;
      renderer.render(scene, camera);
      onFrame();
    },
  });

  return {
    preview,
    setBadge(image, grade) {
      const bounds = findRim(image);
      const texture = new Texture(image);
      texture.colorSpace = SRGBColorSpace;
      texture.needsUpdate = true;
      faceMaterial.map?.dispose();
      faceMaterial.map = texture;
      faceMaterial.needsUpdate = true;
      rim.position.set(bounds.x, bounds.y, 0);
      rim.scale.set(bounds.radiusX * 0.989, bounds.radiusY * 0.989, 1);
      const metal = metals[grade];
      rimMaterial.color.setHex(metal.color);
      rimMaterial.specular.setHex(metal.specular);
      rimMaterial.shininess = metal.shine;
    },
    setEdge(style) {
      rim.geometry = profiles[style];
    },
    setTilt(x, y) {
      tiltX = x;
      tiltY = y;
    },
    dispose() {
      preview.dispose();
      faceMaterial.map?.dispose();
      faceMaterial.dispose();
      face.geometry.dispose();
      for (const profile of Object.values(profiles)) profile.dispose();
      rimMaterial.dispose();
    },
  };
}
