import { escapeHtml } from "./html-utils.js";
import { localizeText, localizeServerError } from "./locale.js";

export function homeRowsFromMetadata(metadata) {
  // Preserve unsupported stored imports so users can remove or fix them.
  const homes = [...(metadata.homes || [])];
  const seen = new Set(homes.map((home) => home.path));
  for (const entry of metadata.imports || []) {
    if (seen.has(entry.path)) {
      continue;
    }
    homes.push({
      ...entry,
      label: entry.label || entry.path,
      kind: entry.type,
      imported: true,
      status: entry.type === "unsupported" ? "unsupported" : "active",
      eventCount: 0,
      sessionCount: 0,
    });
  }
  return homes;
}
export function renderSourceOptionsHtml(homes, excludedIds = []) {
  // 数据来源多选：取消勾选的来源不计入用量统计。文本与路径转义后渲染。
  const excluded = new Set(excludedIds || []);
  const sources = (homes || []).filter((home) => home.id);
  if (!sources.length) {
    return `<div class="empty">没有可统计的来源</div>`;
  }
  return sources
    .map((home) => {
      const id = escapeHtml(home.id);
      const label = escapeHtml(home.label || home.path || home.id);
      const kind = escapeHtml((home.kind || home.type) === "main" ? "codex" : home.kind || home.type || "");
      const pathText = escapeHtml(home.path || "");
      const isExcluded = excluded.has(home.id);
      const checked = isExcluded ? "" : " checked";
      const excludedBadge = isExcluded ? `<span class="home-excluded">不计入统计</span>` : "";
      return `
        <label class="source-option${isExcluded ? " excluded" : ""}">
          <input type="checkbox" data-source-id="${id}"${checked} />
          <span class="source-option-text">
            <span class="source-option-label"><strong>${label}</strong><span class="home-kind">${kind}</span></span>
            ${excludedBadge ? `<span class="source-option-meta">${excludedBadge}</span>` : ""}
            <span class="source-option-path" title="${pathText}">${pathText}</span>
          </span>
        </label>
      `;
    })
    .join("");
}
export function renderHomesHtml(homes, { canModify = false, excludedIds = [] } = {}) {
  // Render paths and labels as escaped text because they may come from imported logs.
  if (!homes.length) {
    return `<div class="empty">没有发现 Codex、ZCode、DSH、OpenCode、Claude Code 或 WorkBuddy 目录</div>`;
  }
  const excluded = new Set(excludedIds || []);
  return homes
    .map((home) => {
      const label = escapeHtml(home.label);
      const kind = escapeHtml((home.kind || home.type) === "main" ? "codex" : home.kind || home.type || "");
      const pathText = escapeHtml(home.path);
      const reason = home.reason ? `<div class="home-reason">${escapeHtml(home.reason)}</div>` : "";
      const removeButton =
        canModify && home.imported
          ? `<button class="home-remove" type="button" data-import-action="remove" data-import-path="${pathText}" aria-label="移除 ${label}">移除</button>`
          : "";
      const isExcluded = Boolean(home.id) && excluded.has(home.id);
      const excludedBadge = isExcluded ? `<span class="home-excluded">不计入统计</span>` : "";
      return `
        <div class="home-row${isExcluded ? " excluded" : ""}">
          <div class="home-label">
            <strong>${label}</strong>
            <span class="home-kind">${kind}</span>
          </div>
          ${excludedBadge || removeButton ? `<div class="home-meta">${excludedBadge}${removeButton}</div>` : ""}
          <div class="home-path" title="${pathText}">${pathText}</div>
          ${reason}
        </div>
      `;
    })
    .join("");
}
/** @param {any} context */
export function createSourceManager(context) {
  const fetch = context.fetch || globalThis.fetch.bind(globalThis);
  const {
    state,
    beginRuntimeTask,
    updateRuntimeTask,
    runtimeRequestHeaders,
    finishRuntimeTask,
    loadUsage,
    currentMetadata,
    reconcileQuotaSourceSelection,
  } = context;
  const $ = (selector) => document.querySelector(selector);

  let importDialogOpener = null;
  const importView = {
    scan: 0,
    controller: null,
    picker: null,
    scanning: false,
    submitting: false,
    task: null,
    timer: null,
    poll: false,
    complete: null,
    activity: null,
  };
  const EXCLUDED_HOMES_STORAGE_KEY = "codexUsageExcludedHomes";

  function renderHomes(homes, options = {}) {
    const container = $("#homeList");
    container.innerHTML = renderHomesHtml(homes, options);
  }

  async function pickImportDirectory() {
    const sequence = importView.scan;
    const controller = new AbortController();
    importView.picker = controller;
    const pickButton = $("#pickImportDirectoryButton");
    pickButton.disabled = true;
    setImportMessage("正在打开文件夹选择器...");
    try {
      const response = await fetch("/api/pick-directory", { method: "POST", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(localizeServerError(data, response.status));
      }
      if (sequence !== importView.scan || $("#importDialog").hidden || importBusy()) return;
      if (data.path) {
        $("#importPath").value = data.path;
        updateImportButton();
        setImportMessage("已选择目录，可继续导入。");
      } else {
        setImportMessage("没有选择目录。");
      }
    } catch (error) {
      if (sequence !== importView.scan || controller.signal.aborted) return;
      setImportMessage(`选择失败：${error.message}，也可以手动输入路径。`, true);
    } finally {
      if (importView.picker === controller) importView.picker = null;
      pickButton.disabled = importBusy();
    }
  }

  function setImportMessage(message, isError = false) {
    const element = $("#importMessage");
    element.textContent = message;
    element.classList.toggle("error", isError);
  }

  function readExcludedHomes() {
    try {
      const saved = JSON.parse(localStorage.getItem(EXCLUDED_HOMES_STORAGE_KEY) || "[]");
      if (Array.isArray(saved)) {
        return saved.filter((id) => typeof id === "string" && id);
      }
    } catch {
      // Ignore storage failures in restricted contexts.
    }
    return [];
  }

  function saveExcludedHomes() {
    try {
      localStorage.setItem(EXCLUDED_HOMES_STORAGE_KEY, JSON.stringify(state.excludedHomes));
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }

  function importBusy() {
    return importView.submitting || ["running", "ready", "published"].includes(importView.task?.status);
  }

  function selectedImportPaths() {
    const selected = [...document.querySelectorAll("#importCandidates input:checked")].map((input) => input.value);
    const manual = $("#manualImportArea").hidden ? "" : $("#importPath").value.trim();
    return [...new Set([...selected, ...(manual ? [manual] : [])])];
  }

  function updateImportButton() {
    const busy = importBusy();
    const count = selectedImportPaths().length;
    $("#submitImportButton").disabled = busy || importView.scanning || !count;
    $("#submitImportButton").textContent = localizeText(count ? `导入所选（${count}）` : "导入所选");
    for (const control of document.querySelectorAll(
      "#importCandidates input, #importPath, #pickImportDirectoryButton, #manualImportButton, #rescanImportsButton",
    ))
      control.disabled = busy;
    $("#rescanImportsButton").disabled = busy || importView.scanning;
    $("#manualImportButton").disabled = busy || importView.scanning;
  }

  function showManualImport(show) {
    $("#manualImportArea").hidden = !show;
    $("#manualImportButton").setAttribute("aria-expanded", String(show));
    updateImportButton();
  }

  function renderImportHelp(data) {
    const windows = data.platform === "win32";
    const mac = data.platform === "darwin";
    $("#importHelp").textContent = localizeText(
      windows
        ? "在文件资源管理器地址栏输入下列位置；选择软件的记录目录，不要选择单个记录文件。"
        : mac
          ? "在 Finder 按 Command＋Shift＋G，输入下列位置；Command＋Shift＋. 可显示隐藏文件夹。"
          : "在文件管理器中打开下列位置，显示隐藏文件夹后选择记录目录。",
    );
    const root = windows ? "%USERPROFILE%" : "~";
    const separator = windows ? "\\" : "/";
    const locations = [
      ["Codex", ".codex"],
      ["Claude Code", ".claude"],
      ["DSH", ".dsh"],
      ["ZCode", ".zcode"],
      ["WorkBuddy", ".workbuddy-ai"],
      ["OpenCode", ".local/share/opencode"],
      ["Hermes", windows ? "hermes" : ".hermes", windows ? "%LOCALAPPDATA%" : root],
    ];
    $("#importLocations").innerHTML = locations
      .map(
        ([name, directory, directoryRoot = root]) =>
          `<li>${name} · <code>${escapeHtml(directoryRoot + separator + directory.replaceAll("/", separator))}</code></li>`,
      )
      .join("");
    $("#importPath").placeholder = windows ? "%USERPROFILE%\\.codex" : "~/.codex";
  }

  async function scanImportDirectories() {
    const sequence = ++importView.scan;
    importView.controller?.abort();
    importView.picker?.abort();
    const controller = new AbortController();
    importView.controller = controller;
    importView.scanning = true;
    $("#importCandidatesField").hidden = true;
    $("#importCandidates").innerHTML = "";
    $("#importDiagnostics").hidden = true;
    showManualImport(false);
    setImportMessage("正在查找本机记录…");
    updateImportButton();
    try {
      const response = await fetch("/api/imports/discover", { signal: controller.signal });
      const data = await response.json();
      if (sequence !== importView.scan || $("#importDialog").hidden) return;
      if (!response.ok) throw new Error(localizeServerError(data, response.status));
      renderImportHelp(data);
      const candidates = data.candidates.filter((source) => !source.confirmed);
      $("#importCandidatesField").hidden = !candidates.length;
      $("#importCandidates").innerHTML = candidates
        .map(
          (source) =>
            `<label class="source-option"><input type="checkbox" value="${escapeHtml(source.path)}" checked /><span class="source-option-text"><span class="source-option-label"><strong>${escapeHtml(source.label)}</strong></span><span class="source-option-path" title="${escapeHtml(source.path)}">${escapeHtml(source.path)}</span></span></label>`,
        )
        .join("");
      const errors = data.errors || [];
      $("#importDiagnostics").hidden = !errors.length;
      $("#importDiagnosticsText").textContent = errors
        .map((error) => `${error.path}: ${localizeServerError(error)}`)
        .join("\n");
      showManualImport(!data.candidates.length);
      setImportMessage(
        candidates.length
          ? errors.length
            ? "已找到记录，部分位置无法访问。"
            : "选择需要导入的记录目录。"
          : data.candidates.length
            ? "没有发现新的记录目录。"
            : errors.length
              ? "部分位置无法访问，请选择记录目录。"
              : "未找到记录目录，请选择记录所在位置。",
        !data.candidates.length && errors.length > 0,
      );
    } catch (error) {
      if (sequence !== importView.scan || error.name === "AbortError") return;
      showManualImport(true);
      setImportMessage(`扫描失败：${error.message}`, true);
    } finally {
      if (sequence === importView.scan) {
        importView.scanning = false;
        updateImportButton();
      }
    }
  }

  function renderImportProgress() {
    const task = importView.task;
    if (!task || importView.complete === task.id) return;
    const labels = {
      reading: "正在读取记录…",
      statistics: "正在计算统计…",
      settling: "正在校验记录…",
      dashboard: "正在更新看板…",
    };
    const seconds = Math.max(0, Math.floor(((task.finishedAt || Date.now()) - task.startedAt) / 1000));
    const message = localizeText(labels[task.stage] || "正在导入记录…");
    if (!importView.activity) importView.activity = beginRuntimeTask("import", { priority: 2 });
    updateRuntimeTask(importView.activity, task.stage || "import");
    const node = $("#importMessage");
    if (node.firstChild?.textContent !== message || !node.lastElementChild) {
      setImportMessage(message);
      const elapsed = document.createElement("span");
      elapsed.setAttribute("aria-hidden", "true");
      node.append(elapsed);
    }
    node.lastElementChild.textContent = ` · ${localizeText(`已用 ${seconds} 秒`)}`;
  }

  async function pollImportTask(restore = false) {
    if (importView.poll) return;
    importView.poll = true;
    try {
      const response = await fetch(
        "/api/imports",
        importView.activity ? { headers: runtimeRequestHeaders(importView.activity) } : undefined,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(localizeServerError(data, response.status));
      const task = data.importTask;
      if (!task || importView.complete === task.id) return;
      if (task.status === "published" && !importView.task) return;
      importView.task = task;
      updateImportButton();
      if (task.status === "failed") throw new Error(localizeServerError({ ...task.error, error: task.error?.message }));
      renderImportProgress();
      if (!importView.timer)
        importView.timer = window.setInterval(() => {
          renderImportProgress();
          void pollImportTask();
        }, 1000);
      if (["ready", "published"].includes(task.status)) {
        if (!state.autoRefreshEnabled && !importView.activity?.user) {
          importView.complete = task.id;
          window.clearInterval(importView.timer);
          importView.timer = null;
          importView.task = null;
          finishRuntimeTask(importView.activity);
          importView.activity = null;
          return;
        }
        state.snapshotId = null;
        updateRuntimeTask(importView.activity, "statistics");
        const result = await loadUsage({
          live: true,
          requiredSourceVersion: task.sourceVersion,
          activity: importView.activity,
          confirmSync: true,
        });
        if (!result) return;
        importView.complete = task.id;
        window.clearInterval(importView.timer);
        importView.timer = null;
        importView.task = null;
        $("#importCandidatesField").hidden = true;
        $("#importCandidates").innerHTML = "";
        $("#importPath").value = "";
        renderSourceOptions();
        const hasRecords = result.metadata.homes.some(
          (home) => task.sourceIds.includes(home.id) && home.eventCount > 0,
        );
        const message = hasRecords ? `已导入 ${task.count} 个来源。` : "该目录暂无可统计记录。";
        setImportMessage(message);
        finishRuntimeTask(importView.activity);
        importView.activity = null;
        if (task.warnings?.length) {
          $("#importDiagnostics").hidden = false;
          $("#importDiagnosticsText").textContent = task.warnings.join("\n");
        }
      }
    } catch (error) {
      if (restore && !importView.task) return;
      window.clearInterval(importView.timer);
      importView.timer = null;
      if (importView.task) importView.task.status = "failed";
      setImportMessage(`导入失败：${error.message}`, true);
      if (!importView.activity) importView.activity = beginRuntimeTask("import", { priority: 2 });
      finishRuntimeTask(importView.activity, new Error(`导入失败：${error.message}`));
      importView.activity = null;
    } finally {
      importView.poll = false;
      updateImportButton();
    }
  }

  function openImportDialog() {
    const dialog = $("#importDialog");
    importDialogOpener = document.activeElement;
    dialog.hidden = false;
    renderSourceOptions();
    renderImportHelp({
      platform: navigator.platform.startsWith("Win")
        ? "win32"
        : navigator.platform.startsWith("Mac")
          ? "darwin"
          : "linux",
    });
    if (importBusy()) renderImportProgress();
    else void scanImportDirectories();
    void pollImportTask();
    $("#importDialogTitle").focus({ preventScroll: true });
  }

  function renderSourceOptions() {
    const container = $("#sourcePicker");
    if (!container) {
      return;
    }
    container.innerHTML = renderSourceOptionsHtml(homeRowsFromMetadata(currentMetadata() || {}), state.excludedHomes);
  }

  function setSourceOption(id, checked) {
    const excluded = new Set(state.excludedHomes);
    if (checked) {
      excluded.delete(id);
    } else {
      excluded.add(id);
    }
    state.excludedHomes = [...excluded];
    saveExcludedHomes();
    reconcileQuotaSourceSelection();
    // 勾选变化立即生效：跳过同步直接按新筛选刷新汇总。
    void loadUsage({ skipCheck: true });
  }

  function closeImportDialog() {
    importView.scan++;
    importView.controller?.abort();
    importView.picker?.abort();
    importView.scanning = false;
    $("#importDialog").hidden = true;
    setImportMessage("");
    importDialogOpener?.focus({ preventScroll: true });
    importDialogOpener = null;
  }

  function trapDialogFocus(event, dialog) {
    const controls = [...dialog.querySelectorAll("button, input, select, textarea, a[href], [tabindex]")].filter(
      (control) => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length > 0,
    );
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!controls.includes(document.activeElement) || document.activeElement === (event.shiftKey ? first : last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  async function submitImportDirectory(event) {
    event.preventDefault();
    const paths = selectedImportPaths();
    if (importBusy() || !paths.length) return;
    importView.submitting = true;
    importView.activity = beginRuntimeTask("import", { user: true });
    updateImportButton();
    setImportMessage("正在识别目录...");
    try {
      const response = await fetch("/api/imports", {
        method: "POST",
        headers: { "content-type": "application/json", ...runtimeRequestHeaders(importView.activity) },
        body: JSON.stringify({ paths }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(`${localizeServerError(data, response.status)}${data.path ? ` · ${data.path}` : ""}`);
      importView.task = data.importTask;
      renderImportProgress();
      void pollImportTask();
    } catch (error) {
      finishRuntimeTask(importView.activity, new Error(`导入失败：${error.message}`));
      importView.activity = null;
      setImportMessage(`导入失败：${error.message}`, true);
    } finally {
      importView.submitting = false;
      updateImportButton();
    }
  }

  async function removeImportDirectory(importPath) {
    const activity = beginRuntimeTask("remove", { user: true });
    try {
      const response = await fetch(`/api/imports?path=${encodeURIComponent(importPath)}`, {
        method: "DELETE",
        headers: runtimeRequestHeaders(activity),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(localizeServerError(data, response.status));
      state.snapshotId = null;
      updateRuntimeTask(activity, "statistics");
      await loadUsage({ activity, confirmSync: true });
    } catch (error) {
      finishRuntimeTask(activity, new Error(`移除失败：${error.message}`));
      throw error;
    } finally {
      finishRuntimeTask(activity);
    }
  }
  return {
    view: importView,
    renderHomes,
    pickImportDirectory,
    setImportMessage,
    readExcludedHomes,
    saveExcludedHomes,
    importBusy,
    selectedImportPaths,
    updateImportButton,
    showManualImport,
    renderImportHelp,
    scanImportDirectories,
    renderImportProgress,
    pollImportTask,
    openImportDialog,
    renderSourceOptions,
    setSourceOption,
    closeImportDialog,
    trapDialogFocus,
    submitImportDirectory,
    removeImportDirectory,
  };
}
