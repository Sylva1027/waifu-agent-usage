const frameDuration = 1000 / 12;
const lastFrame = 108;
const artworkWidth = 1000;
const artworkHeight = 960;
const art = {
  edge: {
    left: 0,
    top: 82,
    width: 165,
    height: 628,
    pivot: -40,
    delay: 0.05,
    period: 3.55,
    angle: 3.2,
    damping: 2.9,
    shadowDrop: 13,
    joints: [
      { x: 35, y: 247, delay: 0.2, gain: 2.65 },
      { x: 65, y: 434, delay: 0.28, gain: 2 },
    ],
  },
  slender: {
    left: 137,
    width: 155,
    height: 889,
    pivot: 146,
    delay: 0.14,
    period: 3.8,
    angle: 2.25,
    damping: 3.1,
    shadowDrop: 8,
    joints: [{ x: 222, y: 640, delay: 0.2, gain: 4.4 }],
  },
  long: {
    left: 296,
    width: 214,
    height: 724,
    pivot: 305,
    delay: 0,
    period: 3.25,
    angle: 2,
    damping: 2.8,
    shadowDrop: 13,
    joints: [{ x: 382, y: 398, delay: 0.19, gain: 2.8 }],
  },
  inner: {
    left: 389,
    width: 184,
    height: 511,
    pivot: 399,
    delay: 0.23,
    period: 2.9,
    angle: 2.9,
    damping: 2.55,
    shadowDrop: 15,
    joints: [{ x: 480, y: 290, delay: 0.19, gain: 2.9 }],
  },
  short: {
    left: 540,
    width: 152,
    height: 201,
    pivot: 548,
    delay: 0.35,
    period: 2.35,
    angle: 4.4,
    damping: 2.05,
    joints: [],
  },
};

const artwork = {
  light: {
    background: new URL("./art/background-light.webp", import.meta.url),
    edge: new URL("./art/edge-light.webp", import.meta.url),
    "edge-shadow": new URL("./art/edge-shadow-light.webp", import.meta.url),
    slender: new URL("./art/slender-light.webp", import.meta.url),
    "slender-shadow": new URL("./art/slender-shadow-light.webp", import.meta.url),
    long: new URL("./art/long-light.webp", import.meta.url),
    "long-shadow": new URL("./art/long-shadow-light.webp", import.meta.url),
    inner: new URL("./art/inner-light.webp", import.meta.url),
    "inner-shadow": new URL("./art/inner-shadow-light.webp", import.meta.url),
    short: new URL("./art/short-light.webp", import.meta.url),
    "short-shadow": new URL("./art/short-shadow-light.webp", import.meta.url),
  },
  dark: {
    background: new URL("./art/background-dark.webp", import.meta.url),
    edge: new URL("./art/edge-dark.webp", import.meta.url),
    "edge-shadow": new URL("./art/edge-shadow-dark.webp", import.meta.url),
    slender: new URL("./art/slender-dark.webp", import.meta.url),
    "slender-shadow": new URL("./art/slender-shadow-dark.webp", import.meta.url),
    long: new URL("./art/long-dark.webp", import.meta.url),
    "long-shadow": new URL("./art/long-shadow-dark.webp", import.meta.url),
    inner: new URL("./art/inner-dark.webp", import.meta.url),
    "inner-shadow": new URL("./art/inner-shadow-dark.webp", import.meta.url),
    short: new URL("./art/short-dark.webp", import.meta.url),
    "short-shadow": new URL("./art/short-shadow-dark.webp", import.meta.url),
  },
};

function buildStrand(scene, name, layer) {
  const { left, top = 0, width, height, pivot, joints, shadowDrop = 0 } = art[name];
  const carrier = document.createElement("div");
  carrier.className = "gemini-ambient-strand";
  carrier.dataset[layer] = name;
  carrier.style.left = `${(left / artworkWidth) * 100}%`;
  carrier.style.top = `${(top / artworkHeight) * 100}%`;
  carrier.style.width = `${(width / artworkWidth) * 100}%`;
  carrier.style.aspectRatio = `${width} / ${height}`;
  carrier.style.transformOrigin = `${((pivot - left) / width) * 100}% ${(-top / height) * 100}%`;
  scene.append(carrier);

  const offset = layer === "shadow" ? shadowDrop : 0;
  const segments = [carrier];
  const images = [];
  let cut = 0;
  let parent = carrier;

  for (const joint of [...joints, null]) {
    const bottom = joint ? joint.y + offset - top : height;
    const image = document.createElement("img");
    image.className = "gemini-ambient-part";
    image.alt = "";
    if (joints.length) image.style.clipPath = `inset(${(cut / height) * 100}% 0 ${(1 - bottom / height) * 100}% 0)`;
    parent.append(image);
    images.push(image);
    if (joint) {
      const child = document.createElement("div");
      child.className = "gemini-ambient-segment";
      child.dataset.joint = String(segments.length);
      child.style.transformOrigin = `${((joint.x - left) / width) * 100}% ${((joint.y - top) / height) * 100}%`;
      parent.append(child);
      segments.push(child);
      parent = child;
    }
    cut = bottom;
  }
  return { segments, images, asset: layer === "shadow" ? `${name}-shadow` : name };
}

export function mount({ root, characters }) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const wall = document.createElement("div");
  wall.id = "gemini-ambient-wall";
  wall.setAttribute("aria-hidden", "true");
  const backdrop = document.createElement("div");
  backdrop.id = "gemini-ambient";
  backdrop.setAttribute("aria-hidden", "true");

  const strands = [];
  for (const side of ["left", "right"]) {
    const scene = document.createElement("div");
    scene.className = `gemini-ambient-scene gemini-ambient-scene--${side}`;
    const wallScene = scene.cloneNode();
    wall.append(wallScene);
    for (const name of side === "left" ? Object.keys(art) : ["short"]) {
      const metal = buildStrand(scene, name, "strand");
      const shadow = buildStrand(wallScene, name, "shadow");
      strands.push({ name, metal, shadow });
    }
    backdrop.append(scene);
  }
  characters.before(wall);
  characters.after(backdrop);

  let mode;
  let ready = false;
  let version = 0;
  let active = false;
  let frame = 0;
  let elapsed = 0;
  let started = null;
  let timer = 0;
  let pendingImages = [];

  function releasePendingImages() {
    for (const image of pendingImages) image.removeAttribute("src");
    pendingImages = [];
  }

  function pendulum(spec, seconds) {
    const { delay, period, angle, damping } = spec;
    const age = Math.max(0, seconds - delay);
    const strength = Math.min(1, age / 0.5) * Math.exp(-age / damping);
    return -angle * strength * Math.sin((age / period) * 2 * Math.PI);
  }

  function paint(nextFrame) {
    frame = nextFrame;
    backdrop.dataset.frame = String(frame);
    const seconds = (frame * frameDuration) / 1000;
    const tail = Math.min(1, ((lastFrame - frame) * frameDuration) / 1000);
    for (const { name, metal, shadow } of strands) {
      const spec = art[name];
      const upper = pendulum(spec, seconds);
      let parent = 0;
      for (let index = 0; index < metal.segments.length; index++) {
        const joint = spec.joints[index - 1];
        // The upper segment carries the joint. Lag its lower arm enough for the pendant itself to turn later.
        const angle = joint ? upper + (pendulum(spec, seconds - joint.delay) - upper) * joint.gain : upper;
        const transform = `rotate(${((angle - parent) * tail).toFixed(3)}deg)`;
        metal.segments[index].style.transform = transform;
        shadow.segments[index].style.transform = transform;
        parent = angle;
      }
    }
  }

  function canPlay() {
    return active && ready && !root.dataset.themeTransition && !document.hidden && document.hasFocus();
  }

  function freeze() {
    clearTimeout(timer);
    timer = 0;
    if (started !== null) {
      elapsed = performance.now() - started;
      started = null;
    }
    backdrop.dataset.running = "false";
  }

  function scheduleTick() {
    const next = started + (frame + 1) * frameDuration;
    timer = setTimeout(tick, Math.max(0, Math.ceil(next - performance.now())));
  }

  function tick() {
    timer = 0;
    if (!canPlay()) return freeze();
    const nextFrame = Math.floor((performance.now() - started) / frameDuration);
    if (nextFrame >= lastFrame) return stop();
    if (nextFrame > frame) paint(nextFrame);
    scheduleTick();
  }

  function syncPlayback() {
    if (!canPlay()) return freeze();
    if (started !== null) return;
    started = performance.now() - elapsed;
    backdrop.dataset.running = "true";
    scheduleTick();
  }

  function stop() {
    active = false;
    freeze();
    elapsed = 0;
    paint(0);
  }

  function requestGust(reason) {
    // A gust paused by focus, palette transition or decoding still owns the playhead.
    if (reducedMotion.matches || active || !mode || root.dataset.skin !== "gemini") return;
    backdrop.dataset.trigger = reason;
    active = true;
    syncPlayback();
  }

  function releaseArtwork() {
    backdrop.dataset.ready = wall.dataset.ready = "false";
    wall.style.removeProperty("--gemini-plate");
    for (const { metal, shadow } of strands) {
      for (const image of [...metal.images, ...shadow.images]) image.removeAttribute("src");
    }
  }

  async function syncTheme() {
    const next = root.dataset.skin === "gemini" ? root.dataset.theme || "light" : "";
    if (mode === next) return syncPlayback();
    const previous = mode;
    mode = next;
    const load = ++version;
    releasePendingImages();
    ready = false;
    freeze();
    delete wall.dataset.unavailable;
    if (!mode) {
      stop();
      delete backdrop.dataset.trigger;
      releaseArtwork();
      return;
    }

    requestGust(previous ? "theme" : "entry");
    const layers = strands.flatMap(({ metal, shadow }) => [metal, shadow]);
    const assets = new Set(["background", ...layers.map(({ asset }) => asset)]);
    try {
      const urls = artwork[next];
      pendingImages = [...assets].map((name) => {
        const image = new Image();
        image.src = urls[name].href;
        return image;
      });
      await Promise.all(pendingImages.map((image) => image.decode()));
      if (load !== version) return;
      wall.style.setProperty("--gemini-plate", `url("${urls.background.href}")`);
      for (const { asset, images } of layers) {
        for (const image of images) image.src = urls[asset].href;
      }
      backdrop.dataset.mode = next;
      backdrop.dataset.ready = wall.dataset.ready = "true";
      ready = true;
      syncPlayback();
    } catch {
      if (load !== version) return;
      backdrop.dataset.ready = wall.dataset.ready = "false";
      wall.dataset.unavailable = "true";
      releaseArtwork();
      stop();
    } finally {
      if (load === version) releasePendingImages();
    }
  }

  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  reducedMotion.addEventListener(
    "change",
    () => {
      if (reducedMotion.matches) stop();
    },
    options,
  );
  for (const event of ["focus", "blur"]) window.addEventListener(event, syncPlayback, options);
  document.addEventListener("visibilitychange", syncPlayback, options);
  document.addEventListener("waifu:achievement-earned", () => requestGust("achievement"), options);
  const observer = new MutationObserver(syncTheme);
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["data-skin", "data-theme", "data-theme-transition"],
  });
  syncTheme();

  return () => {
    listeners.abort();
    observer.disconnect();
    version++;
    releasePendingImages();
    freeze();
    releaseArtwork();
    wall.remove();
    backdrop.remove();
  };
}
