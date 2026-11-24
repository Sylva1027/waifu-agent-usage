// The static controls and classic frost are usable while optional assets load.
function loadGlassStyles() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./waifu-liquid-glass.css", import.meta.url).href;
  return new Promise((resolve, reject) => {
    link.onload = resolve;
    link.onerror = () => {
      link.remove();
      reject(new Error("Liquid Glass stylesheet unavailable"));
    };
    document.head.append(link);
  });
}

export function setupMotionGlass() {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  // CSS.supports alone also accepts this syntax in engines that never render it.
  const refraction = "userAgentData" in navigator && CSS.supports("backdrop-filter", "url(#glass)");
  let surface;
  let indicator;
  let inView = false;
  let pageHidden = false;
  let controls;
  let glass;
  let styles;
  let controlsLoading = false;
  let glassLoading = false;

  const visible = () => !document.hidden && !pageHidden;
  const wantsMotion = () => visible() && indicator?.isConnected && !reduced.matches;
  const wantsGlass = () =>
    refraction && visible() && surface?.isConnected && document.documentElement.dataset.skin === "classic";
  function updateMotion() {
    if (!wantsMotion()) {
      controls?.destroy();
      controls = undefined;
    } else if (!controls && !controlsLoading) {
      controlsLoading = true;
      import("./waifu-motion-controls.js")
        .then(({ mountControls }) => {
          if (wantsMotion())
            controls = mountControls((value, velocity) => {
              if (inView) glass?.setOptics(value, velocity);
            });
        })
        .catch(() => {})
        .finally(() => {
          controlsLoading = false;
        });
    }
  }
  function updateGlass() {
    if (!wantsGlass()) {
      glass?.destroy();
      glass = undefined;
    } else if (glass) {
      glass.setVisible(inView);
      if (inView) {
        if (controls) controls.syncOptics();
        else glass.setOptics(0, 0);
      }
    } else if (inView && !glassLoading) {
      glassLoading = true;
      styles ??= loadGlassStyles().catch((error) => {
        styles = undefined;
        throw error;
      });
      Promise.all([import("./waifu-liquid-glass.js"), styles])
        .then(([{ mountGlass }]) => {
          if (wantsGlass() && inView) {
            glass = mountGlass(surface);
            controls?.syncOptics();
          }
        })
        .catch(() => {})
        .finally(() => {
          glassLoading = false;
        });
    }
  }
  function sync() {
    updateMotion();
    updateGlass();
  }
  const visibility =
    refraction && "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) if (entry.target === surface) inView = entry.isIntersecting;
          updateGlass();
        })
      : null;
  function refreshTargets() {
    if (surface?.isConnected && indicator?.isConnected) return;
    const nextSurface = document.querySelector("#skinToggle [data-glass-surface]");
    const nextIndicator = document.querySelector("#timelineModes [data-motion-indicator]");
    if (nextSurface === surface && nextIndicator === indicator) return;
    controls?.destroy();
    controls = undefined;
    if (nextSurface !== surface) {
      glass?.destroy();
      glass = undefined;
      visibility?.disconnect();
      surface = nextSurface;
      inView = !visibility;
      if (surface) visibility?.observe(surface);
    }
    indicator = nextIndicator;
    sync();
  }
  reduced.addEventListener("change", updateMotion);
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pagehide", () => {
    pageHidden = true;
    sync();
  });
  window.addEventListener("pageshow", () => {
    pageHidden = false;
    sync();
  });
  refreshTargets();
  return { updateGlass, refreshTargets, select: (mode) => controls?.select(mode) };
}
