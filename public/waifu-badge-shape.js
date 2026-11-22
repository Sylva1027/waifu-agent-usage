export const metals = {
  stone: { color: 0x77746c, shine: 10, specular: 0x353431 },
  bronze: { color: 0xae704f, shine: 48, specular: 0xd1a48a },
  silver: { color: 0xa9acb2, shine: 60, specular: 0xe1e3ea },
  gold: { color: 0xd3a253, shine: 57, specular: 0xe4c98e },
};

export const frontBevel = [
  [0.966, -0.1],
  [0.991, -0.092],
  [1, -0.066],
];
export const backBevel = [
  [1, 0.066],
  [0.991, 0.092],
  [0.966, 0.1],
];

export function findRim(image) {
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
