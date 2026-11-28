import { firstPose } from "./breeze-patches.js";
import { fiberLayout as darkLayout } from "./fiber-layout.js";
import { fiberLayout as lightLayout } from "./fiber-layout-light.js";

export function createFiberLayer(paper) {
  const canvas = document.createElement("canvas");
  canvas.className = "claude-paper-fibers";
  canvas.hidden = true;
  canvas.width = canvas.height = 0;
  paper.append(canvas);
  let layout, image, ctx;
  let currentPose = 0;
  return {
    clear() {
      image = null;
      ctx = null;
      canvas.hidden = true;
      if (canvas.width) canvas.width = canvas.height = 0;
    },
    setAtlas(theme, atlas) {
      layout = theme === "light" ? lightLayout : darkLayout;
      image = atlas;
      currentPose = 0;
      canvas.hidden = true;
      canvas.width = layout.width;
      canvas.height = layout.height;
      canvas.style.left = `${(100 * layout.left) / layout.plateWidth}%`;
      canvas.style.top = `${(100 * layout.top) / layout.plateHeight}%`;
      canvas.style.width = `${(100 * layout.width) / layout.plateWidth}%`;
      canvas.style.height = `${(100 * layout.height) / layout.plateHeight}%`;
      ctx = canvas.getContext("2d");
      if (ctx) ctx.imageSmoothingEnabled = false;
    },
    paint(pose) {
      if (!image || !ctx || pose === currentPose) return;
      currentPose = pose;
      canvas.hidden = pose === 0;
      if (canvas.hidden) return;
      const row = (pose - firstPose) * layout.poseHeight;
      for (const [x, y, w, h, u, v] of layout.strips) {
        ctx.clearRect(x, y, w, h);
        ctx.drawImage(image, u, v + row, w, h, x, y, w, h);
      }
    },
  };
}
