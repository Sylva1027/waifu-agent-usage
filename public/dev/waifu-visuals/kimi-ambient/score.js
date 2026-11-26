// Stencil centres, widths and rotations on the annotated 1704 × 957 spread.
// Angles account for the existing rise or fall between each motif's visible tips.
const guideWidth = 1704;
const guideHeight = 957;
const placement = [
  { part: "score-1", x: 318.7, y: 65.5, span: 625.8, angle: -2.47 },
  { part: "phrase-1", x: 1467.1, y: 138.7, span: 476.3, angle: -13.41 },
  { part: "score-2", x: 292.1, y: 325.0, span: 578.4, angle: -8.88 },
  { part: "phrase-2", x: 1488.6, y: 334.3, span: 437, angle: -12.92 },
  { part: "score-3", x: 307.5, y: 845.4, span: 601.5, angle: -4.05 },
  { part: "phrase-3", x: 1483.9, y: 906.8, span: 432.1, angle: -3.15 },
];
const passDuration = 3000;

export async function loadScore() {
  const stamps = placement.map(({ part, x, y, span, angle }) => {
    const image = new Image();
    image.src = new URL(`./dark/${part}.svg`, import.meta.url).href;
    const stamp = document.createElement("div");
    stamp.className = "kimi-stamp";
    stamp.dataset.part = part;
    stamp.style.setProperty("--stencil", `url("${image.src}")`);
    stamp.style.setProperty("--inclination", `${angle}deg`);
    const recess = document.createElement("div");
    recess.className = "kimi-recess";
    const light = document.createElement("div");
    light.className = "kimi-current";
    recess.append(light);
    stamp.append(recess);
    return { image, stamp, light, x, y, span, right: part.startsWith("phrase") };
  });
  await Promise.all(stamps.map(({ image }) => image.decode()));

  const engraving = document.createElement("div");
  engraving.className = "kimi-engraving";
  engraving.append(...stamps.map(({ stamp }) => stamp));

  function alignPortraitMasks() {
    const portraits = document.querySelector("#skinCharacters");
    const masks = [];
    if (portraits?.dataset.skin === "kimi" && Number(getComputedStyle(portraits).opacity) > 0) {
      for (const image of portraits.querySelectorAll('img[data-loaded="1"]')) {
        const { x, y, width, height } = image.getBoundingClientRect();
        if (!width || !height || getComputedStyle(image).visibility !== "visible") continue;
        // Both mattes use the source portrait coordinates so the grooves also follow the character toggle and resize.
        const url = new URL(`./dark/occlusion-${image.dataset.view}.webp`, import.meta.url);
        masks.push(`url("${url}") ${x}px ${y}px / ${width}px ${height}px no-repeat add`);
      }
    }
    engraving.style.mask = masks.length ? ["linear-gradient(white, white) subtract", ...masks].join(", ") : "none";
  }

  function layout(width, height) {
    alignPortraitMasks();
    const scale = Math.min(width / guideWidth, height / guideHeight);
    const extraWidth = width - guideWidth * scale;
    for (const item of stamps) {
      Object.assign(item.stamp.style, {
        width: `${item.span * scale}px`,
        left: `${item.x * scale + (item.right ? extraWidth : 0)}px`,
        top: `${(item.y / guideHeight) * height}px`,
      });
    }
  }

  function play() {
    const slot = passDuration / stamps.length;
    return stamps.map(({ light }, index) =>
      light.animate([{ backgroundPosition: "-33.334% center" }, { backgroundPosition: "133.334% center" }], {
        delay: index * slot,
        duration: slot,
        easing: "linear",
      }),
    );
  }
  return { nodes: [engraving], layout, play, alignPortraitMasks };
}
