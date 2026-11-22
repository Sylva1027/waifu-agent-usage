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

const metals = {
  stone: { color: 0x77746c, shine: 10, specular: 0x353431 },
  bronze: { color: 0xae704f, shine: 48, specular: 0xd1a48a },
  silver: { color: 0xa9acb2, shine: 60, specular: 0xe1e3ea },
  gold: { color: 0xd3a253, shine: 57, specular: 0xe4c98e },
};

function edgeGeometry(grooved) {
  // A radial profile gives the sidewall and both bevels real thickness.
  const profile = [
    [0.966, -0.1],
    [0.991, -0.092],
    [1, -0.066],
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
    [1, 0.066],
    [0.991, 0.092],
    [0.966, 0.1],
  ];
  return new LatheGeometry(
    profile.map(([radius, depth]) => new Vector2(radius, depth)),
    96,
  ).rotateX(Math.PI / 2);
}

function findRim(image) {
  // The shipped WebPs include transparent margins and slightly oval rims.
  const scratch = document.createElement("canvas");
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, width, height).data;
  const opaque = (x, y) => pixels[(y * width + x) * 4 + 3] >= 160;
  const centerX = Math.floor(width / 2),
    centerY = Math.floor(height / 2);
  let left = 0,
    right = width - 1,
    top = 0,
    bottom = height - 1;
  while (left < centerX && !opaque(left, centerY)) left++;
  while (right > centerX && !opaque(right, centerY)) right--;
  while (top < centerY && !opaque(centerX, top)) top++;
  while (bottom > centerY && !opaque(centerX, bottom)) bottom--;
  return {
    x: (left + right + 1) / width - 1,
    y: 1 - (top + bottom + 1) / height,
    radiusX: (right - left + 1) / width,
    radiusY: (bottom - top + 1) / height,
  };
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
