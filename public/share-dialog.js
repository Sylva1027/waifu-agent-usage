import { createShareCardData, shareCardFilename } from "./share-card-data.js";
import { renderShareCard, SHARE_METRICS } from "./share-card.js";

const $ = (selector) => document.querySelector(selector);
const pickers = ["shareMetricFirst", "shareMetricSecond", "shareMetricThird", "shareMetricFourth"];
const menus = [...pickers, "shareChart", "shareLayout"];
const layouts = [
  { id: "portrait", zh: "竖版", en: "Portrait" },
  { id: "landscape", zh: "横版", en: "Landscape" },
];
const charts = [
  { id: "trend", zh: "趋势", en: "Trend" },
  { id: "harnesses", zh: "Harness", en: "Harness" },
  { id: "composition", zh: "Token 构成", en: "Token composition" },
];
const METRICS_STORAGE_KEY = "codexUsageShareMetrics";
const COST_STORAGE_KEY = "codexUsageShareShowCost";
const LAYOUT_STORAGE_KEY = "codexUsageShareLayout";
const LANDSCAPE_METRICS_STORAGE_KEY = "codexUsageShareLandscapeMetrics";
const CHART_STORAGE_KEY = "codexUsageShareLandscapeChart";
const defaults = { portrait: ["cacheHit", "output"], landscape: ["cached", "output", "input", "cacheHit"] };
const metrics = structuredClone(defaults);
let layout = "portrait";
let chart = "trend";
function selectedMetrics() {
  const available = snapshot.data.availableMetrics;
  const selected = metrics[layout].map((id) => (available.includes(id) ? id : null));
  const replacements = [...new Set([...defaults[layout], ...available])].filter(
    (id) => available.includes(id) && !selected.includes(id),
  );
  return selected.map((id) => id ?? replacements.shift()).filter(Boolean);
}
let initialized = false;
let snapshot;
let showCost = false;
let sequence = 0;
let previewUrl;
let imageBlob;
const t = (zh, en) => (snapshot.locale === "en-US" ? en : zh);

function bindHint(selector) {
  const hint = $(selector);
  let timer;
  return (message = "") => {
    clearTimeout(timer);
    hint.textContent = message;
    hint.hidden = !message;
    if (message)
      timer = setTimeout(() => {
        hint.hidden = true;
      }, 3000);
  };
}

function recordSharedSnapshot(receipt) {
  if (document.documentElement.dataset.edition !== "waifu" || !receipt) return;
  void import("./achievement-events.js")
    .then(({ recordAchievementShare }) => recordAchievementShare(receipt))
    .catch(() => {});
}

function updateMenuFade(menu) {
  menu.style.setProperty("--fade-top", menu.scrollTop > 1 ? "18px" : "0px");
  menu.style.setProperty("--fade-bottom", menu.scrollTop + menu.clientHeight < menu.scrollHeight - 1 ? "18px" : "0px");
}

function setMenu(id, open, focus = false) {
  if (open) for (const other of menus) if (other !== id) setMenu(other, false);
  const menu = $(`#${id}Menu`);
  menu.hidden = !open;
  $(`#${id}`).setAttribute("aria-expanded", String(open));
  if (open) {
    const anchor = $(`#${id}`).getBoundingClientRect();
    const dialog = $("#shareDialog").getBoundingClientRect();
    const above = anchor.top - dialog.top - 23;
    const below = dialog.bottom - anchor.bottom - 23;
    const upwards = above >= Math.min(360, menu.scrollHeight) || above > below;
    menu.style.top = upwards ? "auto" : "calc(100% + 7px)";
    menu.style.bottom = upwards ? "calc(100% + 7px)" : "auto";
    menu.style.maxHeight = `${Math.max(36, Math.min(360, upwards ? above : below))}px`;
  }
  if (focus) (open ? $(`#${id}Menu [aria-selected="true"]`) : $(`#${id}`)).focus();
  if (open) updateMenuFade(menu);
}

function renderControls() {
  menus.forEach((id, index) => {
    const isChart = id === "shareChart";
    const isLayout = id === "shareLayout";
    const selected = selectedMetrics();
    const hidden = isChart ? layout !== "landscape" : !isLayout && index >= selected.length;
    $(`#${id}`).parentElement.hidden = hidden;
    if (hidden) return;
    const definitions = isLayout
      ? layouts
      : isChart
        ? charts
        : SHARE_METRICS.filter((metric) => snapshot.data.availableMetrics.includes(metric.id));
    const value = isLayout ? layout : isChart ? chart : selected[index];
    const metric = definitions.find((option) => option.id === value);
    $(`#${id}Value`).textContent = t(metric.zh, metric.en);
    $(`#${id}Menu`).replaceChildren(
      ...definitions
        .filter((option) => isLayout || isChart || !selected.includes(option.id) || option.id === value)
        .map((metric) => {
          const option = document.createElement("button");
          option.type = "button";
          option.textContent = t(metric.zh, metric.en);
          option.dataset[isLayout ? "shareLayout" : isChart ? "chart" : "metric"] = metric.id;
          option.setAttribute("role", "option");
          option.setAttribute("aria-selected", String(metric.id === value));
          return option;
        }),
    );
  });
  $("#shareShowCost").checked = showCost;
  $("#shareDialog").dataset.layout = layout;
  $(".share-chart-label").hidden = layout !== "landscape";
  const [width, height] = layout === "landscape" ? [1440, 1080] : [1080, 1440];
  $("#shareImage").width = width;
  $("#shareImage").height = height;
}

function setReady(ready) {
  for (const id of ["openShareImage", "copyShareImage", "saveShareImage"]) $(`#${id}`).disabled = !ready;
  $("#shareImage").setAttribute("aria-busy", String(!ready));
}

async function updateImage() {
  const current = ++sequence;
  setReady(false);
  imageBlob = null;
  $("#shareStatus").textContent = "";
  let url;
  try {
    const blob = await renderShareCard({ ...snapshot, layout, chart, metrics: [...selectedMetrics()], showCost });
    url = URL.createObjectURL(blob);
    const probe = new Image();
    probe.src = url;
    await probe.decode();
    if (current !== sequence) {
      URL.revokeObjectURL(url);
      return;
    }
    const previous = previewUrl;
    previewUrl = url;
    $("#shareImage").src = url;
    if (previous) URL.revokeObjectURL(previous);
    imageBlob = blob;
    setReady(true);
  } catch {
    if (url) URL.revokeObjectURL(url);
    if (current === sequence)
      $("#shareStatus").textContent = t("图片加载失败，请重新打开。", "Image could not load. Please reopen.");
  }
}

function trapFocus(event, dialog) {
  const controls = [...dialog.querySelectorAll("button,input,select,a[href],[tabindex]")].filter(
    (control) => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length > 0,
  );
  if (!controls.length) {
    event.preventDefault();
    dialog.focus();
  } else if (
    !controls.includes(document.activeElement) ||
    document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))
  ) {
    event.preventDefault();
    (event.shiftKey ? controls.at(-1) : controls[0]).focus();
  }
}

function bind() {
  const copyHint = bindHint("#shareCopyHint");
  const originalHint = bindHint("#shareOriginalHint");
  try {
    showCost = localStorage.getItem(COST_STORAGE_KEY) === "true";
    if (localStorage.getItem(LAYOUT_STORAGE_KEY) === "landscape") layout = "landscape";
    const savedChart = localStorage.getItem(CHART_STORAGE_KEY);
    if (["trend", "harnesses", "composition"].includes(savedChart)) chart = savedChart;
  } catch {
    /* Use defaults when storage is unavailable. */
  }
  for (const [format, key] of [
    ["portrait", METRICS_STORAGE_KEY],
    ["landscape", LANDSCAPE_METRICS_STORAGE_KEY],
  ]) {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (
        Array.isArray(saved) &&
        saved.length === metrics[format].length &&
        new Set(saved).size === saved.length &&
        saved.every((id) => SHARE_METRICS.some((metric) => metric.id === id))
      )
        metrics[format] = saved;
    } catch {
      /* Keep this format's defaults for an invalid preference. */
    }
  }
  initialized = true;
  menus.forEach((id, index) => {
    const host = $(`#${id}`).parentElement;
    const menu = $(`#${id}Menu`);
    menu.addEventListener("scroll", () => updateMenuFade(menu));
    $(`#${id}`).addEventListener("click", () => setMenu(id, menu.hidden, true));
    menu.addEventListener("click", (event) => {
      const option = event.target.closest('[role="option"]');
      if (!option) return;
      const isChart = id === "shareChart";
      const isLayout = id === "shareLayout";
      if (isLayout) layout = option.dataset.shareLayout;
      else if (isChart) chart = option.dataset.chart;
      else {
        metrics[layout] = selectedMetrics();
        metrics[layout][index] = option.dataset.metric;
      }
      try {
        localStorage.setItem(
          isLayout
            ? LAYOUT_STORAGE_KEY
            : isChart
              ? CHART_STORAGE_KEY
              : layout === "portrait"
                ? METRICS_STORAGE_KEY
                : LANDSCAPE_METRICS_STORAGE_KEY,
          isLayout ? layout : isChart ? chart : JSON.stringify(selectedMetrics()),
        );
      } catch {
        // Storage may be disabled; keep the selection for this page session.
      }
      setMenu(id, false, true);
      renderControls();
      void updateImage();
    });
    host.addEventListener("keydown", (event) => {
      const options = [...menu.querySelectorAll("button")];
      const current = options.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const wasClosed = menu.hidden;
        setMenu(id, true);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : wasClosed
                ? options.findIndex((option) => option.getAttribute("aria-selected") === "true")
                : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next].focus();
      } else if (event.key === "Escape" && !menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        setMenu(id, false, true);
      } else if (event.key === "Tab" && !menu.hidden) setMenu(id, false, true);
    });
  });
  document.addEventListener("click", (event) => {
    for (const id of menus) if (!$(`#${id}`).parentElement.contains(event.target)) setMenu(id, false);
  });
  window.addEventListener("resize", () => {
    for (const id of menus) setMenu(id, false);
  });
  $("#shareShowCost").addEventListener("change", () => {
    showCost = $("#shareShowCost").checked;
    try {
      localStorage.setItem(COST_STORAGE_KEY, String(showCost));
    } catch {
      // Storage may be disabled; keep the preference for this page session.
    }
    void updateImage();
  });
  $("#shareDialog").addEventListener("close", () => {
    ++sequence;
    copyHint();
    imageBlob = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    $("#shareImage").removeAttribute("src");
    for (const id of menus) setMenu(id, false);
    $("#shareToggle").setAttribute("aria-expanded", "false");
    $("#shareToggle").focus({ preventScroll: true });
  });
  $("#openShareImage").addEventListener("click", () => {
    $("#shareOriginalDialog img").src = previewUrl;
    $("#shareOriginalDialog").showModal();
    originalHint(t("按 Esc 退出", "Press Esc to exit"));
  });
  $("#shareOriginalDialog").addEventListener("close", () => {
    originalHint();
    $("#shareOriginalDialog img").removeAttribute("src");
    $("#openShareImage").focus({ preventScroll: true });
  });
  for (const dialog of [$("#shareDialog"), $("#shareOriginalDialog")]) {
    let downOutside = false;
    const outside = (event) => {
      const r = dialog.getBoundingClientRect();
      return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
    };
    dialog.addEventListener("pointerdown", (event) => {
      downOutside = outside(event);
    });
    dialog.addEventListener("click", (event) => {
      if (downOutside && outside(event)) dialog.close();
      downOutside = false;
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Tab") trapFocus(event, dialog);
    });
  }
  $("#saveShareImage").addEventListener("click", () => {
    if (!imageBlob) return;
    const receipt = snapshot.achievementReceipt;
    $("#shareStatus").textContent = "";
    const url = URL.createObjectURL(imageBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = shareCardFilename(snapshot.data.range);
    link.click();
    recordSharedSnapshot(receipt);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  $("#copyShareImage").addEventListener("click", async () => {
    if (!imageBlob) return;
    $("#shareStatus").textContent = "";
    const current = sequence;
    const receipt = snapshot.achievementReceipt;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": imageBlob })]);
      if (current === sequence) copyHint(t("图片已复制", "Image copied"));
      recordSharedSnapshot(receipt);
    } catch {
      if (current === sequence) {
        copyHint();
        $("#shareStatus").textContent = t("暂时无法复制，请保存图片。", "Could not copy. Save the image instead.");
      }
    }
  });
}

export function openShareDialog({
  summary,
  preset,
  recentValue,
  startDate,
  endDate,
  calendarZone,
  currency,
  usdToCnyRate,
  periodComparison,
  pricingModels,
  achievementReceipt,
  ...appearance
}) {
  const data = createShareCardData(summary, {
    preset,
    recentValue,
    startDate,
    endDate,
    calendarZone,
    currency,
    usdToCnyRate,
    periodComparison,
    pricingModels,
  });
  if (!data || $("#shareDialog").open) return;
  if (!initialized) bind();
  snapshot = { ...appearance, data, achievementReceipt };
  for (const [selector, zh, en] of [
    ["#shareTitle", "分享图片", "Share image"],
    [".share-metrics-label", "辅助指标", "Metrics"],
    [".share-chart-label", "图形", "Chart"],
    [".share-layout-label", "版式", "Layout"],
    [".share-cost-toggle span", "显示费用", "Show cost"],
    ["#copyShareImage span", "复制图片", "Copy image"],
    ["#saveShareImage span", "保存图片", "Save image"],
  ])
    $(selector).textContent = t(zh, en);
  for (const [selector, zh, en] of [
    ["#openShareImage", "查看原图", "View full image"],
    ["#shareMetricFirst", "第一个辅助指标", "First metric"],
    ["#shareMetricSecond", "第二个辅助指标", "Second metric"],
    ["#shareMetricThird", "第三个辅助指标", "Third metric"],
    ["#shareMetricFourth", "第四个辅助指标", "Fourth metric"],
    ["#shareMetricFirstMenu", "第一个辅助指标", "First metric"],
    ["#shareMetricSecondMenu", "第二个辅助指标", "Second metric"],
    ["#shareMetricThirdMenu", "第三个辅助指标", "Third metric"],
    ["#shareMetricFourthMenu", "第四个辅助指标", "Fourth metric"],
    ["#shareLayout", "图片方向", "Orientation"],
    ["#shareLayoutMenu", "图片方向", "Orientation"],
    ["#shareChart", "图形", "Chart"],
    ["#shareChartMenu", "图形", "Chart"],
    ["#shareOriginalDialog", "图片原图", "Full image"],
    [".share-customize", "图片内容", "Image content"],
  ])
    $(selector).setAttribute("aria-label", t(zh, en));
  $("#openShareImage").title = t("查看原图", "View full image");
  $(".project-link").title = t("GitHub 项目", "GitHub project");
  $("#shareImage").alt = t("模型用量分享图片", "Model usage card");
  $("#shareOriginalDialog img").alt = $("#shareImage").alt;
  renderControls();
  $("#shareDialog").showModal();
  $("#shareToggle").setAttribute("aria-expanded", "true");
  $("#shareTitle").focus();
  void updateImage();
}
