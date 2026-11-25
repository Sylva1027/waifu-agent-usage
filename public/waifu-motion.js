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
  const root = document.body;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const events = new AbortController();
  const options = { signal: events.signal };
  // CSS.supports alone also accepts this syntax in engines that never render it.
  const refraction = "userAgentData" in navigator && CSS.supports("backdrop-filter", "url(#glass)");
  let surface;
  let timelineIndicator;
  let presetIndicator;
  let inView = false;
  let materialVisible = false;
  let pageHidden = false;
  let controls;
  let glass;
  let frameGlass;
  let framesLoading = false;
  let styles;
  let controlsLoading = false;
  let glassLoading = false;

  const visible = () => !events.signal.aborted && !document.hidden && !pageHidden;
  const wantsMotion = () =>
    visible() && !reduced.matches && (timelineIndicator?.isConnected || presetIndicator?.isConnected);
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
          if (wantsMotion()) {
            controls = mountControls(
              (value, velocity) => {
                if (materialVisible) glass?.setOptics(value, velocity);
              },
              timelineIndicator,
              presetIndicator,
            );
            controls.attachFrames(root, frameGlass);
          }
        })
        .catch(() => {})
        .finally(() => {
          controlsLoading = false;
        });
    }
  }
  function updateGlass() {
    materialVisible = inView && surface?.parentElement?.getAttribute("aria-expanded") !== "true";
    if (!wantsGlass()) {
      glass?.destroy();
      glass = undefined;
    } else if (glass) {
      glass.setVisible(materialVisible);
      if (materialVisible) {
        if (controls) controls.syncOptics();
        else glass.setOptics(0, 0);
      }
    } else if (materialVisible && !glassLoading) {
      glassLoading = true;
      styles ??= loadGlassStyles().catch((error) => {
        styles = undefined;
        throw error;
      });
      Promise.all([import("./waifu-liquid-glass.js"), styles])
        .then(([{ mountGlass }]) => {
          if (wantsGlass() && materialVisible) {
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
  function updateFrameGlass() {
    if (!refraction) return;
    if (!visible()) {
      frameGlass?.destroy();
      frameGlass = undefined;
    } else if (!frameGlass && !framesLoading) {
      framesLoading = true;
      import("./waifu-frame-glass.js")
        .then(({ mountFrameGlass }) => {
          if (!visible()) return;
          frameGlass = mountFrameGlass(root);
          controls?.attachFrames(root, frameGlass);
        })
        .catch(() => {})
        .finally(() => {
          framesLoading = false;
        });
    }
  }
  function sync() {
    updateMotion();
    updateFrameGlass();
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
    controls?.refreshFrame();
    if (surface?.isConnected && timelineIndicator?.isConnected && presetIndicator?.isConnected) return;
    const nextSurface = document.querySelector("#skinToggle [data-glass-surface]");
    const nextTimeline = document.querySelector("#timelineModes > [data-motion-indicator]");
    const nextPreset = document.querySelector("#presetButtons > [data-motion-indicator]");
    if (nextSurface === surface && nextTimeline === timelineIndicator && nextPreset === presetIndicator) return;
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
    timelineIndicator = nextTimeline;
    presetIndicator = nextPreset;
    sync();
  }
  reduced.addEventListener("change", updateMotion, options);
  document.addEventListener("visibilitychange", sync, options);
  window.addEventListener(
    "pagehide",
    () => {
      pageHidden = true;
      sync();
    },
    options,
  );
  window.addEventListener(
    "pageshow",
    () => {
      pageHidden = false;
      sync();
    },
    options,
  );
  refreshTargets();
  return {
    updateGlass,
    refreshTargets,
    destroy() {
      events.abort();
      visibility?.disconnect();
      sync();
    },
    syncTimeline: () => controls?.syncTimeline(),
    syncPreset: () => controls?.syncPreset(),
  };
}
