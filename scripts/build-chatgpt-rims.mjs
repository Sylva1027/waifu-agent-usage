import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Coordinates on the original 1254px square plates. End the glint where the lip tucks under the next shell.
const lips = {
  left: { top: 440, bottom: 792, anchors: [[0,773],[40,740],[100,702],[160,671],[200,656],[300,627],[380,597],[440,576],[500,550],[550,514],[580,475]] },
  right: { top: 175, bottom: 548, anchors: [[0,525],[50,495],[105,473],[165,459],[220,450],[290,430],[350,405],[400,390],[455,364],[500,338],[546,302],[589,264],[617,229],[638,193]] },
};
const size = 1254;
const ff = (args, input) => execFileSync("ffmpeg", ["-v", "error", ...args], { input, maxBuffer: 10 * 1024 * 1024 });
const root = new URL("../public/", import.meta.url);
const ease = x => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
for (const theme of ["light", "dark"]) {
  const rgb = ff(["-i", fileURLToPath(new URL(`assets/achievement-share/chatgpt/background-${theme}.webp`, root)), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  if (rgb.length !== size * size * 3) throw Error("Unexpected nacre plate dimensions");
  const luma = (x, y) => { const i = 3 * (y * size + x); return 0.2126 * rgb[i] + 0.7152 * rgb[i+1] + 0.0722 * rgb[i+2]; };
  for (const [side, {top, bottom, anchors}] of Object.entries(lips)) {
    const width = anchors.at(-1)[0] + 1, height = bottom - top;
    const pixels = Buffer.alloc(width * height * 4);
    let segment = 0;
    for (let x = 0; x < width; x++) {
      if (x > anchors[segment+1][0]) segment++;
      const [ax,ay] = anchors[segment], [bx,by] = anchors[segment+1];
      const estimate = Math.round(ay + (by-ay)*(x-ax)/(bx-ax));
      let rim = estimate, score = -Infinity;
      for (let y = estimate-15; y <= estimate+15; y++) {
        const drop = (luma(x,y-2)-luma(x,y+2)) + 0.6*(luma(x,y-4)-luma(x,y+4));
        const match = drop - 0.65*Math.abs(y-estimate);
        if (match > score) { score=match; rim=y; }
      }
      const shadow = luma(x,rim+5);
      for (let y = Math.max(top, rim-32); y <= Math.min(rim+1, bottom-1); y++) {
        const depth = rim-y, value = luma(x,y);
        const body = Math.exp(-Math.max(depth,0)/8);
        const relief = ease((value-shadow)/(theme === "dark" ? 46 : 81));
        const coverage = body * (0.16 + 0.84*relief) * ease((depth+1.6)/2.6) * ease((width-1-x)/28);
        const i = 4*((y-top)*width+x);
        pixels[i] = pixels[i+1] = pixels[i+2] = 255;
        pixels[i+3] = Math.round(255*coverage);
      }
    }
    ff(["-y","-f","rawvideo","-pix_fmt","rgba","-s",`${width}x${height}`,"-i","-","-frames:v","1","-c:v","libwebp","-lossless","1",
      fileURLToPath(new URL(`dev/waifu-visuals/chatgpt-ambient/art/${side}-rim-${theme}.webp`, root))], pixels);
  }
}
