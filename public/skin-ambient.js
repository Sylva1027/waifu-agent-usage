const scenes = {
  glm: {
    load: () => import("./skin-ambient/glm/scene.js"),
    style: new URL("./skin-ambient/glm/scene.css", import.meta.url).href,
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
