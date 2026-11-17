import { getLocale } from "./i18n.js";

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
  button.addEventListener("click", onOpen);
  document.querySelector(".auto-refresh-well").append(button);

  function localize() {
    button.textContent = getLocale() === "en-US" ? "New achievement" : "新成就";
  }
  localize();
  return {
    update(snapshot) {
      button.hidden = !(
        snapshot?.state === "ready" &&
        Number.isSafeInteger(snapshot.awardRevision) &&
        Number.isSafeInteger(snapshot.seenAwardRevision) &&
        snapshot.seenAwardRevision >= 0 &&
        snapshot.awardRevision > snapshot.seenAwardRevision
      );
    },
    localize,
  };
}
