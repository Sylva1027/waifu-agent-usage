import { getLocale } from "./i18n.js";

function playNotice(button) {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  function visibleBounds() {
    if (
      document.hidden ||
      motion.matches ||
      button.hidden ||
      button.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false ||
      document.querySelector("dialog[open], .dialog-backdrop:not([hidden])")
    )
      return null;
    const box = button.getBoundingClientRect();
    const x = (Math.max(0, box.left) + Math.min(document.documentElement.clientWidth, box.right)) / 2;
    const y = (Math.max(0, box.top) + Math.min(document.documentElement.clientHeight, box.bottom)) / 2;
    return button.contains(document.elementFromPoint(x, y)) ? box : null;
  }

  if (!visibleBounds()) return;
  const cancel = new AbortController();
  let canvas, effect;

  function stop() {
    if (cancel.signal.aborted) return;
    cancel.abort();
    observer.disconnect();
    effect?.dispose();
    canvas?.remove();
    canvas = effect = null;
  }

  function sync() {
    const box = visibleBounds();
    if (!box) {
      stop();
      return;
    }
    if (canvas) {
      const left = box.left + (box.width - canvas.offsetWidth) / 2;
      const top = box.top + (box.height - canvas.offsetHeight) / 2;
      canvas.style.left = `${Math.max(0, Math.min(left, document.documentElement.clientWidth - canvas.offsetWidth))}px`;
      canvas.style.top = `${Math.max(0, Math.min(top, document.documentElement.clientHeight - canvas.offsetHeight))}px`;
    }
  }

  const observer = new MutationObserver(sync);
  observer.observe(button.parentElement, { attributes: true, attributeFilter: ["class", "hidden"] });
  for (const dialog of document.querySelectorAll("dialog, .dialog-backdrop")) {
    observer.observe(dialog, { attributes: true, attributeFilter: ["open", "hidden"] });
  }
  const options = { signal: cancel.signal };
  document.addEventListener("visibilitychange", sync, options);
  document.addEventListener("scroll", sync, { ...options, capture: true, passive: true });
  window.addEventListener("resize", sync, options);
  window.addEventListener("pagehide", stop, options);
  motion.addEventListener("change", sync, options);

  void import("./waifu-achievement-notice-effect.js")
    .then(({ playAchievementNoticeEffect }) => {
      if (cancel.signal.aborted) return;
      if (!visibleBounds()) return stop();
      canvas = document.createElement("canvas");
      canvas.className = "achievement-notice-effect";
      canvas.setAttribute("aria-hidden", "true");
      document.body.append(canvas);
      sync();
      if (cancel.signal.aborted) return;
      const handle = playAchievementNoticeEffect({ button, canvas, onFinish: stop });
      if (cancel.signal.aborted) handle.dispose();
      else effect = handle;
    })
    .catch(stop);
  return stop;
}

export function createAchievementNotice({ onOpen }) {
  const button = document.createElement("button");
  button.id = "achievementNotice";
  button.className = "achievement-notice";
  button.type = "button";
  button.hidden = true;
  button.dataset.i18nSkip = "";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", "achievementDialog");
  button.setAttribute("aria-live", "polite");
  let profile, latestAward, stopEffect;
  button.addEventListener("click", (event) => {
    stopEffect?.();
    onOpen(event);
  });
  document.querySelector(".auto-refresh-well").append(button);

  function localize() {
    stopEffect?.();
    button.textContent = getLocale() === "en-US" ? "New achievement" : "新成就";
  }
  localize();
  return {
    update(snapshot) {
      const { profileId, awardRevision, seenAwardRevision } = snapshot ?? {};
      const ready =
        snapshot?.state === "ready" &&
        Number.isSafeInteger(awardRevision) &&
        Number.isSafeInteger(seenAwardRevision) &&
        seenAwardRevision >= 0 &&
        awardRevision >= seenAwardRevision;
      button.hidden = !(ready && awardRevision > seenAwardRevision);
      if (profile !== profileId) {
        stopEffect?.();
        profile = profileId;
        latestAward = undefined;
      }
      if (!ready || !profileId) {
        stopEffect?.();
        return;
      }
      const previous = latestAward;
      latestAward = Math.max(previous ?? 0, awardRevision);
      const earned = previous !== undefined && awardRevision > previous;
      if (earned) document.dispatchEvent(new Event("waifu:achievement-earned"));
      if (button.hidden) stopEffect?.();
      else if (earned) {
        stopEffect?.();
        stopEffect = playNotice(button);
      }
    },
    localize,
  };
}
