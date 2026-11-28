import { createBoardShadow } from "./board-shadow.js";
import { loadImage } from "./image.js";
import { LAMP_AT_DESK_CENTER } from "./lamp.js";

const WIDTH = 105,
  HEIGHT = 90,
  COLUMNS = 7,
  LAST = 48;
const REARM = 0.48;
const LEAD_IN = 0.15;
const LAST_IMPACT = 3.82;

// The roll curve includes a short lead-in. A repeat first rolls back from the rim.
function rollOffset(fromRim) {
  return LAMP_AT_DESK_CENTER + (fromRim ? REARM : -LEAD_IN);
}

export function pawnSettlesAt(fromRim) {
  return rollOffset(fromRim) + LAST_IMPACT;
}

function fraction(seconds) {
  // Impacts are sharp reversals; each reversal away from the rim loses travel.
  if (seconds <= LEAD_IN) return 0;
  if (seconds <= 0.58) return ((seconds - LEAD_IN) / 0.43) ** 1.6;
  // Hold the impact pose for one display sample on the 30 Hz preview clock.
  if (seconds <= 0.62) return 1;
  if (seconds <= 1.16) return (1 - (seconds - 0.62) / 0.54) ** 2;
  if (seconds <= 1.99) return ((seconds - 1.16) / 0.83) ** 1.65;
  if (seconds <= 2.03) return 1;
  if (seconds <= 2.62) return 0.5 + 0.5 * (1 - (seconds - 2.03) / 0.59) ** 2;
  if (seconds <= LAST_IMPACT) {
    const t = (seconds - 2.62) / 1.2;
    return 0.5 + 0.5 * t * t * (3 - 2 * t);
  }
  return 1;
}

const pawnRoll = {
  dark: new URL("./pawn-roll-dark.webp", import.meta.url).href,
  light: new URL("./pawn-roll-light.webp", import.meta.url).href,
};
const boardRepair = {
  dark: new URL("./pawn-board-dark.webp", import.meta.url).href,
  light: new URL("./pawn-board-light.webp", import.meta.url).href,
};
const shadowPlate = new URL("./board-cast-dark.webp", import.meta.url).href;

export async function createPawn(stage, mode, signal) {
  const [poses, board, shadowAtlas] = await Promise.all([
    loadImage(pawnRoll[mode], signal),
    loadImage(boardRepair[mode], signal),
    mode === "dark" ? loadImage(shadowPlate, signal) : null,
  ]);
  board.className = "grok-board-repair";
  board.alt = "";
  const shadow = shadowAtlas && createBoardShadow(stage, shadowAtlas);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.className = "grok-pawn";
  const ctx = canvas.getContext("2d");
  stage.append(board, canvas);
  let last = -1;
  return {
    paint(seconds, fromRim = false) {
      const rollTime = seconds - rollOffset(fromRim);
      let f;
      if (fromRim && rollTime < 0) {
        const t = Math.max(0, (rollTime + REARM) / REARM);
        f = 1 - t * t * (3 - 2 * t);
      } else {
        f = fraction(rollTime);
      }
      const pose = Math.round(f * LAST);
      shadow?.paint(pose, seconds);
      if (pose === last) return;
      last = pose;
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.drawImage(
        poses,
        (pose % COLUMNS) * WIDTH,
        Math.floor(pose / COLUMNS) * HEIGHT,
        WIDTH,
        HEIGHT,
        0,
        0,
        WIDTH,
        HEIGHT,
      );
    },
    destroy() {
      shadow?.destroy();
      poses.removeAttribute("src");
      board.removeAttribute("src");
      board.remove();
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    },
  };
}
