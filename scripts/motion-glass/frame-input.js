import { springValue } from "motion";

// One optical spring follows the current surface. Window rims only refract statically.
export function bindFrameInput(root, glass, signal, spring) {
  const value = springValue(0, spring);
  let current = null;
  let hover = null;
  let focus = null;
  let pressed = null;
  let pointer = null;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.target === current && !entry.isIntersecting) clear();
  });
  const windows = new MutationObserver((entries) => {
    if (current && entries.some(({ target }) => target.matches("dialog, .dialog-backdrop, [data-glass-window]")))
      clear();
  });
  windows.observe(root, { subtree: true, attributes: true, attributeFilter: ["hidden", "open"] });

  function setFrame(next) {
    if (current === next) return;
    observer.disconnect();
    current = null;
    value.jump(0);
    glass.setFrame(next);
    current = next;
    if (next) observer.observe(next);
  }
  function clear() {
    hover = focus = pressed = null;
    pointer = null;
    setFrame(null);
  }
  function sync() {
    const next = pressed || hover || focus;
    if (next) setFrame(next);
    if (!current) return;
    if (!next && value.get() === 0) setFrame(null);
    else value.set(pressed ? 1 : next ? 0.55 : 0);
  }
  function frameOf(node) {
    if (!(node instanceof Element) || !root.contains(node)) return null;
    if (node.closest("[data-glass-window], .dialog-backdrop")) return null;
    const control = node.closest(".topbar-actions > [data-glass-control]");
    if (control) return control.disabled || control.querySelector(".lg-host") ? null : control;
    const rail = node.closest(":is(#presetButtons, #timelineModes)[data-motion-ready]");
    const indicator = rail?.querySelector(":scope > [data-motion-indicator]");
    if (indicator && !indicator.hidden && !node.closest(".recent-range-menu")) return indicator;
    return node.closest("[data-glass-frame], [data-glass-frame-list] > .comparison-item");
  }
  value.on("change", (amount) => {
    if (current) glass.setOptics(amount, value.getVelocity());
  });
  value.on("animationComplete", () => {
    if (!current) return;
    if (!pressed && !focus && !hover) setFrame(null);
    else glass.setOptics(value.get(), 0);
  });
  const options = { passive: true, signal };
  root.addEventListener(
    "pointerover",
    (event) => {
      if (!event.isPrimary || event.pointerType === "touch") return;
      const next = frameOf(event.target);
      if (next === hover) return;
      hover = next;
      sync();
    },
    options,
  );
  root.addEventListener(
    "pointerleave",
    () => {
      hover = null;
      sync();
    },
    options,
  );
  root.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      if (event.pointerType === "touch") hover = null;
      pressed = frameOf(event.target);
      pointer = event.pointerId;
      sync();
    },
    options,
  );
  const endPointer = (event) => {
    if (event.pointerId !== pointer) return;
    pressed = null;
    pointer = null;
    sync();
  };
  window.addEventListener("pointerup", endPointer, { ...options, capture: true });
  window.addEventListener("pointercancel", endPointer, { ...options, capture: true });
  document.addEventListener(
    "focusin",
    (event) => {
      if (!root.contains(event.target)) return clear();
      focus = event.target.matches(":focus-visible") ? frameOf(event.target) : null;
      if (focus) hover = null;
      sync();
    },
    options,
  );
  root.addEventListener(
    "focusout",
    () => {
      focus = null;
      sync();
    },
    options,
  );
  window.addEventListener("blur", clear, options);
  signal.addEventListener(
    "abort",
    () => {
      clear();
      observer.disconnect();
      windows.disconnect();
      value.destroy();
    },
    { once: true },
  );
  return {
    refresh: () => {
      if (current && !current.isConnected) clear();
    },
  };
}
