import { springValue } from "motion";

const spring = { stiffness: 480, damping: 32, mass: 0.8 };

export function mountControls(onOptics) {
  const group = document.querySelector("#timelineModes");
  const indicator = group.querySelector("[data-motion-indicator]");
  const tabs = [...group.querySelectorAll("button[data-timeline-mode]")];
  const position = springValue(0, spring);
  position.on("change", (x) => {
    indicator.style.transform = `translateX(${x}px)`;
  });
  let selection;
  function align(animate) {
    if (!selection?.offsetWidth) {
      group.removeAttribute("data-motion-ready");
      return;
    }
    const x = selection.offsetLeft;
    indicator.style.width = `${selection.offsetWidth}px`;
    if (animate && group.hasAttribute("data-motion-ready")) position.set(x);
    else position.jump(x);
    group.setAttribute("data-motion-ready", "");
  }
  function select(mode) {
    const next = tabs.find((button) => button.dataset.timelineMode === mode);
    if (next === selection) return;
    selection = next;
    align(true);
  }
  selection = group.querySelector('[aria-pressed="true"]');
  align(false);
  const observer = new ResizeObserver(() => align(false));
  for (const node of [group, ...tabs]) observer.observe(node);

  const events = new AbortController();
  const options = { signal: events.signal };
  const values = new Map();
  const glassButton = document.querySelector("#skinToggle");
  let down = null;
  let pointerId = null;

  function release() {
    if (down) values.get(down).set(0);
    down = null;
    pointerId = null;
  }
  function press(button, pointer) {
    if (button.disabled || down === button) return;
    release();
    let value = values.get(button);
    if (!value) {
      const content = button.querySelectorAll("[data-motion-content]");
      if (!content.length) return;
      value = springValue(0, spring);
      value.on("change", (amount) => {
        for (const item of content) item.style.scale = amount === 0 ? "" : String(1 - amount * 0.095);
        if (button === glassButton) onOptics(amount, value.getVelocity());
      });
      if (button === glassButton) value.on("animationComplete", () => onOptics(value.get(), 0));
      values.set(button, value);
    }
    down = button;
    pointerId = pointer;
    value.set(1);
  }
  const activationKey = (event) => event.key === "Enter" || event.key === " ";
  const toolbar = document.querySelector(".topbar-actions");
  toolbar.addEventListener(
    "pointerdown",
    (event) => {
      const button = event.target.closest("button");
      if (button && event.isPrimary && event.button === 0) press(button, event.pointerId);
    },
    options,
  );
  toolbar.addEventListener(
    "keydown",
    (event) => {
      const button = event.target.closest("button");
      if (button && !event.repeat && activationKey(event)) press(button, null);
    },
    options,
  );
  toolbar.addEventListener(
    "keyup",
    (event) => {
      if (down && down.contains(event.target) && activationKey(event) && pointerId === null) release();
    },
    options,
  );
  toolbar.addEventListener(
    "focusout",
    (event) => {
      if (down?.contains(event.target)) release();
    },
    options,
  );
  const endPointer = (event) => {
    if (event.pointerId === pointerId) release();
  };
  window.addEventListener("pointerup", endPointer, { ...options, capture: true });
  window.addEventListener("pointercancel", endPointer, { ...options, capture: true });
  window.addEventListener("blur", release, options);

  return {
    select,
    syncOptics() {
      const value = values.get(glassButton);
      onOptics(value?.get() ?? 0, value?.getVelocity() ?? 0);
    },
    destroy() {
      events.abort();
      observer.disconnect();
      position.destroy();
      group.removeAttribute("data-motion-ready");
      indicator.style.removeProperty("transform");
      indicator.style.removeProperty("width");
      for (const [button, value] of values) {
        value.destroy();
        for (const item of button.querySelectorAll("[data-motion-content]")) item.style.removeProperty("scale");
      }
      onOptics(0, 0);
    },
  };
}
