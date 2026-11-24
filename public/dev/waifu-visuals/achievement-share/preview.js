// Share the exhibition pose between the preview, thumbnail and PNG. One render per achievement.
const coinFrames = new Map();
let enginePromise;
function loadCoinEngine() {
  enginePromise ??= import("../../../waifu-visuals-core.js");
  return enginePromise;
}
const metals = {
  stone: { color: 0x77746c, shine: 10, specular: 0x353431 },
  bronze: { color: 0xae704f, shine: 48, specular: 0xd1a48a },
  silver: { color: 0xa9acb2, shine: 60, specular: 0xe1e3ea },
  gold: { color: 0xd3a253, shine: 57, specular: 0xe4c98e },
};

const frontBevel = [
  [0.966, -0.1],
  [0.991, -0.092],
  [1, -0.066],
];
const backBevel = [
  [1, 0.066],
  [0.991, 0.092],
  [0.966, 0.1],
];

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

async function renderCoinFrame(id, grade) {
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
  } = await loadCoinEngine();
  const image = new Image();
  image.src = medals[id];
  await image.decode();
  const bounds = findRim(image),
    metal = metals[grade];
  if (!renderCoinFrame.renderer) {
    const renderer = new WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(1024, 1024, false);
    renderer.setClearColor(0x000000, 0);
    renderCoinFrame.renderer = renderer;
  }
  const renderer = renderCoinFrame.renderer;
  const scene = new Scene(),
    camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 15),
    badge = new Group();
  camera.position.z = 4;
  scene.add(badge);
  let texture, face, rim;
  try {
    texture = new Texture(image);
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    face = new Mesh(
      new PlaneGeometry(2, 2),
      new MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.04, toneMapped: false }),
    );
    face.position.z = 0.102;

    const profile = [...frontBevel, ...backBevel].map(([radius, depth]) => new Vector2(radius, depth));
    rim = new Mesh(
      new LatheGeometry(profile, 96).rotateX(Math.PI / 2),
      new MeshPhongMaterial({ color: metal.color, specular: metal.specular, shininess: metal.shine }),
    );
    rim.position.set(bounds.x, bounds.y, 0);
    rim.scale.set(bounds.radiusX * 0.989, bounds.radiusY * 0.989, 1);
    badge.add(rim, face);
    const key = new DirectionalLight(0xfff4df, 2);
    key.position.set(-3, 4, 3);
    const fill = new DirectionalLight(0xcbd9f0, 1.05);
    fill.position.set(2, -1, 2);
    scene.add(key, fill, new AmbientLight(0xffffff, 0.8));
    const radians = Math.PI / 180;
    badge.rotation.set(-8 * radians, 24 * radians, -7 * radians);
    renderer.render(scene, camera);
    const flat = document.createElement("canvas");
    flat.width = flat.height = 1024;
    const ctx = flat.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(renderer.domElement, 0, 0);
    const rgba = ctx.getImageData(0, 0, 1024, 1024).data;
    let left = 1024,
      right = -1,
      top = 1024,
      bottom = -1;
    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++) {
        if (rgba[(y * 1024 + x) * 4 + 3] < 92) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    if (right <= left || bottom <= top) throw new Error("Empty coin");
    left = Math.max(0, left - 2);
    top = Math.max(0, top - 2);
    right = Math.min(1023, right + 2);
    bottom = Math.min(1023, bottom + 2);
    const cropped = document.createElement("canvas");
    cropped.width = right - left + 1;
    cropped.height = bottom - top + 1;
    cropped
      .getContext("2d")
      .drawImage(flat, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    return cropped.toDataURL("image/png");
  } finally {
    for (const mesh of [face, rim]) {
      mesh?.geometry.dispose();
      mesh?.material.dispose();
    }
    texture?.dispose();
    scene.clear();
  }
}
function coinFrame(id, grade) {
  if (!coinFrames.has(id)) coinFrames.set(id, renderCoinFrame(id, grade));
  return coinFrames.get(id);
}
window.addEventListener("pagehide", () => {
  renderCoinFrame.renderer?.dispose();
  renderCoinFrame.renderer = null;
});

const data = achievementPreview,
  { medals, examples } = data;
const byId = new Map(examples.map((e) => [e.id, e])),
  select = document.querySelector("#achievement-select");
const languageButtons = document.querySelectorAll(".languages button");
for (const slot of document.querySelectorAll(".maincard,.mini,.paircard")) {
  slot.append(document.querySelector("template").content.cloneNode(true));
}
const cards = Array.from(document.querySelectorAll(".card"));
const viewer = document.querySelector("#share-viewer"),
  stage = viewer.querySelector(".viewer-stage");
const closeButton = viewer.querySelector(".viewer-close"),
  previewPage = document.querySelector("main");
let viewerOpener = null,
  wasFullscreen = false,
  viewerCornerRatio = 0;
function sizeViewer() {
  const copy = stage.firstElementChild;
  if (!copy || viewer.hidden) return;
  const width = Math.min(stage.clientWidth, (stage.clientHeight * 4) / 5);
  copy.style.width = width + "px";
  copy.style.borderRadius = width * viewerCornerRatio + "px";
}
function leaveNativeViewer() {
  if (document.fullscreenElement === viewer) return document.exitFullscreen().catch(() => {});
}
function closeViewer() {
  if (viewer.hidden) return;
  wasFullscreen = false;
  const opener = viewerOpener,
    nativeExit = leaveNativeViewer();
  viewer.hidden = true;
  stage.replaceChildren();
  previewPage.inert = false;
  document.documentElement.classList.remove("viewing-share");
  viewerOpener = null;
  opener?.focus({ preventScroll: true });
  nativeExit?.then(() => {
    if (viewer.hidden) opener?.focus({ preventScroll: true });
  });
}
function openViewer(source, button) {
  if (!viewer.hidden) return;
  viewerOpener = button;
  const copy = source.cloneNode(true),
    layout = getComputedStyle(source);
  viewerCornerRatio = parseFloat(layout.borderTopLeftRadius) / parseFloat(layout.width);
  stage.replaceChildren(copy);
  viewer.setAttribute(
    "aria-label",
    source.querySelector("h2").textContent + " · " + (source.dataset.mode === "dark" ? "深色" : "浅色") + "分享卡",
  );
  viewer.hidden = false;
  previewPage.inert = true;
  document.documentElement.classList.add("viewing-share");
  sizeViewer();
  closeButton.focus({ preventScroll: true });
  if (document.fullscreenEnabled && !document.fullscreenElement) viewer.requestFullscreen().catch(() => {});
}
for (const source of cards) {
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "card-open";
  const label = source.closest(".mini")
    ? "全屏查看聊天缩略图"
    : source.closest(".paircard")
      ? "全屏查看深色分享卡"
      : "全屏查看分享卡";
  openButton.setAttribute("aria-label", label);
  openButton.title = label;
  openButton.setAttribute("aria-haspopup", "dialog");
  openButton.addEventListener("click", () => openViewer(source, openButton));
  source.after(openButton);
}
closeButton.addEventListener("click", closeViewer);
viewer.addEventListener("click", (event) => {
  if (!event.target.closest("button")) closeViewer();
});
viewer.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeViewer();
  }
  if (event.key === "Tab") {
    event.preventDefault();
    closeButton.focus();
  }
});
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === viewer) {
    wasFullscreen = !viewer.hidden;
    if (viewer.hidden) leaveNativeViewer();
  } else if (wasFullscreen) closeViewer();
});
new ResizeObserver(sizeViewer).observe(stage);

let current = "A14",
  language = "zh";
const skinSelect = document.querySelector("#skin-select");
const appearanceButtons = [...document.querySelectorAll("[data-appearance]")];
const treatmentCatalog = {
  chatgpt: {
    scene: "tide",
    label: "鳞间珠光",
    materials: { relief: "浅浮雕折射", flat: "原图直叠" },
  },
  claude: {
    scene: "leaf",
    label: "夹页花信",
    materials: { relief: "浅浮雕折射", flat: "来稿直叠" },
  },
  glm: {
    scene: "weave",
    label: "靛蓝织谱",
    materials: { relief: "浅浮雕折射", flat: "来稿直叠" },
  },
  gemini: {
    scene: "curtain",
    label: "风过星帘",
    materials: { relief: "浅浮雕折射", flat: "来稿直叠" },
  },
  qwen: {
    scene: "fan",
    label: "折扇流光",
    materials: { refraction: "浮雕折射", lineart: "WebP 直贴" },
  },
  deepseek: {
    scene: "sea",
    label: "洄游潮光",
    materials: { relief: "浅浮雕折射", flat: "原图直叠" },
  },
};

const sceneRow = document.querySelector(".scene-row");
const fixedScene = sceneRow.querySelector(".fixed-scene");
const materialButtons = sceneRow.querySelector(".material-buttons");
let controlSkin;

function renderMaterials(values) {
  const buttons = Object.entries(values).map(([id, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.materialChoice = id;
    button.textContent = label;
    return button;
  });
  materialButtons.replaceChildren(...buttons);
}

function setTreatment(skin, material) {
  const preset = treatmentCatalog[skin];
  if (controlSkin !== skin) {
    controlSkin = skin;
    sceneRow.hidden = !preset;
    fixedScene.textContent = preset?.label || "";
    if (preset) {
      fixedScene.dataset.fixedScene = preset.scene;
    } else {
      delete fixedScene.dataset.fixedScene;
    }
    renderMaterials(preset?.materials || {});
    materialButtons.closest(".material-options").hidden = !preset?.materials;
  }
  const state = document.body.dataset;
  if (!preset) {
    delete state.scene;
    delete state.texture;
    delete state.material;
    return;
  }
  state.scene = preset.scene;
  if (skin === "qwen") state.texture = state.scene;
  else delete state.texture;
  if (!preset.materials) {
    delete state.material;
    return;
  }
  state.material = Object.hasOwn(preset.materials, material) ? material : Object.keys(preset.materials)[0];
  for (const button of materialButtons.children) {
    button.setAttribute("aria-pressed", String(button.dataset.materialChoice === state.material));
  }
  // A material change reuses the cards already painted for this skin.
  for (const card of cards) {
    if (card.dataset.skin !== skin) continue;
    const image = card.querySelector(".character");
    const src = portraitSource(skin, card.dataset.mode);
    if (image.getAttribute("src") !== src) image.src = src;
  }
}

function saveView() {
  const state = document.body.dataset;
  const params = new URLSearchParams();
  if (language !== "zh") params.set("lang", language);
  const preset = treatmentCatalog[selectedSkin];
  if (state.material && state.material !== Object.keys(preset.materials)[0]) params.set("material", state.material);
  // A legacy URL may carry settings in its search string. Mark the new hash as authoritative.
  const suffix = params.size || location.search ? "?" + params : "";
  const view = "#" + [current, selectedSkin, appearance].join("/") + suffix;
  history.replaceState(null, "", view);
}

materialButtons.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-material-choice]");
  if (!button) return;
  setTreatment(selectedSkin, button.dataset.materialChoice);
  saveView();
});

for (const [id, skin] of Object.entries(data.skins)) {
  const finished = Boolean(treatmentCatalog[id]?.materials);
  const option = new Option((finished ? "✓ " : "○ ") + skin.name, id);
  option.setAttribute("aria-label", skin.name + (finished ? "，已完成玻璃改造" : "，待改造"));
  skinSelect.add(option);
}
let selectedSkin = "deepseek",
  appearance = "light";

const nacreRelief = { light: "./art/chatgpt/relief-light.webp", dark: "./art/chatgpt/relief-dark.webp" };
const qwenGlassPortrait = "./art/qwen/source.png";
function fitQwenFrame(card, id) {
  const image = card.querySelector(".character");
  const previous = image.closest(".character-frame");
  if (id !== "qwen") {
    if (previous) previous.replaceWith(image);
    return;
  }
  if (previous) return;
  const frame = document.createElement("div");
  frame.className = "character-frame";
  const optics = document.createElement("span");
  optics.className = "optical-plane";
  optics.setAttribute("aria-hidden", "true");
  image.replaceWith(frame);
  frame.append(optics, image);
}
function portraitSource(id, mode) {
  if (id === "glm" || id === "claude" || id === "gemini") {
    const file = document.body.dataset.material === "flat" ? "source.png" : `relief-${mode}.webp`;
    return `./art/${id}/${file}`;
  }
  if (id === "qwen") return qwenGlassPortrait;
  const active =
    id === "chatgpt" && document.body.dataset.scene === "tide" && document.body.dataset.material === "relief";
  return active ? nacreRelief[mode] : data.skins[id][mode].image;
}
function paintCharacter(card, id, mode) {
  fitQwenFrame(card, id);
  if (card.dataset.skin === id && card.dataset.mode === mode) return;
  const skin = data.skins[id],
    variant = skin[mode];
  for (const [name, value] of Object.entries(variant.palette)) card.style.setProperty(name, value);
  const image = card.querySelector(".character");
  image.src = portraitSource(id, mode);
  card.querySelector(".ink-density").src = variant.image;
  image.alt = skin.name + " 玻璃立牌";
  card.dataset.skin = id;
  card.dataset.mode = mode;
}
function changeAppearance(id, mode) {
  if (controlSkin !== id) setTreatment(id);
  document.body.dataset.previewSkin = id;
  selectedSkin = id;
  appearance = mode;
  skinSelect.value = id;
  const pair = mode === "pair";
  document.body.dataset.layout = pair ? "pair" : "single";
  document.querySelector(".primary-sample .mode-caption").hidden = !pair;
  document.querySelector(".dark-sample").hidden = !pair;
  document.querySelector(".page aside").hidden = pair;
  for (const button of appearanceButtons)
    button.setAttribute("aria-pressed", String(button.dataset.appearance === mode));
  for (const card of cards) {
    const singleMode = mode === "dark" ? "dark" : "light";
    paintCharacter(card, id, card.parentElement.classList.contains("paircard") ? "dark" : singleMode);
    if (card.querySelector(".heading h2").textContent) fitCard(card);
  }
}
skinSelect.addEventListener("change", () => {
  changeAppearance(skinSelect.value, appearance);
  saveView();
});
for (const button of appearanceButtons)
  button.addEventListener("click", () => {
    changeAppearance(selectedSkin, button.dataset.appearance);
    saveView();
  });
const highlight = ["A14", "A76", "A54", "A13", "A11", "A36", "A32"];
function populate() {
  const groups = [
    ["排版样例", highlight],
    ["其他成就", examples.map((e) => e.id).filter((id) => !highlight.includes(id))],
  ];
  select.replaceChildren();
  for (const [label, ids] of groups) {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const id of ids) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = byId.get(id)[language].title;
      group.append(o);
    }
    select.append(group);
  }
  select.value = current;
}
const titleSteps = [
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
const storySteps = [
  [6.8, 3.3],
  [6.2, 3.3],
  [5.7, 3.3],
  [5.2, 3.25],
  [4.75, 3.2],
  [4.35, 3.15],
  [4.05, 3.1],
  [3.8, 3.05],
];
function fitCard(card) {
  if (!card.clientWidth) return;
  const title = card.querySelector(".heading h2"),
    bar = card.querySelector(".story"),
    copy = card.querySelector(".story-copy");
  for (const [size, lines] of titleSteps) {
    title.style.fontSize = size + "cqw";
    const line = parseFloat(getComputedStyle(title).lineHeight);
    if (title.offsetHeight <= lines * line + 1 && title.scrollWidth <= title.clientWidth + 1) break;
  }
  const style = getComputedStyle(bar);
  const available = bar.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  for (const [fact, detail] of storySteps) {
    copy.style.setProperty("--fact-size", fact + "cqw");
    copy.style.setProperty("--detail-size", detail + "cqw");
    if (copy.offsetHeight <= available + 0.5 && copy.scrollWidth <= copy.clientWidth + 1) break;
  }
}
function setCopy(card, e, lang, level = e.grade === "silver" ? 1 : 0) {
  const copy = e[lang];
  card.lang = lang === "zh" ? "zh-CN" : "en";
  card.querySelector(".heading h2").textContent = copy.title;
  card.querySelector(".date").textContent = lang === "zh" ? "2026.11.23 获得" : "Earned Nov 23, 2026";
  const fact = card.querySelector(".fact");
  const condition = copy.conditions[level];
  fact.textContent = condition.fact;
  if (condition.qualifier) {
    const note = document.createElement("span");
    note.className = "qualifier";
    note.textContent = condition.qualifier;
    fact.append(document.createTextNode(" "), note);
  }
  card.querySelector(".detail").textContent = copy.detail;
  card.querySelector(".medal").alt = lang === "zh" ? copy.title + "纪念币" : copy.title + " medal";
  fitCard(card);
}
async function show(id, lang) {
  const e = byId.get(id);
  if (!e) return;
  const previous = current;
  current = id;
  language = lang;
  select.value = id;
  for (const button of languageButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.language === lang));
  }
  for (const card of cards) {
    setCopy(card, e, lang);
    if (previous === id && card.dataset.achievement === id) continue;
    const image = card.querySelector(".medal");
    if (data.poses?.[id]) image.src = data.poses[id];
    else image.removeAttribute("src");
    card.dataset.pose = data.poses?.[id] ? "saved" : "pending";
    card.dataset.achievement = id;
  }
  if (location.protocol === "file:" && data.poses?.[id]) return;
  try {
    const frame = await coinFrame(id, e.grade);
    if (current !== id) return;
    for (const card of cards) {
      card.querySelector(".medal").src = frame;
      card.dataset.pose = "webgl";
    }
  } catch (error) {
    if (!data.poses?.[id]) console.error(error);
  }
}
select.addEventListener("change", () => {
  show(select.value, language);
  saveView();
});
for (const button of languageButtons) {
  button.addEventListener("click", () => {
    language = button.dataset.language;
    populate();
    show(current, language);
    saveView();
  });
}
const observer = new ResizeObserver((entries) => {
  for (const entry of entries) fitCard(entry.target);
});
for (const card of cards) observer.observe(card);
document.fonts.ready.then(() => cards.forEach(fitCard));
function openExample() {
  const [route, settings] = location.hash.slice(1).split("?");
  const [id, skin, view] = (route || "A14/chatgpt/pair").split("/");
  const validSkin = Object.hasOwn(data.skins, skin) ? skin : "chatgpt";
  const params = new URLSearchParams(settings === undefined ? location.search : settings);
  language = params.get("lang") === "en" ? "en" : "zh";
  populate();
  setTreatment(validSkin, params.get("material"));
  changeAppearance(validSkin, ["light", "dark", "pair"].includes(view) ? view : "light");
  show(byId.has(id) ? id : "A14", language);
}
window.addEventListener("hashchange", openExample);
openExample();
