const scenes = {
  chatgpt: {
    load: () => import("./skin-ambient/chatgpt/scene.js"),
    style: new URL("./skin-ambient/chatgpt/scene.css", import.meta.url).href,
  },
  claude: {
    load: () => import("./skin-ambient/claude/scene.js"),
    style: new URL("./skin-ambient/claude/scene.css", import.meta.url).href,
  },
  deepseek: {
    load: () => import("./skin-ambient/deepseek/scene.js"),
    style: new URL("./skin-ambient/deepseek/scene.css", import.meta.url).href,
  },
  gemini: {
    load: () => import("./skin-ambient/gemini/scene.js"),
    style: new URL("./skin-ambient/gemini/scene.css", import.meta.url).href,
  },
  glm: {
    load: () => import("./skin-ambient/glm/scene.js"),
    style: new URL("./skin-ambient/glm/scene.css", import.meta.url).href,
  },
  grok: {
    load: () => import("./skin-ambient/grok/scene.js"),
    style: new URL("./skin-ambient/grok/scene.css", import.meta.url).href,
  },
  kimi: {
    load: () => import("./skin-ambient/kimi/scene.js"),
    style: new URL("./skin-ambient/kimi/scene.css", import.meta.url).href,
  },
  qwen: {
    load: () => import("./skin-ambient/qwen/scene.js"),
    style: new URL("./skin-ambient/qwen/scene.css", import.meta.url).href,
  },
};

export function startSkinAmbient() {
  const root = document.documentElement;
  const characters = document.getElementById("skinCharacters");
  if (!characters || root.dataset.skinAmbient === "off") return;

  let active;
  function release() {
    const old = active;
    active = undefined;
    if (!old) return;
    old.cancelStyle();
    old.dispose?.();
    old.link.remove();
  }

  async function sync() {
    const skin = root.dataset.skin;
    if (active?.skin === skin) return;
    release();
    if (!Object.hasOwn(scenes, skin)) return;

    const { load, style } = scenes[skin];
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = style;
    const request = { skin, link };
    const stylesReady = new Promise((resolve) => {
      link.onload = () => resolve(true);
      link.onerror = request.cancelStyle = () => resolve(false);
    });
    active = request;
    document.head.append(link);

    try {
      const [scene, styled] = await Promise.all([load(), stylesReady]);
      if (active !== request || root.dataset.skin !== skin) return;
      if (styled) request.dispose = scene.mount({ root, characters });
      else release();
    } catch (error) {
      if (active !== request) return;
      release();
      console.error("Could not start ambient skin", skin, error);
    }
  }

  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ["data-skin"] });
  void sync();
}
