import { boardLight } from "./lamp.js";
import { queenBase } from "./queen.js";

export const castBounds = { x: 1846, y: 152, width: 202, height: 96 };

export function createBoardShadow(stage, atlas) {
  const canvas = document.createElement("canvas");
  const { x, y, width, height } = castBounds;
  canvas.className = "grok-board-shadow";
  canvas.width = width;
  canvas.height = height;
  canvas.style.left = x + "px";
  canvas.style.top = y + "px";
  canvas.hidden = true;
  stage.append(canvas);

  const ctx = canvas.getContext("2d");
  const base = new Path2D();
  base.addPath(new Path2D(queenBase), new DOMMatrix().translate(-x, -y));
  let lastPose = -1;
  return {
    paint(pose, seconds) {
      const strength = boardLight(seconds);
      canvas.hidden = strength === 0;
      if (!strength) return;
      canvas.style.opacity = String(0.54 * strength);
      if (pose === lastPose) return;
      lastPose = pose;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(atlas, (pose % 7) * width, Math.floor(pose / 7) * height, width, height, 0, 0, width, height);
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.fill(base);
      ctx.restore();
    },
    destroy() {
      atlas.removeAttribute("src");
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    },
  };
}
