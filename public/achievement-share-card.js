import { ACHIEVEMENT_CONTENT, achievementCopy } from "./achievement-content.js";
import { achievementShareArt } from "./achievement-share-art.js";
import { ACHIEVEMENT_SHARE_CONDITIONS } from "./achievement-share-conditions.js";
import { paletteDeclarations } from "./skins.js";
import { backBevel, findRim, frontBevel, metals } from "./waifu-badge-shape.js";

const WIDTH = 960;
const HEIGHT = 1200;
const ROUNDNESS = (21 * WIDTH) / 475;
const COIN_SIZE = 1024;
const cardContents = `
  <div class="room">
    <img class="art" alt="" />
    <span class="art-glow"></span>
    <div class="light"></div>
    <div class="table"></div>
    <div class="standee"><div class="base"></div><img class="character" alt="" /></div>
    <figure class="award">
      <div class="collectible"><img class="medal" alt="" /></div>
      <figcaption><div class="heading"><h2></h2></div><time class="date"></time></figcaption>
    </figure>
  </div>
  <div class="story"><div class="story-copy"><p class="fact"></p><p class="detail"></p></div></div>
  <div class="share-watermark">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 21v-3c-4 1-4-2-5-2m13 5v-4c0-1-.4-1.7-1-2 3-.4 6-1 6-6a5 5 0 0 0-1.5-3.5c.2-1 .2-2-.5-3-1.5 0-3 1-3.5 1.5a13 13 0 0 0-7 0C8 3.5 6.5 2.5 5 2.5c-.7 1-.7 2-.5 3A5 5 0 0 0 3 9c0 4.6 3 5.6 6 6-.6.3-1 1-1 2"/>
    </svg><span>waifu-agent-usage</span>
  </div>`;

const TITLE_STEPS = [
  [8.8, 1],
  [8, 1],
  [7.4, 1],
  [7.6, 2],
  [7, 2],
  [6.4, 2],
  [5.9, 2],
  [6.2, 3],
  [5.7, 3],
  [5.2, 3],
  [4.7, 3],
];
const STORY_STEPS = [
  [6.8, 3.3],
  [6.2, 3.3],
  [5.7, 3.3],
  [5.2, 3.25],
  [4.75, 3.2],
  [4.35, 3.15],
  [4.05, 3.1],
  [3.8, 3.05],
];

function formatDate(date, english, timeZone) {
  const formatter = new Intl.DateTimeFormat(english ? "en-US" : "zh-CN", {
    timeZone,
    year: "numeric",
    month: english ? "short" : "2-digit",
    day: english ? "numeric" : "2-digit",
  });
  if (english) return `Earned ${formatter.format(date)}`;
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}.${parts.month}.${parts.day} 获得`;
}

function addSpan(parent, className, content) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = content;
  parent.append(span);
}

function fitCard(card) {
  const title = card.querySelector(".heading h2");
  const bar = card.querySelector(".story");
  const copy = card.querySelector(".story-copy");

  for (const [size, lines] of TITLE_STEPS) {
    title.style.fontSize = `${size}cqw`;
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
    if (title.offsetHeight <= lines * lineHeight + 1 && title.scrollWidth <= title.clientWidth + 1) break;
  }

  const style = getComputedStyle(bar);
  const available = bar.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  for (const [fact, detail] of STORY_STEPS) {
    copy.style.setProperty("--fact-size", `${fact}cqw`);
    copy.style.setProperty("--detail-size", `${detail}cqw`);
    if (copy.offsetHeight <= available + 0.5 && copy.scrollWidth <= copy.clientWidth + 1) break;
  }

  const credit = copy.querySelector(".detail-attribution");
  if (credit) {
    const line = credit.parentElement.getBoundingClientRect();
    const ink = credit.getBoundingClientRect();
    if (Math.abs(ink.left - line.left) < 1) credit.style.translate = `${line.right - ink.right}px`;
  }
}

function setCopy(card, { copy, condition, date, english }) {
  const [fact, qualifier] = condition;
  card.lang = english ? "en" : "zh-CN";
  card.querySelector(".heading h2").textContent = copy.name;
  card.querySelector(".date").textContent = date;
  const factText = card.querySelector(".fact");
  factText.textContent = fact;
  if (qualifier) {
    factText.append(" ");
    addSpan(factText, "qualifier", qualifier);
  }
  const detail = card.querySelector(".detail");
  const flavor = copy.flavor.trimEnd();
  const byline = /^([\s\S]*[ \t\n])([—–-][ \t]+\S[^\r\n]*)$/u.exec(flavor);
  detail.textContent = byline ? byline[1] : flavor;
  if (byline) addSpan(detail, "detail-attribution", byline[2]);
}

async function loadImage(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

async function embedImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Share image HTTP ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

function cropCoin(rendered) {
  const flat = document.createElement("canvas");
  flat.width = flat.height = COIN_SIZE;
  const ctx = flat.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(rendered, 0, 0);
  const rgba = ctx.getImageData(0, 0, COIN_SIZE, COIN_SIZE).data;
  let left = COIN_SIZE;
  let right = -1;
  let top = COIN_SIZE;
  let bottom = -1;
  for (let y = 0; y < COIN_SIZE; y++) {
    for (let x = 0; x < COIN_SIZE; x++) {
      if (rgba[(y * COIN_SIZE + x) * 4 + 3] < 92) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right <= left || bottom <= top) throw new Error("Could not render badge");
  left = Math.max(0, left - 2);
  top = Math.max(0, top - 2);
  right = Math.min(COIN_SIZE - 1, right + 2);
  bottom = Math.min(COIN_SIZE - 1, bottom + 2);
  const cropped = document.createElement("canvas");
  cropped.width = right - left + 1;
  cropped.height = bottom - top + 1;
  cropped
    .getContext("2d")
    .drawImage(flat, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
  return cropped.toDataURL("image/png");
}

let coinRenderer;
async function renderCoin(image, grade) {
  const {
    a: SRGBColorSpace,
    c: Vector2,
    d: Texture,
    e: Group,
    g: Scene,
    i: MeshBasicMaterial,
    j: Mesh,
    l: LatheGeometry,
    m: PlaneGeometry,
    o: MeshPhongMaterial,
    p: OrthographicCamera,
    q: DirectionalLight,
    r: AmbientLight,
    t: WebGLRenderer,
  } = await import("./waifu-visuals-core.js");
  if (!coinRenderer) {
    coinRenderer = new WebGLRenderer({ alpha: true, antialias: true });
    coinRenderer.setSize(COIN_SIZE, COIN_SIZE, false);
    coinRenderer.setClearColor(0x000000, 0);
  }
  const bounds = findRim(image);
  const { color, shine, specular } = metals[grade];
  const texture = new Texture(image);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  const face = new Mesh(
    new PlaneGeometry(2, 2),
    new MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.04, toneMapped: false }),
  );
  face.position.z = 0.102;
  const profile = [...frontBevel, ...backBevel].map(([radius, depth]) => new Vector2(radius, depth));
  const rim = new Mesh(
    new LatheGeometry(profile, 96).rotateX(Math.PI / 2),
    new MeshPhongMaterial({ color, specular, shininess: shine }),
  );
  rim.position.set(bounds.x, bounds.y, 0);
  rim.scale.set(bounds.radiusX * 0.989, bounds.radiusY * 0.989, 1);

  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 15);
  const badge = new Group();
  const key = new DirectionalLight(0xfff4df, 2);
  const fill = new DirectionalLight(0xcbd9f0, 1.05);
  camera.position.z = 4;
  key.position.set(-3, 4, 3);
  fill.position.set(2, -1, 2);
  badge.add(rim, face);
  const radians = Math.PI / 180;
  badge.rotation.set(-8 * radians, 24 * radians, -7 * radians);
  scene.add(badge, key, fill, new AmbientLight(0xffffff, 0.8));
  try {
    coinRenderer.render(scene, camera);
    return cropCoin(coinRenderer.domElement);
  } finally {
    for (const mesh of [face, rim]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    texture.dispose();
    scene.clear();
  }
}

window.addEventListener("pagehide", () => {
  coinRenderer?.dispose();
  coinRenderer = null;
});

async function medalImage(id, grade) {
  const source = await embedImage(`/assets/achievements/${id}/${grade}.webp`);
  try {
    return await renderCoin(await loadImage(source), grade);
  } catch {
    return source;
  }
}

let css;
function loadCss() {
  css ??= fetch(new URL("./achievement-share-card.css", import.meta.url))
    .then((response) => {
      if (!response.ok) throw new Error(`Share stylesheet HTTP ${response.status}`);
      return response.text();
    })
    .catch((error) => {
      css = null;
      throw error;
    });
  return css;
}

async function rasterize(card, stylesheet) {
  // Browser layout fits the approved copy, then an image-safe SVG preserves that layout without page chrome.
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${WIDTH}px;pointer-events:none;`;
  host.setAttribute("aria-hidden", "true");
  const root = host.attachShadow({ mode: "closed" });
  const content = document.createElement("div");
  const style = document.createElement("style");
  style.textContent = stylesheet;
  content.append(style, card);
  root.append(content);
  document.body.append(host);
  let markup;
  try {
    await Promise.all([...card.querySelectorAll("img")].map((image) => image.decode()));
    await document.fonts.ready;
    fitCard(card);
    markup = new XMLSerializer().serializeToString(content);
  } finally {
    host.remove();
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("Could not encode share image"))), "image/png");
  });
}

export async function renderAchievementShareCard({
  id,
  grade,
  earnedAt,
  timeZone,
  locale,
  skinId,
  mode,
  showCharacters = true,
}) {
  const achievement = ACHIEVEMENT_CONTENT.find((entry) => entry.id === id);
  const level = achievement?.tiered ? ["bronze", "silver", "gold"].indexOf(grade) : grade === "stone" ? 0 : -1;
  const english = locale === "en-US" || locale === "en";
  const condition = ACHIEVEMENT_SHARE_CONDITIONS[id]?.[english ? "en" : "zh"]?.[level];
  const date = new Date(earnedAt);
  if (!achievement || !condition || !earnedAt || !Number.isFinite(date.getTime()))
    throw new TypeError("Missing earned achievement details");
  const theme = mode === "dark" ? "dark" : "light";
  const art = achievementShareArt(skinId, theme);
  const [stylesheet, background, figure, medal] = await Promise.all([
    loadCss(),
    art && embedImage(art.background),
    art && showCharacters && embedImage(art.figure),
    medalImage(id, grade),
  ]);
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.shareExport = "";
  card.dataset.skin = art ? skinId : "classic";
  card.dataset.mode = theme;
  card.style.cssText = `width:${WIDTH}px;border-radius:${ROUNDNESS}px;box-shadow:none`;
  for (const [property, value] of paletteDeclarations(card.dataset.skin, theme) ?? []) {
    card.style.setProperty(property, value);
  }
  card.innerHTML = cardContents;
  if (background) card.querySelector(".art").src = background;
  else card.querySelector(".art").remove();
  if (figure) {
    card.querySelector(".character").src = figure;
  } else {
    card.dataset.noFigure = "";
    card.querySelector(".standee").remove();
    card.querySelector(".table").remove();
  }
  card.querySelector(".medal").src = medal;
  setCopy(card, {
    copy: achievementCopy(achievement, locale),
    condition,
    date: formatDate(date, english, timeZone),
    english,
  });
  return rasterize(card, stylesheet);
}
