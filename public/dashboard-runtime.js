import { getLocale, localizeText, localizeServerError } from "./locale.js";

export function formatAutoRefreshTimestamp(value, locale = "zh-CN", _calendarZone = "local", now = Date.now()) {
  if (value === null || value === undefined || value === "") return localizeText("上次：尚无", locale);
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return localizeText("上次：尚无", locale);
  const elapsed = Math.max(0, new Date(now).getTime() - date.getTime());
  return localizeText(
    elapsed < 60_000
      ? "上次：刚刚"
      : elapsed < 3_600_000
        ? `上次：${Math.floor(elapsed / 60_000)}分钟前`
        : elapsed < 86_400_000
          ? `上次：${Math.floor(elapsed / 3_600_000)}小时前`
          : "上次：大于1天",
    locale,
  );
}

export function createDashboardRuntime(context, hooks = {}) {
  const { state } = context;
  const document = context.document ?? globalThis.document;
  const window = context.window ?? globalThis.window;
  const fetch = context.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = context.storage ?? globalThis.localStorage;
  const clockNow = context.now ?? (() => Date.now());
  const AUTO_REFRESH_INTERVAL_MS = context.intervalMs ?? 60_000;
  const AUTO_REFRESH_STORAGE_KEY = context.storageKey ?? "codexUsageAutoRefresh";
  const $ = (selector) => document.querySelector(selector);
  const requestUsage = (...args) => (context.loadUsage ?? loadUsage)(...args);
  const requestCheck = (...args) => (context.checkForUpdates ?? checkForUpdates)(...args);
  const buildUsageQuery = (...args) => (context.usageQuery ?? usageQuery)(...args);
  const receiveSnapshot = (...args) => (context.receiveRuntimeSnapshot ?? receiveRuntimeSnapshot)(...args);
  const publishStatus = (...args) => (context.setAutoRefreshStatus ?? setAutoRefreshStatus)(...args);
  let disposed = false;
  let streamCleanup = null;
  const pendingPaints = new Set();

  function setAutoRefreshErrorDetails(open) {
    const trigger = $("#autoRefreshError");
    const details = $("#autoRefreshErrorDetails");
    const hadFocus = details.contains(document.activeElement);
    details.hidden = !open;
    $(".auto-refresh-well").classList.toggle("is-showing-error", open);
    trigger.setAttribute("aria-expanded", String(open));
    if (open) $("#autoRefreshErrorText").focus({ preventScroll: true });
    else if (hadFocus) (trigger.disabled ? $("#autoRefreshToggle") : trigger).focus({ preventScroll: true });
  }

  function setAutoRefreshStatus(message, { error = false, busy = false } = {}) {
    const node = document.querySelector("#autoRefreshError");
    if (!node) return;
    const text = message || "";
    const status = $("#runtimeStatusText");
    if (status) {
      status.textContent = error ? "" : localizeText(text, getLocale());
      status.title = error ? "" : localizeText(text, getLocale());
      status.hidden = error;
    }
    node.textContent = error && text ? localizeText("更新失败 · 详情 ›", getLocale()) : "";
    node.hidden = !error;
    node.disabled = !error;
    const details = $("#autoRefreshErrorText");
    details.dataset.message = text;
    details.value = localizeText(text, getLocale());
    if (!error || !text) setAutoRefreshErrorDetails(false);
    node.classList.toggle("is-error", error);
    setRuntimeSpinner(busy);
  }

  function setRuntimeSpinner(busy) {
    const spinner = document.querySelector("#autoRefreshSpinner");
    if (spinner) {
      spinner.classList.toggle("is-loading", busy);
      spinner.setAttribute("aria-hidden", "true");
    }
  }

  const runtimePageId =
    globalThis.crypto?.randomUUID?.() || `${clockNow().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let runtimeSequence = 0;
  let runtimeDisplay = null;
  let runtimeDisplayTimer = null;
  let runtimeRenderedKey = null;
  let runtimeBackground = null;
  let runtimeBackgroundTimer = null;
  const dismissedRuntimeErrors = new Set();
  let currentUsageTask = null;
  const RUNTIME_PHASES = {
    loading: "正在加载数据…",
    queued: "等待处理…",
    checking: "正在检查更新…",
    check: "正在检查更新…",
    sync: "正在读取记录…",
    syncing: "正在同步数据…",
    reading: "正在读取记录…",
    statistics: "正在计算统计…",
    settling: "正在校验记录…",
    dashboard: "正在更新看板…",
    "source-pending": "等待记录更新…",
    import: "正在导入记录…",
    remove: "正在移除来源…",
  };
  const RUNTIME_PHASE_ORDER = ["queued", "checking", "reading", "statistics", "settling", "dashboard"];

  function beginRuntimeTask(kind, { user = false, phase = kind, priority = user ? 0 : 1, labels } = {}) {
    const sequence = ++runtimeSequence;
    const id = `${runtimePageId}:${sequence}`;
    const task = { id, requestId: id, kind, phase, priority, sequence, user, ...(labels ? { labels } : {}) };
    state.runtimeErrors = state.runtimeErrors.filter((error) => error.kind !== kind);
    for (const error of state.runtimeRemoteErrors) if (error.kind === kind) dismissedRuntimeErrors.add(error.id);
    state.runtimeTasks.push(task);
    if (user) runtimeDisplay = null;
    renderRuntimeStatus();
    return task;
  }

  function updateRuntimeTask(task, phase) {
    if (!state.runtimeTasks.includes(task)) return;
    task.phase = phase;
    renderRuntimeStatus();
  }

  function finishRuntimeTask(task, error = null) {
    if (!task || !state.runtimeTasks.includes(task)) return;
    state.runtimeTasks = state.runtimeTasks.filter((item) => item !== task);
    if (currentUsageTask === task) currentUsageTask = null;
    if (error) state.runtimeErrors.push({ ...task, message: error.message || String(error) });
    renderRuntimeStatus(runtimeDisplay?.id === task.id || Boolean(error));
  }

  function runtimeNotice(message, kind = "statistics") {
    const task = beginRuntimeTask(kind, { user: true });
    finishRuntimeTask(task, new Error(message));
  }

  function runtimeRequestHeaders(task) {
    return { "X-Usage-Request-Id": task.requestId };
  }

  function writeRuntimeStatus(message, { error = false, busy = false } = {}) {
    setRuntimeSpinner(busy);
    const key = JSON.stringify([message, error, getLocale()]);
    if (key === runtimeRenderedKey) return;
    runtimeRenderedKey = key;
    publishStatus(message, { error, busy });
  }

  function runtimeCandidates() {
    const relevant = state.runtimeRemoteTasks.filter(
      (task) =>
        (task.shared && state.autoRefreshEnabled) ||
        state.runtimeTasks.some((local) => local.requestId === task.requestId),
    );
    const mostSpecific = (tasks) =>
      tasks.reduce(
        (chosen, task) =>
          !chosen ||
          (task.state !== "queued" && chosen.state === "queued") ||
          (task.state === chosen.state &&
            RUNTIME_PHASE_ORDER.indexOf(task.phase) >= RUNTIME_PHASE_ORDER.indexOf(chosen.phase))
            ? task
            : chosen,
        null,
      );
    const tasks = state.runtimeTasks.map((task) => {
      const remote = mostSpecific(relevant.filter((item) => !item.shared && item.requestId === task.requestId));
      const phase =
        task.phase === "dashboard" || task.phase === "source-pending"
          ? task.phase
          : task.disconnected
            ? "queued"
            : remote
              ? remote.state === "queued"
                ? "queued"
                : remote.phase
              : task.phase;
      return {
        ...task,
        phase:
          task.user && task.kind === "statistics" && !["dashboard", "source-pending"].includes(phase)
            ? "statistics"
            : phase,
        background: !task.user && ["check", "statistics"].includes(task.kind) && task.phase !== "loading",
      };
    });
    for (const kind of new Set(relevant.filter((task) => task.shared).map((task) => task.kind))) {
      const remote = mostSpecific(relevant.filter((task) => task.shared && task.kind === kind));
      tasks.push({
        ...remote,
        id: `shared:${kind}`,
        priority: remote.priority ?? 2,
        sequence: 0,
        background: ["sync", "check"].includes(kind),
        phase:
          remote.id === "source-pending" ||
          (kind === "sync" && remote.phase === "settling" && remote.state === "queued")
            ? "source-pending"
            : remote.state === "queued"
              ? "queued"
              : remote.phase,
      });
    }
    return tasks;
  }

  function renderRuntimeStatus(immediate = false) {
    if (disposed || !document) return;
    const candidates = runtimeCandidates();
    const background = candidates.filter((task) => task.background && state.autoRefreshEnabled);
    const tasks = candidates.filter((task) => !task.background);
    if (runtimeBackgroundTimer !== null) window.clearTimeout(runtimeBackgroundTimer);
    runtimeBackgroundTimer = null;
    if (background.length) {
      runtimeBackground ||= { since: clockNow(), phase: "checking" };
      if (background.some((task) => !["checking", "queued"].includes(task.phase))) runtimeBackground.phase = "syncing";
      // A known new dashboard version is work for this page; watcher probes may be no-ops.
      const remaining = background.some((task) => !task.shared && task.kind === "statistics")
        ? 0
        : 1000 - (clockNow() - runtimeBackground.since);
      if (remaining > 0) {
        runtimeBackgroundTimer = window.setTimeout(() => {
          runtimeBackgroundTimer = null;
          renderRuntimeStatus();
        }, remaining);
      } else {
        tasks.push({ id: "background-sync", kind: "sync", phase: runtimeBackground.phase, priority: 2, sequence: 0 });
      }
    } else {
      runtimeBackground = null;
    }
    const bestPriority = Math.min(...tasks.map((task) => task.priority));
    const task =
      tasks.find((item) => item.priority === bestPriority && item.id === runtimeDisplay?.id) ||
      tasks.filter((item) => item.priority === bestPriority).sort((a, b) => b.sequence - a.sequence)[0];
    const errors = [
      ...state.runtimeErrors,
      ...state.runtimeRemoteErrors
        .filter(
          (error) =>
            !dismissedRuntimeErrors.has(error.id) &&
            ((error.shared && state.autoRefreshEnabled) ||
              state.runtimeTasks.some((local) => local.requestId === error.requestId)),
        )
        .map((error) => {
          const local = state.runtimeTasks.find((task) => task.requestId === error.requestId);
          return {
            ...error,
            priority: local?.priority ?? error.priority ?? 2,
            sequence: local?.sequence ?? 0,
          };
        }),
    ];
    const error = errors.sort((a, b) => a.priority - b.priority || b.sequence - a.sequence)[0];
    if (runtimeDisplayTimer !== null) window.clearTimeout(runtimeDisplayTimer);
    runtimeDisplayTimer = null;
    if (
      error &&
      (!task || error.priority < task.priority || (error.priority === task.priority && error.sequence >= task.sequence))
    ) {
      runtimeDisplay = null;
      writeRuntimeStatus(error.message, { error: true, busy: tasks.length > 0 });
      return;
    }
    const message = task
      ? RUNTIME_PHASES[task.phase] ||
        task.labels?.[task.phase] ||
        RUNTIME_PHASES[task.kind] ||
        task.labels?.[task.kind] ||
        "正在加载数据…"
      : state.autoRefreshEnabled
        ? "就绪"
        : "自动刷新已暂停";
    const now = clockNow();
    const remaining = runtimeDisplay && task?.id === runtimeDisplay.id ? 1000 - (now - runtimeDisplay.at) : 0;
    if (task && !immediate && remaining > 0 && message !== runtimeDisplay.message) {
      runtimeDisplayTimer = window.setTimeout(() => {
        runtimeDisplayTimer = null;
        renderRuntimeStatus(true);
      }, remaining);
      writeRuntimeStatus(runtimeDisplay.message, { busy: true });
      return;
    }
    if (!runtimeDisplay || runtimeDisplay.id !== task?.id || runtimeDisplay.message !== message)
      runtimeDisplay = { id: task?.id, message, at: now };
    writeRuntimeStatus(message, { busy: tasks.length > 0 });
  }

  function receiveRuntimeSnapshot(snapshot, reset = false) {
    if (
      !snapshot ||
      typeof snapshot.epoch !== "string" ||
      !Number.isSafeInteger(snapshot.revision) ||
      !Array.isArray(snapshot.tasks) ||
      !Array.isArray(snapshot.errors)
    )
      return;
    if (!reset && state.runtimeEpoch === snapshot.epoch && snapshot.revision <= state.runtimeRevision) return;
    state.runtimeEpoch = snapshot.epoch;
    state.runtimeRevision = snapshot.revision;
    state.runtimeRemoteTasks = snapshot.tasks.filter(
      (task) => task && typeof task.id === "string" && ["queued", "running"].includes(task.state),
    );
    state.runtimeRemoteErrors = snapshot.errors.filter(
      (error) => error && typeof error.id === "string" && typeof error.message === "string",
    );
    const errorIds = new Set(state.runtimeRemoteErrors.map((error) => error.id));
    for (const id of dismissedRuntimeErrors) if (!errorIds.has(id)) dismissedRuntimeErrors.delete(id);
    for (const task of state.runtimeTasks) task.disconnected = false;
    renderRuntimeStatus();
  }

  function readAutoRefreshPreference() {
    try {
      return storage.getItem(AUTO_REFRESH_STORAGE_KEY) !== "off";
    } catch {
      return true;
    }
  }

  function persistAutoRefreshPreference(enabled) {
    try {
      storage.setItem(AUTO_REFRESH_STORAGE_KEY, enabled ? "on" : "off");
    } catch {
      // The current page still honors the choice when storage is unavailable.
    }
  }

  function renderAutoRefreshControls() {
    const button = document.querySelector("#autoRefreshToggle");
    if (!button) return;
    button.textContent = localizeText("自动刷新", getLocale());
    button.setAttribute("aria-pressed", String(state.autoRefreshEnabled));
    button.classList.toggle("is-paused", !state.autoRefreshEnabled);
    button.title = localizeText("切换自动刷新", getLocale());
    renderRelativeCheckTime();
    renderRuntimeStatus();
  }

  function renderRelativeCheckTime() {
    const node = $("#lastSuccessfulCheck");
    if (node)
      node.textContent = formatAutoRefreshTimestamp(
        state.lastSuccessfulCheck,
        getLocale(),
        "local",
        state.now ?? clockNow(),
      );
  }

  function setAutoRefreshEnabled(enabled, { persist = true, checkNow = true } = {}) {
    state.autoRefreshEnabled = Boolean(enabled);
    state.autoRefreshRunId += 1;
    state.autoRefreshCheckInFlight = false;
    state.usageLoadId += 1;
    if (persist) persistAutoRefreshPreference(state.autoRefreshEnabled);
    if (state.autoRefreshEnabled) {
      state.snapshotId = null;
      startAutoRefresh();
      if (checkNow) void requestUsage();
    } else {
      stopAutoRefresh();
      startUsageEventsStream();
      void requestUsage({ skipCheck: true, freeze: true });
    }
    renderAutoRefreshControls();
  }

  function initializeAutoRefresh() {
    if (disposed) return;
    state.autoRefreshEnabled = readAutoRefreshPreference();
    if (!state.relativeTimeTimer)
      state.relativeTimeTimer = window.setInterval(renderRelativeCheckTime, AUTO_REFRESH_INTERVAL_MS);
    startUsageEventsStream();
    renderAutoRefreshControls();
  }

  function usageQuery({ skipCheck = false, freeze = false } = {}) {
    const params = new URLSearchParams({
      preset: state.preset,
      bucket: state.bucket,

      view: "dashboard",
    });
    if (state.preset === "custom") {
      if (state.startDate) {
        params.set("startDate", state.startDate);
      }
      if (state.endDate) {
        params.set("endDate", state.endDate);
      }
    }
    if (state.preset === "recent" && state.recentValue) {
      params.set("recentValue", state.recentValue);
    }
    if (state.excludedHomes.length) {
      params.set("exclude", state.excludedHomes.join(","));
    }

    if (skipCheck) {
      params.set("skipCheck", "1");
    }
    if (freeze) {
      params.set("freeze", "1");
    } else if (!state.autoRefreshEnabled && state.snapshotId) {
      params.set("snapshot", state.snapshotId);
    }
    return `?${params.toString()}`;
  }

  let activeUsageLoadId = null;
  let activeUsageLoadDone = Promise.resolve();
  let completeUsageLoad = () => {};
  let appliedUsageVersion = null;
  let appliedUsageScope = null;
  let usageSyncPending = null;
  let usageReconnectPending = null;
  let cancelUsageRetry = null;

  function reloadSyncedUsage(version = null, { skipCheck = true, confirmation = null } = {}) {
    if (disposed || !state.autoRefreshEnabled || state.snapshotId) return;
    version = typeof version === "string" && version ? version : null;
    if (activeUsageLoadId === state.usageLoadId) {
      usageSyncPending = {
        version: usageSyncPending?.version === null ? null : version,
        skipCheck: skipCheck && (usageSyncPending?.skipCheck ?? true),
        confirmation: confirmation || usageSyncPending?.confirmation || null,
      };
      return activeUsageLoadDone;
    }
    if (version && version === appliedUsageVersion && appliedUsageScope === buildUsageQuery()) {
      if (currentUsageTask?.phase === "source-pending") finishRuntimeTask(currentUsageTask);
      if (confirmation && !currentUsageTask) commitSuccessfulCheck(confirmation.checkedAt);
      return;
    }
    void requestUsage({ skipCheck, preserveView: true, confirmation });
    return activeUsageLoadDone;
  }

  function finishUsageLoad(loadId) {
    if (activeUsageLoadId !== loadId) return;
    activeUsageLoadId = null;
    const complete = completeUsageLoad;
    const pending = usageSyncPending;
    usageSyncPending = null;
    complete(pending ? reloadSyncedUsage(pending.version, pending) : undefined);
  }

  function commitSuccessfulCheck(value) {
    if (!value || !Number.isFinite(new Date(value).getTime())) return;
    state.lastSuccessfulCheck = value;
    renderRelativeCheckTime();
  }

  function afterUsagePaint() {
    if (disposed || document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      let frame;
      const finish = () => {
        window.cancelAnimationFrame(frame);
        document.removeEventListener("visibilitychange", hidden);
        pendingPaints.delete(finish);
        resolve();
      };
      const hidden = () => {
        if (document.hidden) finish();
      };
      pendingPaints.add(finish);
      document.addEventListener("visibilitychange", hidden);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(finish);
      });
    });
  }

  async function loadUsage({
    skipCheck = false,
    freeze = false,
    live = false,
    requiredSourceVersion = null,
    preserveView = false,
    background = false,
    activity = null,
    confirmation = null,
    confirmSync = preserveView,
  } = {}) {
    if (disposed) return;
    const previousTask = currentUsageTask;
    const task =
      activity ||
      beginRuntimeTask("statistics", {
        user: !background && !preserveView && Boolean(state.metadata),
        phase: state.metadata ? "statistics" : "loading",
      });
    currentUsageTask = task;
    if (previousTask !== task) finishRuntimeTask(previousTask);
    let waiting = false;
    let taskError = null;
    const initializeTime = !state.lastSuccessfulCheck;
    const checkSources = !skipCheck && state.autoRefreshEnabled && !freeze && !state.snapshotId;
    hooks.onLoadStart?.({ preserveView });
    cancelUsageRetry?.();
    const loadId = ++state.usageLoadId;
    activeUsageLoadId = loadId;
    // Completion follows the rendered usage and any queued wake, independently of optional follow-up work.
    const previousComplete = completeUsageLoad;
    activeUsageLoadDone = new Promise((resolve) => {
      completeUsageLoad = resolve;
    });
    previousComplete(activeUsageLoadDone);
    const scope = buildUsageQuery();

    try {
      let data;
      let pendingAttempts = 0;
      while (true) {
        const response = await fetch(
          `/api/usage${buildUsageQuery({ skipCheck, freeze: !live && (freeze || (!state.autoRefreshEnabled && !state.snapshotId)) })}`,
          { headers: runtimeRequestHeaders(task) },
        );
        data = await response.json().catch(() => null);
        if (loadId !== state.usageLoadId) return;
        if (response.status === 409 && data?.code === "SOURCE_UPDATE_PENDING") {
          pendingAttempts++;
          const followWriter = state.autoRefreshEnabled && !activity && !requiredSourceVersion;
          if (!followWriter && pendingAttempts >= 30) throw new Error(localizeServerError(data, response.status));
          updateRuntimeTask(task, "source-pending");
          skipCheck = false;
          await new Promise((resolve) => {
            const wake = () => {
              window.clearTimeout(timer);
              if (cancelUsageRetry === wake) cancelUsageRetry = null;
              resolve();
            };
            const timer = window.setTimeout(wake, followWriter ? Math.min(pendingAttempts, 5) * 1000 : 1000);
            cancelUsageRetry = wake;
          });
          if (loadId !== state.usageLoadId) return;
          continue;
        }
        if (!response.ok) {
          const error = new Error(localizeServerError(data, response.status));
          error.status = response.status;
          error.body = data;
          throw error;
        }
        break;
      }
      if (requiredSourceVersion && data.sourceVersion !== requiredSourceVersion)
        throw new Error(localizeText("看板尚未更新，请重试。"));
      if (loadId !== state.usageLoadId) return;
      state.metadata = data.metadata;
      state.summary = data.summary;
      hooks.onUsage?.(data);
      state.emptySummaryMessage = null;
      state.emptySummaryRange = null;
      state.quotaSnapshot = data.summary?.quota || data.quota || null;
      context.clearQuotaNotice();
      state.periodComparison = data.periodComparison || null;
      state.fingerprint = data.fingerprint || "";
      state.snapshotId = data.snapshotId || null;
      const previousPreset = state.preset;
      context.reconcileQuotaSourceSelection();
      if (previousPreset !== state.preset)
        return requestUsage({
          skipCheck: true,
          live,
          requiredSourceVersion,
          background,
          activity,
          confirmation,
          confirmSync: confirmSync || checkSources,
        });
      updateRuntimeTask(task, "dashboard");
      renderAutoRefreshControls();
      context.updateQuotaPresetButton();
      context.render();
      await afterUsagePaint();
      if (loadId !== state.usageLoadId) return;
      appliedUsageVersion = typeof data.usageVersion === "string" && data.usageVersion ? data.usageVersion : null;
      appliedUsageScope = scope;
      waiting = data.updatePending === true;
      if (waiting) updateRuntimeTask(task, "source-pending");
      else if (initializeTime || checkSources || confirmSync) {
        const confirmed =
          confirmation && confirmation.usageVersion === appliedUsageVersion ? confirmation.checkedAt : data.checkedAt;
        commitSuccessfulCheck(confirmed);
      }
      finishUsageLoad(loadId);
      if (!waiting && !activity) {
        finishRuntimeTask(task);
        if (currentUsageTask === task) currentUsageTask = null;
      }
      await hooks.afterUsage?.(data);
      return data;
    } catch (error) {
      if (requiredSourceVersion || activity) {
        if (loadId === state.usageLoadId) taskError = error;
        throw error;
      }
      if (loadId === state.usageLoadId && error.status === 410 && state.snapshotId && !state.autoRefreshEnabled) {
        state.snapshotId = null;
        void requestUsage({ skipCheck: true, freeze: true });
        return;
      }
      if (loadId === state.usageLoadId) {
        hooks.onError?.(error, { preserveView });
        appliedUsageVersion = null;
        appliedUsageScope = null;
        if (context.isQuotaPreset(state.preset) && [409, 413].includes(error.status)) {
          if (error.body?.quota) state.quotaSnapshot = error.body.quota;
          state.summary = null;
          const windowStatus = context.quotaWindowAvailability(state.quotaSnapshot, state.preset);
          const reason = windowStatus.available
            ? localizeServerError(error.body, error.status)
            : windowStatus.reason || localizeServerError(error.body, error.status);
          context.renderUnavailableQuota(reason);
          const expectedWait = error.body?.code === "QUOTA_WINDOW_UNAVAILABLE";
          if (!expectedWait) taskError = new Error("限额统计暂不可用");
          return;
        }
        // A failed range still needs a retry even when the source files have not changed.
        state.fingerprint = "";
        taskError = new Error(`加载失败：${error.message}`);
      }
    } finally {
      finishUsageLoad(loadId);
      if (!waiting && !activity) {
        finishRuntimeTask(task, taskError);
        if (currentUsageTask === task) currentUsageTask = null;
      }
    }
  }

  async function checkForUpdates() {
    if (disposed || !state.autoRefreshEnabled || state.autoRefreshCheckInFlight) return;
    const runId = state.autoRefreshRunId;
    const loadId = state.usageLoadId;
    const task = beginRuntimeTask("check", { phase: "checking" });
    let taskError = null;
    state.autoRefreshCheckInFlight = true;
    try {
      // A missing baseline still probes once per cycle, so a failed first load can recover.
      const since = state.fingerprint;
      const response = await fetch(`/api/status${since ? `?since=${encodeURIComponent(since)}` : ""}`, {
        headers: runtimeRequestHeaders(task),
      });
      if (!response.ok && response.status !== 409) throw new Error(`API ${response.status}`);
      const status = await response.json();
      if (!state.autoRefreshEnabled || runId !== state.autoRefreshRunId || loadId !== state.usageLoadId) return;
      if (!response.ok) {
        if (status?.code !== "SOURCE_UPDATE_PENDING") throw new Error(`API ${response.status}`);
        updateRuntimeTask(task, "source-pending");
        await reloadSyncedUsage(null, { skipCheck: false });
        return;
      }
      if (status.importTask && ["running", "ready"].includes(status.importTask.status)) {
        void context.pollImportTask();
        return;
      }
      const confirmation = { checkedAt: status.checkedAt, usageVersion: status.usageVersion };
      if (status.updatePending) updateRuntimeTask(task, "source-pending");
      if (status.changed || context.isQuotaPreset(state.preset)) {
        task.priority = 2;
        updateRuntimeTask(task, "queued");
        if (context.isQuotaPreset(state.preset) && activeUsageLoadId !== state.usageLoadId)
          await requestUsage({ background: true, confirmation });
        else
          await reloadSyncedUsage(context.isQuotaPreset(state.preset) ? null : status.usageVersion, {
            skipCheck: false,
            confirmation,
          });
      } else if ("usageVersion" in status && (!status.usageVersion || status.usageVersion !== appliedUsageVersion)) {
        task.priority = 2;
        updateRuntimeTask(task, "queued");
        await reloadSyncedUsage(status.usageVersion, { skipCheck: false, confirmation });
      } else if (
        !status.updatePending &&
        activeUsageLoadId !== state.usageLoadId &&
        (status.usageVersion ? status.usageVersion === appliedUsageVersion : status.fingerprint === state.fingerprint)
      ) {
        if (currentUsageTask?.phase === "source-pending") finishRuntimeTask(currentUsageTask);
        commitSuccessfulCheck(status.checkedAt);
      }
    } catch (error) {
      if (state.autoRefreshEnabled && runId === state.autoRefreshRunId && loadId === state.usageLoadId) {
        taskError = new Error(`检查失败：${error.message}；下次继续尝试`);
      }
    } finally {
      finishRuntimeTask(task, taskError);
      if (runId === state.autoRefreshRunId) {
        state.autoRefreshCheckInFlight = false;
        renderAutoRefreshControls();
        const reconnect = usageReconnectPending;
        usageReconnectPending = null;
        if (reconnect && reconnect === state.usageEventsSource) void requestCheck();
      }
    }
  }

  function closeUsageEventsStream() {
    const source = state.usageEventsSource;
    state.usageEventsSource = null;
    usageSyncPending = null;
    usageReconnectPending = null;
    streamCleanup?.();
    streamCleanup = null;
    source?.close?.();
    state.runtimeRemoteTasks = [];
    state.runtimeRemoteErrors = [];
    renderRuntimeStatus(true);
  }

  function startUsageEventsStream() {
    if (disposed) return;
    const live = state.autoRefreshEnabled && !state.snapshotId;
    const url = live ? "/api/usage-events" : "/api/usage-events?watch=0";
    if (state.usageEventsSource?.usageMode === url || typeof window.EventSource !== "function") return;
    if (state.usageEventsSource) closeUsageEventsStream();
    const source = new window.EventSource(url);
    source.usageMode = url;
    state.usageEventsSource = source;
    let resetSnapshot = true;
    source.onopen = () => {
      if (state.usageEventsSource !== source) return;
      hooks.onStreamOpen?.(source);
      resetSnapshot = true;
      if (!live || !state.autoRefreshEnabled || state.snapshotId) return;
      if (activeUsageLoadId === state.usageLoadId) {
        usageSyncPending = { version: null, skipCheck: false };
        return;
      }
      if (state.autoRefreshCheckInFlight) usageReconnectPending = source;
      else void requestCheck();
    };
    source.onerror = () => {
      if (state.usageEventsSource !== source) return;
      state.runtimeRemoteTasks = [];
      state.runtimeRemoteErrors = [];
      for (const task of state.runtimeTasks) task.disconnected = true;
      renderRuntimeStatus(true);
    };
    source.addEventListener?.("ready", source.onopen);
    streamCleanup = hooks.bindStream?.(source);
    source.addEventListener?.("activity-state", (event) => {
      if (state.usageEventsSource !== source) return;
      try {
        receiveSnapshot(JSON.parse(event.data), resetSnapshot);
        resetSnapshot = false;
      } catch {}
    });
    source.addEventListener?.("usage-synced", (event) => {
      if (state.usageEventsSource !== source || !live || !state.autoRefreshEnabled || state.snapshotId) return;
      let version = null;
      try {
        version = JSON.parse(event.data).usageVersion;
      } catch {}
      void reloadSyncedUsage(version);
    });
  }

  function startAutoRefresh() {
    if (disposed || !state.autoRefreshEnabled) return;
    if (!state.autoRefreshTimer) {
      state.autoRefreshTimer = window.setInterval(() => void requestCheck(), AUTO_REFRESH_INTERVAL_MS);
    }
    startUsageEventsStream();
  }

  function stopAutoRefresh() {
    if (state.autoRefreshTimer) window.clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
    closeUsageEventsStream();
  }

  function refreshViewForFilters() {
    void requestUsage({ skipCheck: true });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    state.autoRefreshRunId += 1;
    state.usageLoadId += 1;
    state.autoRefreshCheckInFlight = false;
    stopAutoRefresh();
    window.clearInterval(state.relativeTimeTimer);
    state.relativeTimeTimer = null;
    if (runtimeDisplayTimer !== null) window.clearTimeout(runtimeDisplayTimer);
    if (runtimeBackgroundTimer !== null) window.clearTimeout(runtimeBackgroundTimer);
    runtimeDisplayTimer = runtimeBackgroundTimer = null;
    cancelUsageRetry?.();
    for (const finish of pendingPaints) finish();
    state.runtimeTasks = [];
    currentUsageTask = null;
    activeUsageLoadId = null;
    completeUsageLoad();
    setRuntimeSpinner(false);
  }

  return {
    formatAutoRefreshTimestamp,
    setAutoRefreshErrorDetails,
    setAutoRefreshStatus,
    setRuntimeSpinner,
    beginRuntimeTask,
    updateRuntimeTask,
    finishRuntimeTask,
    runtimeNotice,
    runtimeRequestHeaders,
    writeRuntimeStatus,
    runtimeCandidates,
    renderRuntimeStatus,
    receiveRuntimeSnapshot,
    readAutoRefreshPreference,
    persistAutoRefreshPreference,
    renderAutoRefreshControls,
    renderRelativeCheckTime,
    setAutoRefreshEnabled,
    initializeAutoRefresh,
    usageQuery,
    reloadSyncedUsage,
    finishUsageLoad,
    commitSuccessfulCheck,
    afterUsagePaint,
    loadUsage,
    checkForUpdates,
    closeUsageEventsStream,
    startUsageEventsStream,
    startAutoRefresh,
    stopAutoRefresh,
    refreshViewForFilters,
    get activeUsageLoadDone() {
      return activeUsageLoadDone;
    },
    dispose,
  };
}
