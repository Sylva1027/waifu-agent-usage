import { getLocale } from "./i18n.js";
import { escapeHtml } from "./html-utils.js";
import { achievementCopy, achievementUi, categoryOrder, categoryEnglishLabels } from "./achievement-content.js";
import { achievementRows, visibleAchievements, renderAchievementList } from "./achievement-list.js";
import { renderAchievementDetail } from "./achievement-detail.js";

export function createAchievementDialog({
  readSnapshot,
  onSnapshot = () => {},
  onRecentShown = () => {},
  onShare,
} = {}) {
  const button = document.createElement("button");
  button.id = "achievementToggle";
  button.className = "theme-toggle achievement-toggle";
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", "achievementDialog");
  button.setAttribute("aria-expanded", "false");
  button.dataset.i18nSkip = "";
  button.dataset.glassControl = "";
  button.innerHTML =
    '<svg data-motion-content viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="clipboard-board" d="M9 4H6.5A1.5 1.5 0 0 0 5 5.5v14A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-14A1.5 1.5 0 0 0 17.5 4H15"/><rect x="9" y="2.5" width="6" height="4" rx="1.2"/></svg>';
  const dashboardShare = document.querySelector("#shareToggle");
  dashboardShare.before(button);
  const dialog = document.createElement("dialog");
  dialog.id = "achievementDialog";
  dialog.setAttribute("aria-labelledby", "achievementTitle");
  dialog.dataset.i18nSkip = "";
  dialog.innerHTML = `<header class="app-heading"><h2 id="achievementTitle" tabindex="-1"></h2>
    <div class="status-picker"><button id="achievementStatusFilter" class="recent-combobox" type="button" role="combobox" aria-controls="achievementStatusMenu" aria-expanded="false" aria-haspopup="listbox"><span id="achievementStatusValue"></span><span class="calendar-zone-arrow" aria-hidden="true"></span></button>
    <div id="achievementStatusMenu" class="recent-range-menu" role="listbox" hidden>${["all", "earned", "locked"].map((status) => `<button type="button" role="option" data-status="${status}" aria-selected="${status === "all"}"></button>`).join("")}</div></div></header>
    <div class="achievement-filters"><div class="category-search-well segmented-well"><nav class="category-tabs" id="achievementCategories"></nav><div class="search-slot"><input class="search" id="achievementSearch" type="search" autocomplete="off"></div></div></div>
    <div class="split-layout" id="achievementPreview"><div class="list-column"><div class="achievement-list-frame"><div class="list-well" id="achievementList"></div></div></div><div id="achievementDetail"></div></div>`;
  document.body.append(dialog);
  const $ = (selector) => dialog.querySelector(selector);
  const shareButton = dashboardShare.cloneNode(true);
  shareButton.id = "achievementShareToggle";
  shareButton.disabled = true;
  $(".status-picker").after(shareButton);
  const state = { category: "近期获得", filter: "all", query: "", selectedId: null, previewGrade: null };
  let snapshot = null;
  let failed = false;
  let request = null;
  let preparingRetry = null;
  let opener = null;
  let renderVersion = 0;
  let recentIntent = 0;
  let shownIntent = -1;
  const detail = $("#achievementDetail");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let activeBadge = null;
  let failedBadgeSource = null;
  let shareSelection = null;
  const ui = () => achievementUi(getLocale());
  const menu = (open, focus = false) => {
    $("#achievementStatusMenu").hidden = !open;
    $("#achievementStatusFilter").setAttribute("aria-expanded", String(open));
    if (focus) (open ? $('[data-status][aria-selected="true"]') : $("#achievementStatusFilter")).focus();
  };

  function removeBadge() {
    const previous = activeBadge;
    activeBadge = null;
    previous?.canvas.remove();
    previous?.mounted?.dispose();
  }

  function syncBadge() {
    const image = detail.querySelector(".detail-panel > img.badge");
    if (!dialog.open || document.hidden || reducedMotion.matches || !image || image.classList.contains("is-locked")) {
      removeBadge();
      return;
    }
    if (activeBadge?.image.src === image.src) {
      // Snapshot and locale updates replace the rest of the panel. Keep the mounted texture and its canvas.
      if (activeBadge.image !== image) image.replaceWith(activeBadge.canvas, activeBadge.image);
      return;
    }
    removeBadge();
    if (failedBadgeSource === image.src) return;
    failedBadgeSource = null;
    const canvas = document.createElement("canvas");
    canvas.className = "badge-canvas";
    canvas.setAttribute("aria-hidden", "true");
    image.before(canvas);
    const pending = { image, canvas, mounted: null };
    activeBadge = pending;

    function fallback() {
      if (activeBadge !== pending) return;
      failedBadgeSource = image.src;
      removeBadge();
    }

    void import("./waifu-achievement-badge.js")
      .then(({ mountAchievementBadge }) => {
        if (activeBadge !== pending || !dialog.open || document.hidden || reducedMotion.matches) return;
        const mounted = mountAchievementBadge({
          image,
          canvas,
          host: detail,
          grade: image.parentElement.dataset.badgeGrade,
          onReady() {
            if (activeBadge === pending && dialog.open) canvas.classList.add("is-ready");
          },
          onUnavailable: fallback,
        });
        if (activeBadge === pending) pending.mounted = mounted;
        else mounted.dispose();
      })
      .catch(fallback);
  }

  function fit() {
    if (!dialog.open) return;
    const css = getComputedStyle(dialog);
    const number = (key) => Number.parseFloat(css.getPropertyValue(key)) || 0;
    const fixed =
      number("padding-top") +
      number("padding-bottom") +
      number("border-top-width") +
      number("border-bottom-width") +
      $(".app-heading").getBoundingClientRect().height +
      $(".achievement-filters").getBoundingClientRect().height +
      number("row-gap") * 2;
    const rowHeight = number("--row-height");
    const clearance = innerWidth <= 850 ? 56 : 80;
    const count = Math.min(6, Math.max(1, Math.floor((innerHeight - clearance - fixed) / rowHeight)));
    dialog.style.setProperty("--list-height", `${count * rowHeight}px`);
    dialog.style.height = `${fixed + count * rowHeight}px`;
  }

  function render({ resetScroll = false } = {}) {
    const version = ++renderVersion;
    const active = document.activeElement;
    const focus = dialog.contains(active) ? active : null;
    const locale = getLocale();
    const copy = ui();
    button.title = copy.title;
    button.setAttribute("aria-label", copy.title);
    $("#achievementTitle").textContent = copy.title;
    shareButton.title = locale === "zh-CN" ? "分享该成就" : "Share achievement";
    shareButton.setAttribute("aria-label", shareButton.title);
    for (const id of ["achievementStatusFilter", "achievementStatusMenu"])
      $(`#${id}`).setAttribute("aria-label", copy.status);
    $("#achievementCategories").setAttribute("aria-label", copy.categories);
    $("#achievementSearch").setAttribute("aria-label", copy.search);
    $("#achievementSearch").placeholder = copy.searchPlaceholder;
    $("#achievementStatusValue").textContent = copy.statuses[state.filter];
    for (const option of dialog.querySelectorAll("[data-status]")) {
      option.textContent = copy.statuses[option.dataset.status];
      option.setAttribute("aria-selected", String(option.dataset.status === state.filter));
    }
    $("#achievementCategories").innerHTML = ["近期获得", ...categoryOrder]
      .map(
        (category) =>
          `<button type="button" data-category="${category}" aria-pressed="${category === state.category}">${locale === "zh-CN" ? category : categoryEnglishLabels[category]}</button>`,
      )
      .join("");
    const rows = achievementRows(snapshot);
    const timeZone = snapshot?.timeZone || "UTC";
    const visible = rows ? visibleAchievements(rows, { ...state, timeZone }) : [];
    if (!visible.some((row) => row.id === state.selectedId)) {
      state.selectedId = visible[0]?.id || null;
      state.previewGrade = null;
    }
    const list = $("#achievementList");
    const scroll = resetScroll ? 0 : list.scrollTop;
    if (rows) {
      list.innerHTML = renderAchievementList(visible, {
        selectedId: state.selectedId,
        locale,
        emptyRecent: state.category === "近期获得" && !state.query && state.filter !== "locked",
      });
    } else {
      list.innerHTML = `<div class="empty-state" role="status"><p>${escapeHtml(failed ? copy.loadFailed : copy.loading)}</p>${failed ? `<button class="achievement-retry" type="button" data-retry>${escapeHtml(copy.retry)}</button>` : ""}</div>`;
    }
    list.scrollTop = scroll;
    const chosen = visible.find((row) => row.id === state.selectedId);
    detail.innerHTML = chosen
      ? renderAchievementDetail(chosen, { locale, timeZone, previewGrade: state.previewGrade })
      : "";
    const grade = detail.querySelector(".detail-panel")?.dataset.badgeGrade;
    const earnedAt = chosen?.earnedAt?.[grade];
    shareSelection =
      earnedAt && !detail.querySelector(".badge.is-locked")
        ? { id: chosen.id, title: achievementCopy(chosen, locale).name, grade, earnedAt, locale, timeZone }
        : null;
    shareButton.disabled = !shareSelection || !onShare;
    fit();
    syncBadge();
    if (
      snapshot?.state === "ready" &&
      chosen &&
      state.category === "近期获得" &&
      state.filter === "all" &&
      !state.query &&
      recentIntent !== shownIntent
    ) {
      const intent = recentIntent;
      const displayed = { profileId: snapshot.profileId, seenThroughRevision: snapshot.awardRevision };
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (
            version !== renderVersion ||
            !dialog.open ||
            document.hidden ||
            intent !== recentIntent ||
            !$(".detail-panel")?.getBoundingClientRect().height
          )
            return;
          shownIntent = intent;
          void Promise.resolve(onRecentShown(displayed)).catch(() => {});
        }),
      );
    }
    if (focus && !focus.isConnected) {
      const key = ["category", "achievement", "previewGrade"].find((key) => focus.dataset[key]);
      const attribute = key === "previewGrade" ? "preview-grade" : key;
      (key ? $(`[data-${attribute}="${focus.dataset[key]}"]`) || $("#achievementTitle") : $("#achievementTitle")).focus(
        { preventScroll: true },
      );
    }
  }

  async function refresh() {
    if (request) return request;
    clearTimeout(preparingRetry);
    request = (async () => {
      try {
        let next;
        if (readSnapshot) next = await readSnapshot();
        else {
          const response = await fetch("/api/achievements", { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          next = await response.json();
        }
        if (achievementRows(next)) snapshot = next;
        else if (!snapshot) snapshot = next;
        onSnapshot(next);
        failed = false;
      } catch {
        failed = true;
      } finally {
        request = null;
        render();
        if (dialog.open && snapshot?.state === "preparing" && !failed) preparingRetry = setTimeout(refresh, 500);
      }
    })();
    return request;
  }

  function open() {
    if (dialog.open) return;
    recentIntent++;
    opener = document.activeElement;
    render();
    dialog.showModal();
    syncBadge();
    button.setAttribute("aria-expanded", "true");
    fit();
    $("#achievementTitle").focus({ preventScroll: true });
    void refresh();
  }
  button.addEventListener("click", open);
  shareButton.addEventListener("click", () => {
    if (shareSelection) void onShare?.({ ...shareSelection, opener: shareButton });
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    removeBadge();
    failedBadgeSource = null;
    clearTimeout(preparingRetry);
    menu(false);
    button.setAttribute("aria-expanded", "false");
    const target = opener?.isConnected && !opener.hidden && opener.getClientRects().length ? opener : button;
    target.focus({ preventScroll: true });
  });
  dialog.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!event.target.closest(".status-picker")) menu(false);
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close();
    }
    if (!target) return;
    if (target.id === "achievementStatusFilter") menu($("#achievementStatusMenu").hidden, true);
    else if (target.dataset.status) {
      state.filter = target.dataset.status;
      if (state.filter === "all") recentIntent++;
      menu(false, true);
      render({ resetScroll: true });
    } else if (target.dataset.category) {
      state.category = target.dataset.category;
      if (state.category === "近期获得") recentIntent++;
      state.previewGrade = null;
      render({ resetScroll: true });
      $(`[data-category="${state.category}"]`).focus({ preventScroll: true });
    } else if (target.dataset.achievement) {
      state.selectedId = target.dataset.achievement;
      state.previewGrade = null;
      render();
      $(`[data-achievement="${state.selectedId}"]`).focus({ preventScroll: true });
    } else if (target.dataset.previewGrade) {
      state.previewGrade = target.dataset.previewGrade;
      render();
      $(`[data-preview-grade="${state.previewGrade}"]`).focus({ preventScroll: true });
    } else if (target.hasAttribute("data-retry")) void refresh();
  });
  $("#achievementSearch").addEventListener("input", (event) => {
    state.query = event.target.value;
    if (!state.query) recentIntent++;
    render({ resetScroll: true });
  });
  $(".status-picker").addEventListener("keydown", (event) => {
    const options = [...dialog.querySelectorAll("[data-status]")];
    const index = options.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const closed = $("#achievementStatusMenu").hidden;
      menu(true);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : closed
              ? options.findIndex((option) => option.dataset.status === state.filter)
              : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[next].focus();
    } else if (event.key === "Escape" && !$("#achievementStatusMenu").hidden) {
      event.preventDefault();
      event.stopPropagation();
      menu(false, true);
    } else if (event.key === "Tab") menu(false);
  });
  document.addEventListener("visibilitychange", syncBadge);
  reducedMotion.addEventListener("change", syncBadge);
  window.addEventListener("pagehide", removeBadge);
  window.addEventListener("pageshow", syncBadge);
  window.addEventListener("resize", fit);
  window.addEventListener("focus", () => {
    if (dialog.open) {
      recentIntent++;
      void refresh();
    }
  });
  render();
  return {
    open,
    openRecent: () => {
      state.category = "近期获得";
      state.filter = "all";
      state.query = "";
      state.selectedId = null;
      state.previewGrade = null;
      $("#achievementSearch").value = "";
      menu(false);
      if (!dialog.open) open();
      else {
        recentIntent++;
        render({ resetScroll: true });
        $("#achievementTitle").focus({ preventScroll: true });
        void refresh();
      }
    },
    acceptSnapshot: (next) => {
      if (achievementRows(next)) {
        snapshot = next;
        render();
      }
    },
    close: () => dialog.close(),
    refresh: () => {
      if (dialog.open) void refresh();
    },
    localize: render,
  };
}
