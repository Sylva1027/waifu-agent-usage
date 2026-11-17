import { createServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import v8 from "node:v8";
import {
  buildUsageFingerprint,
  classifyImportDirectory,
  discoverUsageSources,
  toPublicUsageReport,
} from "./usage-sources.js";
import { isQuotaPreset, selectQuotaWindows, USAGE_PRESETS } from "./usage-query.js";
import { summarizePeriodComparison } from "../public/period-comparison.js";
import { createSourceImports, importPathIdentity, normalizeImportPath } from "./source-imports.js";
import { publishedSummarySource } from "./usage-summary-cache-core.js";
import { calendarContext } from "./calendar-context.js";
import { recoverCodexQuota } from "./codex-quota-cache.js";
import { createUsageSourceWatcher } from "./usage-source-watch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const MIN_FULL_DETAIL_HEAP_BYTES = 512 * 1024 * 1024;
const _PRICING_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  // Character skin display copies are committed WebP (implementation plan 3.4).
  [".webp", "image/webp"],
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function requestFilters(url) {
  const preset = url.searchParams.get("preset") || "all";
  const requestedBucket = url.searchParams.get("bucket") || "day";
  const recentValue = url.searchParams.get("recentValue") || "";
  const recentBucket =
    preset === "recent"
      ? { 上一个5h: "quota_30m", 上周: "quota_24h", 上个月: "day", 今年: "month", 去年: "month" }[recentValue]
      : null;
  if (!USAGE_PRESETS.includes(preset)) {
    throw httpError(400, `Invalid preset: ${preset}.`, "INVALID_PRESET");
  }
  const bucket = isQuotaPreset(preset)
    ? preset === "quota_5h"
      ? "quota_30m"
      : "quota_24h"
    : recentBucket || requestedBucket;
  const startDate = url.searchParams.get("startDate") || "";
  const endDate = url.searchParams.get("endDate") || "";
  const calendarZone = "local";
  const excludeHomes = (url.searchParams.get("exclude") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 200);

  if (!isQuotaPreset(preset) && !recentBucket && !["hour", "day", "week", "month"].includes(bucket)) {
    throw httpError(400, "Invalid bucket.", "INVALID_BUCKET");
  }
  if (preset === "custom") {
    if ((startDate && !isValidDateOnly(startDate)) || (endDate && !isValidDateOnly(endDate))) {
      throw httpError(400, "Invalid custom date.", "INVALID_DATE");
    }
    if (startDate && endDate && startDate > endDate) {
      throw httpError(400, "Start date must not be after end date.", "INVALID_DATE_RANGE");
    }
  }
  return {
    preset,
    bucket,
    startDate,
    endDate,
    recentValue,
    excludeHomes,
    calendarZone,
    calendarContext: calendarContext(),
  };
}

/** Exclude selected homes from public usage events and sessions. */
export function withoutExcludedHomes(report, excludeHomes = []) {
  const excluded = new Set(excludeHomes.map(String));
  if (!excluded.size) {
    return report;
  }
  return {
    ...report,
    events: report.events.filter((event) => !excluded.has(String(event.homeId))),
    sessions: report.sessions.filter((session) => !excluded.has(String(session.homeId))),
  };
}

export function isFullDetailHeapAvailable(heapSizeLimitBytes = v8.getHeapStatistics().heap_size_limit) {
  return heapSizeLimitBytes >= MIN_FULL_DETAIL_HEAP_BYTES;
}

export async function describeImportEntry(importPath) {
  const classified = await classifyImportDirectory(importPath);
  if (classified.type === "unsupported") {
    return classified;
  }
  const name = path.basename(classified.path) || classified.path;
  const label =
    classified.type === "project-log"
      ? `Project ${name}`
      : classified.type === "hermes-home"
        ? `Hermes ${name}`
        : classified.type === "zcode-home"
          ? `ZCode ${name}`
          : classified.type === "dsh-home"
            ? `DSH ${name}`
            : classified.type === "opencode-home"
              ? `OpenCode ${name}`
              : classified.type === "claude-home"
                ? `Claude Code ${name}`
                : classified.type === "workbuddy-home"
                  ? `WorkBuddy ${name}`
                  : `Imported ${name}`;
  return {
    type: classified.type,
    path: classified.path,
    label,
    ...(classified.usageLogPath ? { usageLogPath: classified.usageLogPath } : {}),
    ...(classified.dbFile ? { dbFile: classified.dbFile } : {}),
  };
}

function clientFingerprint(sourceFingerprint, contextVersion = "", asOf = null, timeZone = calendarContext().timeZone) {
  return createHash("sha256")
    .update(String(sourceFingerprint ?? ""))
    .update("\0")
    .update(String(contextVersion ?? ""))
    .update(
      asOf ? `${new Intl.DateTimeFormat("en-CA", { timeZone }).format(asOf)}:${asOf.toISOString().slice(0, 10)}` : "",
    )
    .update("\0")
    .update(timeZone)
    .digest("hex");
}

function usageViewVersion(
  fingerprint,
  source,
  queryIdentity = [],
  asOf = new Date(),
  timeZone = calendarContext().timeZone,
) {
  if (
    !source?.routingFingerprint ||
    !source.publication?.signature ||
    source.publication.pending ||
    source.fingerprint !== fingerprint
  )
    return null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        clientFingerprint(fingerprint, JSON.stringify(queryIdentity), asOf, timeZone),
        source.routingFingerprint,
        source.publication.signature,
        queryIdentity,
      ]),
    )
    .digest("hex");
}

function httpError(statusCode, message, code) {
  /** @type {Error & { statusCode?: number, code?: string }} */
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

export async function readJsonBody(request, { maxBytes = 16_384 } = {}) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > maxBytes) {
      throw httpError(413, "Request body too large");
    }
    chunks.push(buffer);
  }
  if (!byteLength) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw httpError(400, "Request body must be a JSON object.");
    }
    return body;
  } catch (error) {
    if (error.statusCode) throw error;
    throw httpError(400, "Invalid JSON request body.");
  }
}

async function pickDirectoryWithSystemDialog(signal) {
  if (process.platform === "win32") {
    const helper = path.resolve(__dirname, "../native/windows-source-proof/bin/windows-source-proof.exe");
    try {
      const { stdout } = await execFileAsync(helper, ["pick-directory"], {
        windowsHide: true,
        encoding: "utf8",
        signal,
      });
      const result = JSON.parse(stdout);
      if (typeof result.path !== "string") throw new Error(result.error || "Invalid picker result.");
      return result.path;
    } catch (error) {
      throw httpError(500, error.message, "DIRECTORY_PICKER_FAILED");
    }
  }
  if (process.platform !== "darwin") {
    throw httpError(400, "Enter the directory path manually on this system.", "DIRECTORY_PICKER_UNAVAILABLE");
  }

  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "选择要导入的 Waifu Agent Usage 目录")'],
      { signal },
    );
    return stdout.trim();
  } catch (error) {
    if (error.code === 1 && String(error.stderr || "").includes("-128")) {
      return "";
    }
    throw httpError(500, error.message, "DIRECTORY_PICKER_FAILED");
  }
}

function pickDirectory(options = {}, signal) {
  // Tests and future desktop shells can inject a picker without changing routes.
  return options.pickDirectory ? options.pickDirectory({ signal }) : pickDirectoryWithSystemDialog(signal);
}

async function serveStatic(requestPath, response, publicFiles) {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  let decoded;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    sendText(response, 400, "Bad request");
    return;
  }
  const selected = publicFiles ? publicFiles.get(decoded) : decoded;
  if (!selected) {
    sendText(response, 404, "Not found");
    return;
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${selected}`);
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    sendText(response, 404, "Not found");
  }
}

/** @param {Record<string,any>} options @param {any} definition */
export function createUsageServer(options = {}, definition) {
  const { createUsageExecutor, UsageSummaryCache, summaryCacheKey, buildUsageReport, summarizeUsage } = definition;
  // W1：阻塞工作（`sync`/`summarize`/`periodComparison`/`snapshot`）移入**唯一**持有
  // `DatabaseSync` 的执行器；主线程只保留读侧快照与轻量端点（`/api/status` 就地扫 fs）。
  const importContext = options.importContext ?? null;
  let importTask = null;
  let directoryPicker = null;
  const activityContext = new AsyncLocalStorage();
  const activityEpoch = randomUUID();
  const activityTasks = new Map();
  const activityErrors = new Map();
  let activityRevision = 0;
  let nextActivityId = 0;

  function activitySnapshot() {
    return {
      epoch: activityEpoch,
      revision: activityRevision,
      tasks: [...activityTasks.values()],
      errors: [...activityErrors.values()],
    };
  }

  function updateActivity(task) {
    if (serverClosed) return;
    const previous = activityTasks.get(task.id);
    if (task.state === "done" || task.state === "failed") {
      if (!previous) return;
      activityTasks.delete(task.id);
      if (task.state === "failed" && task.error?.code !== "SOURCE_UPDATE_PENDING") {
        activityErrors.set(task.id, {
          ...previous,
          code: task.error?.code || "ACTIVITY_FAILED",
          message: task.error?.message || "Operation failed",
        });
        while (activityErrors.size > 32) activityErrors.delete(activityErrors.keys().next().value);
      }
    } else {
      if (!previous) {
        for (const [id, error] of activityErrors) {
          if (
            error.kind === task.kind &&
            error.shared === task.shared &&
            (task.shared || error.requestId === task.requestId)
          )
            activityErrors.delete(id);
        }
      }
      activityTasks.set(task.id, task);
    }
    activityRevision++;
    const snapshot = activitySnapshot();
    for (const client of usageEventClients) writeUsageEvent(client, "activity-state", snapshot);
  }

  async function runActivity(kind, phase, action) {
    const context = { requestId: null, shared: true, kind };
    const task = { id: `server:${++nextActivityId}`, ...context, phase, state: "running" };
    updateActivity(task);
    try {
      const result = await usageStore.runWithActivity(context, action);
      updateActivity({ ...task, state: "done" });
      return result;
    } catch (error) {
      updateActivity({ ...task, state: "failed", error });
      throw error;
    }
  }

  let usageStore;
  const features = definition.createFeatures?.(options, {
    usageOptions,
    runActivity,
    loadUsageStore,
    writeUsageEvent,
    sendJson,
    httpError,
    readJsonBody,
    get usageStore() {
      return usageStore;
    },
    get storeStatus() {
      return storeStatus;
    },
    get serverClosed() {
      return serverClosed;
    },
    get usageEventClients() {
      return usageEventClients;
    },
    get snapshots() {
      return snapshots;
    },
  });
  const usageVersion = (fingerprint, source, catalog, asOf = new Date(), timeZone = calendarContext().timeZone) =>
    usageViewVersion(
      fingerprint,
      source,
      [definition.edition, ...(features?.versionInputs(catalog) || [])],
      asOf,
      timeZone,
    );
  const runQueryContext = (catalog, work) => (features ? features.runWithQueryContext(catalog, work) : work());
  usageStore = createUsageExecutor(options, {
    ...features?.executorOptions(),
    onActivity: updateActivity,
    onImportStage: (stage) => {
      if (importTask?.status === "running") importTask.stage = stage;
    },
  });
  const summaryCache = new UsageSummaryCache(options);
  const runtimeDatabaseFile = path.resolve(
    options.databaseFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "usage-index.sqlite"),
  );
  const sourceImports = createSourceImports(options, async () => {
    try {
      await stat(runtimeDatabaseFile);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return usageStore.publishedUsageHomes();
  });
  let sourceVersion = null;
  async function usageOptions() {
    if (importContext) return options;
    const confirmedSources = await sourceImports.list();
    sourceVersion = createHash("sha256").update(JSON.stringify(confirmedSources)).digest("hex");
    return { ...options, confirmedSources, importStoreFile: sourceImports.file };
  }
  async function listImportEntries() {
    if (importContext) return [];
    return Promise.all(
      (await sourceImports.list()).map(async (entry) => ({ ...(await describeImportEntry(entry.path)), ...entry })),
    );
  }
  const runtimeSummaryCacheFile = path.resolve(summaryCache.file);
  const runtimeSegmentDirectory = `${runtimeDatabaseFile}.segments`;
  const runtimeGeneratedFiles = [
    runtimeDatabaseFile,
    `${runtimeDatabaseFile}-journal`,
    `${runtimeDatabaseFile}-wal`,
    `${runtimeDatabaseFile}-shm`,
    runtimeSummaryCacheFile,
    `${runtimeSummaryCacheFile}-journal`,
    `${runtimeSummaryCacheFile}-wal`,
    `${runtimeSummaryCacheFile}-shm`,
  ];
  let importAdmission = Promise.resolve();
  function admitImport(task) {
    const result = importAdmission.then(task);
    importAdmission = result.catch(() => {});
    return result;
  }
  async function runImport(task) {
    await runActivity("import", "reading", async () => {
      await executeImport(task);
      if (task.status === "failed") throw Object.assign(new Error(task.error.message), { code: task.error.code });
    }).catch(() => {});
  }

  async function executeImport(task) {
    const releaseWorker = usageStore.retainWorker();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await loadUsageStore({ check: true });
          break;
        } catch (error) {
          if (serverClosed || error.code !== "SOURCE_UPDATE_PENDING" || attempt >= 29) throw error;
          task.stage = "settling";
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      task.status = "ready";
      task.stage = "dashboard";
      task.warnings = [...usageStore.warnings];
    } catch (error) {
      task.status = "failed";
      task.error = { code: error.code || "IMPORT_FAILED", message: error.message };
      task.finishedAt = Date.now();
      if (sourceRetryTimer !== null) clearTimeout(sourceRetryTimer);
      sourceRetryTimer = null;
      sourceUpdatePending = usageWakePending = false;
      updateActivity({ id: "source-pending", state: "done" });
    } finally {
      releaseWorker();
      for (const client of usageEventClients) writeUsageEvent(client, "import", { importTask: task });
    }
  }
  let storeStatus = null;
  let syncPromise = null;
  let publishedSource = null;
  let synchronizedSource = null;
  let sourceAcquisitionAvailable = process.platform === "win32";
  let sourceHints = { paths: [], unknown: false };
  let snapshotDirectoryPromise = null;
  let serverClosed = false;
  const usageEventClients = new Set();
  const usageWatchClients = new Set();
  let usageEventHeartbeat = null;
  let usageWakePromise = null;
  let usageWakePending = false;
  let sourceUpdatePending = false;
  let pendingAfterPublication = false;
  let sourceRetryTimer = null;
  let lastUsageEventVersion = null;
  const snapshots = new Map();
  let snapshotDirectoryCleanup = Promise.resolve();

  function isPrivateSnapshotPath(candidate, snapshotDirectory) {
    const relative = path.relative(path.resolve(snapshotDirectory), path.resolve(candidate));
    return (
      Boolean(relative) && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    );
  }

  async function removeSnapshotArtifacts(snapshot, snapshotDirectory) {
    await snapshot.store?.close();
    const databaseFile = path.resolve(snapshot.databaseFile);
    if (!isPrivateSnapshotPath(databaseFile, snapshotDirectory)) return;
    for (const file of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
      await rm(file, { force: true, maxRetries: 10, retryDelay: 50 });
    }
    // Never trust the executor-provided path for deletion; only remove our derived private child.
    for (const suffix of [".segments", ".history-cache"]) {
      const cleanupDirectory = `${databaseFile}${suffix}`;
      if (isPrivateSnapshotPath(cleanupDirectory, snapshotDirectory)) {
        await rm(cleanupDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }
  }

  async function createSnapshot({ check = false } = {}) {
    const pricingCatalog = features?.pricingCatalog();
    const automatic = features?.automaticStatus(pricingCatalog);
    const status = await loadUsageStore({ check });
    snapshotDirectoryPromise ||= mkdtemp(path.toNamespacedPath(path.join(os.tmpdir(), "codex-usage-snapshot-")));
    const snapshotDirectory = await snapshotDirectoryPromise;
    const id = randomUUID();
    const databaseFile = path.join(snapshotDirectory, `${id}.sqlite`);
    let store = null;
    let snapshot;
    try {
      // `id` / `asOf` / `snapshots.set(...)` 是**纯主线程簿记**（快照句柄与淘汰策略属 HTTP 层）；
      // 连接归执行器独占 ⇒ 备份只能在执行器内做，它返回绑定该 `asOf` 的读侧状态。
      const asOf = new Date();
      const frozen = await runQueryContext(pricingCatalog, () =>
        usageStore.snapshot({ databaseFile, asOf: asOf.getTime() }),
      );
      const capturedCalendar = frozen.calendarContext || calendarContext();
      store = createUsageExecutor(
        { databaseFile, calendarTimeZone: capturedCalendar.timeZone },
        { ...features?.frozenExecutorOptions(pricingCatalog), onActivity: updateActivity },
      );
      await store.runWithActivity(activityContext.getStore() || {}, () => store.open({ frozen }));
      snapshot = {
        store,
        ...features?.snapshotFields(pricingCatalog, automatic),
        cleanupDirectory: frozen.cleanupDirectory ? `${databaseFile}.segments` : null,
        status: { ...(frozen.status || status), checkedAt: frozen.checkedAt || status.checkedAt },
        asOf,
        calendarContext: capturedCalendar,
        metadata: { ...frozen.metadata, calendarContext: capturedCalendar, imports: await listImportEntries() },
        databaseFile,
        fingerprintSource: importContext
          ? status.fingerprint
          : publishedSource?.routingFingerprint || status.fingerprint,
      };
    } catch (error) {
      await removeSnapshotArtifacts({ store, databaseFile }, snapshotDirectory);
      throw error;
    }
    snapshots.set(id, snapshot);
    while (snapshots.size > 8) {
      const oldestId = snapshots.keys().next().value;
      const oldest = snapshots.get(oldestId);
      snapshots.delete(oldestId);
      await removeSnapshotArtifacts(oldest, snapshotDirectory);
    }
    return { id, ...snapshot };
  }

  function scheduleSourceRetry() {
    if (serverClosed || importTask?.status === "failed" || sourceRetryTimer !== null) return;
    updateActivity({
      id: "source-pending",
      requestId: null,
      shared: true,
      kind: "sync",
      phase: "settling",
      state: "queued",
    });
    sourceRetryTimer = setTimeout(() => {
      sourceRetryTimer = null;
      void requestUsageWake();
    }, 1000);
    sourceRetryTimer.unref?.();
  }

  function loadUsageStore(options = {}) {
    if (syncPromise) return syncPromise;
    return runActivity("sync", "checking", () => acquireUsageStore(options)).then((status) => {
      features?.scheduleAchievementUpdate();
      return status;
    });
  }

  async function acquireUsageStore({ check = true } = {}) {
    if (syncPromise) {
      return syncPromise;
    }
    if (!check && pendingAfterPublication && storeStatus && usageStore.alive) return storeStatus;
    if (check && pendingAfterPublication && sourceRetryTimer !== null) {
      clearTimeout(sourceRetryTimer);
      sourceRetryTimer = null;
    }
    if (sourceRetryTimer !== null) throw httpError(409, "Source update is still pending", "SOURCE_UPDATE_PENDING");
    if (!check && storeStatus && usageStore.status) return storeStatus;
    if (importContext) {
      syncPromise = usageStore
        .open({
          imported: true,
          ...features?.importedOpenFields(),
        })
        .then((status) => {
          storeStatus = status;
          return status;
        })
        .finally(() => {
          syncPromise = null;
        });
      return syncPromise;
    }
    const releaseAcquisition = usageStore.retainWorker();
    let laterInputs = false;
    let acquiredSourceVersion = null;
    syncPromise = (async () => {
      const currentUsageOptions = await usageOptions();
      acquiredSourceVersion = sourceVersion;
      const sourceOptions = {
        ...currentUsageOptions,
        importStoreFile: sourceImports.file,
      };
      const hints = sourceHints;
      sourceHints = { paths: [], unknown: false };
      let startupRetained = null;
      if (!storeStatus) {
        startupRetained = await summaryCache.retainedState();
        if (startupRetained) {
          sourceAcquisitionAvailable = process.platform === "win32" && Boolean(startupRetained.status?.acquisition);
          if (sourceAcquisitionAvailable) usageStore.restoreState(startupRetained);
        }
      }
      // A crashed executor needs a full publication before unchanged-source checks can serve its state.
      if (sourceAcquisitionAvailable && usageStore.status && (startupRetained || storeStatus?.acquisition)) {
        const checked = await usageStore.checkSources(sourceOptions);
        const source = checked && (await summaryCache.readCertifiedSourceState(sourceOptions, checked));
        if (source && (!startupRetained || (await summaryCache.stateFor(source)))) {
          storeStatus = checked;
          publishedSource = {
            ...source,
            completion: (await usageStore.validateAcquisition(checked.fingerprint, { completion: true })) || null,
          };
          features?.scheduleUsageDiscovery(usageStore.metadata().harnessModels);
          return checked;
        }
      }
      if (sourceAcquisitionAvailable) {
        const certified = await usageStore.sync({ options: sourceOptions, certifiedOnly: true, sourceHints: hints });
        sourceAcquisitionAvailable = Boolean(certified?.acquisition);
        const source = certified && (await summaryCache.readCertifiedSourceState(sourceOptions, certified));
        if (source) {
          if (
            !certified.completion ||
            (await usageStore.validateAcquisition(certified.fingerprint, { completion: true })) !== certified.completion
          )
            throw httpError(409, "Source update is still pending", "SOURCE_UPDATE_PENDING");
          publishedSource = source;
          storeStatus = certified;
          features?.scheduleUsageDiscovery(usageStore.metadata().harnessModels);
          return certified;
        }
      }
      const before = await summaryCache.readSourceState({
        ...currentUsageOptions,
        importStoreFile: sourceImports.file,
      });
      // Acquisition can be complete before a dashboard response has been cached.
      if (
        before.publication &&
        !before.publication.pending &&
        before.routingFingerprint === synchronizedSource?.routingFingerprint &&
        before.fingerprint === storeStatus?.fingerprint &&
        usageStore.status?.fingerprint === storeStatus.fingerprint &&
        (before.publication.signature === synchronizedSource?.publication?.signature ||
          (await usageStore.validateAcquisition(storeStatus.fingerprint)))
      ) {
        storeStatus = { ...storeStatus, checkedAt: before.checkedAt };
        publishedSource = {
          ...before,
          completion: (await usageStore.validateAcquisition(storeStatus.fingerprint, { completion: true })) || null,
        };
        synchronizedSource = publishedSource;
        return storeStatus;
      }
      const retained = await summaryCache.stateFor(before);
      if (retained) {
        usageStore.restoreState(retained);
        storeStatus = { ...retained.status, checkedAt: before.checkedAt };
        publishedSource = before;
        return storeStatus;
      }
      const status = await usageStore.sync({ options: sourceOptions, sourceHints: hints });
      sourceAcquisitionAvailable = Boolean(status.acquisition);
      const source = status.acquisition && (await summaryCache.readCertifiedSourceState(sourceOptions, status));
      if (source) publishedSource = source;
      else {
        const after = await summaryCache.readSourceState(sourceOptions);
        if (after.fingerprint === before.fingerprint && after.routingFingerprint !== before.routingFingerprint)
          throw httpError(409, "Source update is still pending", "SOURCE_UPDATE_PENDING");
        if (status.fingerprint !== before.fingerprint || after.fingerprint !== status.fingerprint) {
          if (status.fingerprint !== before.fingerprint && after.auxiliary !== before.auxiliary)
            throw httpError(409, "Source update is still pending", "SOURCE_UPDATE_PENDING");
          if (after.fingerprint === status.fingerprint) publishedSource = after;
          else {
            const completed = await summaryCache.readCompletedSourceState(
              sourceOptions,
              status,
              usageStore.homes,
              before,
            );
            if (
              !completed ||
              (await usageStore.validateAcquisition(status.fingerprint, { completion: true })) !== status.completion
            )
              throw httpError(409, "Source update is still pending", "SOURCE_UPDATE_PENDING");
            publishedSource = completed;
          }
        } else publishedSource = publishedSummarySource(before, after);
        laterInputs = after.fingerprint !== status.fingerprint;
      }
      if (
        !status.completion ||
        (await usageStore.validateAcquisition(status.fingerprint, { completion: true })) !== status.completion
      )
        throw httpError(409, "Source update is still pending", "SOURCE_UPDATE_PENDING");
      publishedSource = { ...publishedSource, completion: status.completion ?? null };
      synchronizedSource = publishedSource;
      storeStatus = status;
      features?.scheduleUsageDiscovery(usageStore.metadata().harnessModels);
      return status;
    })()
      .then((status) => {
        storeStatus = { ...status, sourceVersion: acquiredSourceVersion };
        pendingAfterPublication = laterInputs;
        sourceUpdatePending = laterInputs;
        if (!laterInputs) updateActivity({ id: "source-pending", state: "done" });
        if (laterInputs) {
          sourceHints.unknown = true;
          scheduleSourceRetry();
        }
        return storeStatus;
      })
      .catch((error) => {
        pendingAfterPublication = false;
        if (error.code === "SOURCE_UPDATE_PENDING") {
          sourceUpdatePending = true;
          sourceHints.unknown = true;
          scheduleSourceRetry();
        } else {
          sourceUpdatePending = false;
          updateActivity({ id: "source-pending", state: "done" });
        }
        throw error;
      })
      .finally(() => {
        syncPromise = null;
        releaseAcquisition();
      });
    return syncPromise;
  }

  async function discoverUsageWatchRoots() {
    const currentOptions = await usageOptions();
    const sources =
      currentOptions.confirmedSources ||
      storeStatus?.acquisition?.homes ||
      (await discoverUsageSources(currentOptions));
    const roots = [];
    for (const source of sources) {
      const sourceRoot = path.resolve(source.path);
      roots.push({ path: sourceRoot, recursive: true });
      if (source.usageLogPath) {
        const usageLogPath = path.resolve(source.usageLogPath);
        const relative = path.relative(sourceRoot, usageLogPath);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          roots.push({
            path: path.dirname(usageLogPath),
            filename: path.basename(usageLogPath),
            recursive: false,
          });
        }
      }
    }
    const storeFile = sourceImports.file;
    roots.push({
      path: path.dirname(storeFile),
      filename: path.basename(storeFile),
      recursive: false,
    });
    return roots;
  }

  const usageSourceWatcher = createUsageSourceWatcher({
    discoverRoots: discoverUsageWatchRoots,
    retainPending: () => usageStore.retainWorker(),
    onHint: (hint) => {
      const merged = new Map([...sourceHints.paths, ...hint.paths].map((entry) => [entry.path, entry]));
      sourceHints = {
        paths: [...merged.values()].slice(0, 128),
        unknown: sourceHints.unknown || hint.unknown || merged.size > 128,
      };
      return requestUsageWake();
    },
    ignorePath: (filename) => {
      const resolved = path.resolve(filename);
      return (
        runtimeGeneratedFiles.includes(resolved) ||
        resolved === runtimeSegmentDirectory ||
        resolved.startsWith(`${runtimeSegmentDirectory}${path.sep}`)
      );
    },
  });

  function writeUsageEventChunk(response, chunk) {
    if (response.destroyed || response.writableEnded) {
      removeUsageEventClient(response);
      return false;
    }
    try {
      if (response.write(chunk)) return true;
    } catch {}
    removeUsageEventClient(response);
    response.destroy();
    return false;
  }

  function writeUsageEvent(response, event, data) {
    return writeUsageEventChunk(response, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function clearUsageEventHeartbeat() {
    if (usageEventHeartbeat === null) return;
    clearInterval(usageEventHeartbeat);
    usageEventHeartbeat = null;
  }

  function startUsageEventHeartbeat() {
    if (usageEventHeartbeat !== null) return;
    usageEventHeartbeat = setInterval(() => {
      for (const response of usageEventClients) {
        writeUsageEventChunk(response, ": heartbeat\n\n");
      }
    }, 25_000);
    usageEventHeartbeat.unref?.();
  }

  function removeUsageEventClient(response) {
    usageEventClients.delete(response);
    usageWatchClients.delete(response);
    if (!usageEventClients.size) clearUsageEventHeartbeat();
    if (!usageWatchClients.size) void usageSourceWatcher.stop();
  }

  function broadcastUsageSync(status) {
    if (serverClosed || !usageWatchClients.size) return;
    const catalog = features?.pricingCatalog();
    const data = {
      checkedAt: status?.checkedAt || new Date().toISOString(),
      fingerprint: status?.fingerprint || "",
      usageVersion: usageVersion(status?.fingerprint, publishedSource, catalog),
    };
    const version =
      data.usageVersion ||
      JSON.stringify([
        data.fingerprint,
        publishedSource?.routingFingerprint,
        publishedSource?.publication?.signature,
        catalog?.version,
        catalog?.usdToCnyRate,
      ]);
    if (version === lastUsageEventVersion) return;
    lastUsageEventVersion = version;
    for (const response of [...usageWatchClients]) {
      try {
        writeUsageEvent(response, "usage-synced", data);
      } catch {
        removeUsageEventClient(response);
        response.destroy();
      }
    }
  }

  async function closeUsageEventStreams() {
    const clients = [...usageEventClients];
    usageEventClients.clear();
    usageWatchClients.clear();
    clearUsageEventHeartbeat();
    await usageSourceWatcher.stop();
    for (const response of clients) {
      if (response.destroyed || response.writableEnded) continue;
      try {
        writeUsageEvent(response, "close", {});
        response.end();
      } catch {
        response.destroy();
      }
    }
  }

  function requestUsageWake() {
    if (
      serverClosed ||
      importTask?.status === "failed" ||
      (!usageWatchClients.size && !sourceUpdatePending) ||
      sourceRetryTimer !== null
    )
      return Promise.resolve();
    if (usageWakePromise) {
      usageWakePending = true;
      return usageWakePromise;
    }
    usageWakePromise = (async () => {
      try {
        while (!serverClosed && (usageWatchClients.size || sourceUpdatePending)) {
          usageWakePending = false;
          const joinedExistingSync = syncPromise !== null;
          let status;
          try {
            status = await loadUsageStore({ check: true });
          } catch (error) {
            usageWakePending = error.code === "SOURCE_UPDATE_PENDING";
            return;
          }
          if (serverClosed || !usageWatchClients.size) return;
          broadcastUsageSync(status);
          if (joinedExistingSync || usageWakePending) continue;
          await usageSourceWatcher.refresh().catch(() => {});
          if (serverClosed || !usageWatchClients.size) return;
          return;
        }
      } finally {
        usageWakePromise = null;
        if (usageWakePending && sourceRetryTimer === null && !serverClosed && usageWatchClients.size) {
          queueMicrotask(() => void requestUsageWake());
        }
      }
    })();
    return usageWakePromise;
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const requestId = request.headers["x-usage-request-id"];
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(requestId))) {
      sendJson(response, 400, { code: "INVALID_ACTIVITY_REQUEST_ID", error: "Invalid usage request identity." });
      return;
    }
    const kind =
      url.pathname === "/api/status"
        ? "check"
        : ["/api/usage", "/api/summary"].includes(url.pathname)
          ? "statistics"
          : features?.activityKind(url.pathname)
            ? features.activityKind(url.pathname)
            : url.pathname === "/api/imports" && request.method !== "GET"
              ? request.method === "DELETE"
                ? "remove"
                : "import"
              : null;
    const context = { requestId: requestId || null, shared: false, ...(kind ? { kind } : {}) };
    return activityContext.run(context, () =>
      usageStore.runWithActivity(context, async () => {
        const task = kind && {
          id: `http:${++nextActivityId}`,
          ...context,
          kind,
          phase: kind === "check" ? "checking" : kind === "statistics" ? "queued" : kind,
          state: "running",
        };
        if (task) updateActivity(task);
        try {
          await handleRequest(request, response);
        } finally {
          if (task) updateActivity({ ...task, state: "done" });
        }
      }),
    );
  });

  async function handleRequest(request, response, recoveryAttempted = false) {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    let createdSnapshot = null;

    try {
      await features?.ready;

      if (await features?.handleRequest(request, response, url)) return;
      if (url.pathname === "/api/status") {
        if (importTask?.status === "running" || importTask?.status === "ready" || importTask?.status === "failed") {
          sendJson(response, 200, {
            importTask,
            sourceVersion,
            changed: importTask.status === "ready",
            fingerprint: null,
            usageVersion: null,
            checkedAt: new Date().toISOString(),
          });
          return;
        }
        const currentOptions = await usageOptions();
        const sourceOptions = {
          ...currentOptions,
          importStoreFile: sourceImports.file,
        };
        // Revalidate raw sources before reusing the committed acquisition's identity.
        const checked =
          !importContext && !syncPromise && sourceAcquisitionAvailable && storeStatus?.acquisition
            ? await usageStore.checkSources(sourceOptions)
            : null;
        const status = importContext
          ? await buildUsageFingerprint(currentOptions)
          : (checked && !syncPromise && (await summaryCache.readCertifiedSourceState(sourceOptions, checked))) ||
            (await summaryCache.readSourceState(sourceOptions));
        const since = url.searchParams.get("since") || "";
        const catalog = features?.pricingCatalog();
        const asOf = new Date();
        const fingerprint = clientFingerprint(
          "routingFingerprint" in status ? status.routingFingerprint : status.fingerprint,
          catalog?.version,
          asOf,
        );
        sendJson(response, 200, {
          fingerprint,
          usageVersion: usageVersion(status.fingerprint, importContext ? null : status, catalog, asOf),
          changed: since ? fingerprint !== since : true,
          checkedAt: status.checkedAt,
          importTask,
          sourceVersion,
        });
        return;
      }

      if (url.pathname === "/api/usage-events") {
        if (request.method !== "GET") {
          sendJson(response, 405, { code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
          return;
        }
        if (importContext) {
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
          return;
        }
        if (serverClosed) {
          // An HTTP error permanently closes native EventSource; a network error lets it reconnect.
          response.destroy();
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "close",
          "x-accel-buffering": "no",
        });
        response.flushHeaders?.();
        response.write("retry: 1000\n: connected\n\n");
        usageEventClients.add(response);
        const watching = url.searchParams.get("watch") !== "0";
        if (watching) usageWatchClients.add(response);
        writeUsageEvent(response, "activity-state", activitySnapshot());
        features?.sendAchievementState(response);
        startUsageEventHeartbeat();
        const cleanup = () => removeUsageEventClient(response);
        response.once("close", cleanup);
        response.once("error", cleanup);
        request.once("aborted", cleanup);
        if (watching) await usageSourceWatcher.start().catch(() => {});
        if (!response.destroyed && !response.writableEnded) {
          writeUsageEvent(response, "ready", {});
        }
        return;
      }

      const archiveEventsMatch = /^\/api\/history\/archives\/([^/]+)\/events$/.exec(url.pathname);
      if (archiveEventsMatch) {
        if (request.method !== "GET") {
          sendJson(response, 405, { code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
          return;
        }
        let segmentId;
        try {
          segmentId = decodeURIComponent(archiveEventsMatch[1]);
        } catch {
          throw httpError(400, "Invalid archive segment id.", "INVALID_ARCHIVE_SEGMENT_ID");
        }
        /** @type {{startMs: number, endMs: number, afterId?: number, limit?: number}} */
        const page = { startMs: 0, endMs: 0 };
        for (const key of ["startMs", "endMs", "afterId", "limit"]) {
          const values = url.searchParams.getAll(key);
          if (!values.length && (key === "afterId" || key === "limit")) continue;
          if (values.length !== 1 || !/^-?\d+$/.test(values[0]) || !Number.isSafeInteger(Number(values[0]))) {
            throw httpError(400, "Archive page requires integer bounds and cursor.", "INVALID_ARCHIVE_EVENT_PAGE");
          }
          page[key] = Number(values[0]);
        }
        if (
          page.startMs >= page.endMs ||
          (page.afterId !== undefined && page.afterId < 0) ||
          (page.limit !== undefined && (page.limit < 1 || page.limit > 500))
        ) {
          throw httpError(400, "Invalid archive page bounds, cursor or limit.", "INVALID_ARCHIVE_EVENT_PAGE");
        }
        const snapshotId = url.searchParams.get("snapshot");
        const snapshot = snapshotId ? snapshots.get(snapshotId) : null;
        if (snapshotId && !snapshot) throw httpError(410, "Snapshot is no longer available.", "SNAPSHOT_EXPIRED");
        try {
          sendJson(
            response,
            200,
            snapshot
              ? await snapshot.store.historyArchiveEventPage(segmentId, page)
              : await usageStore.historyArchiveEventPage(segmentId, page),
          );
        } catch (error) {
          if (error.code === "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND") throw httpError(404, error.message, error.code);
          throw error;
        }
        return;
      }

      const archiveDaysMatch = /^\/api\/history\/archives\/([^/]+)\/days$/.exec(url.pathname);
      if (archiveDaysMatch) {
        if (request.method !== "GET") {
          sendJson(response, 405, { code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
          return;
        }
        let segmentId;
        try {
          segmentId = decodeURIComponent(archiveDaysMatch[1]);
        } catch {
          throw httpError(400, "Invalid archive segment id.", "INVALID_ARCHIVE_SEGMENT_ID");
        }
        const snapshotId = url.searchParams.get("snapshot");
        const snapshot = snapshotId ? snapshots.get(snapshotId) : null;
        if (snapshotId && !snapshot) throw httpError(410, "Snapshot is no longer available.", "SNAPSHOT_EXPIRED");
        try {
          sendJson(
            response,
            200,
            snapshot
              ? await snapshot.store.historyArchiveDays(segmentId)
              : await usageStore.historyArchiveDays(segmentId),
          );
        } catch (error) {
          if (error.code === "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND") {
            throw httpError(404, error.message, error.code);
          }
          throw error;
        }
        return;
      }

      if (url.pathname === "/api/history/archives") {
        if (request.method !== "GET") {
          sendJson(response, 405, { code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
          return;
        }
        const snapshotId = url.searchParams.get("snapshot");
        const snapshot = snapshotId ? snapshots.get(snapshotId) : null;
        if (snapshotId && !snapshot) throw httpError(410, "Snapshot is no longer available.", "SNAPSHOT_EXPIRED");
        sendJson(response, 200, snapshot ? await snapshot.store.historyArchives() : await usageStore.historyArchives());
        return;
      }

      if (url.pathname === "/api/history/imports") {
        if (request.method !== "POST") {
          sendJson(response, 405, { code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
          return;
        }
        const body = await readJsonBody(request);
        if ([body.sourceDirectory, body.importDirectory].some((value) => typeof value !== "string" || !value.trim())) {
          throw httpError(
            400,
            "sourceDirectory and importDirectory must be non-empty paths.",
            "INVALID_HISTORY_IMPORT_PATH",
          );
        }
        try {
          const result = await usageStore.historyArchiveImport({
            sourceDirectory: body.sourceDirectory,
            importDirectory: body.importDirectory,
          });
          sendJson(response, 201, result);
        } catch (error) {
          if (error.code === "HISTORY_ARCHIVE_IMPORT_DESTINATION_EXISTS") {
            throw httpError(409, error.message, error.code);
          }
          throw error;
        }
        return;
      }

      if (url.pathname === "/api/imports/discover" && request.method === "GET") {
        sendJson(response, 200, await sourceImports.discover());
        return;
      }

      if (url.pathname === "/api/imports") {
        if (request.method === "GET") {
          sendJson(response, 200, { imports: await listImportEntries(), importTask });
          return;
        }

        if (importContext) throw httpError(409, "Sources are fixed for this runtime.", "IMPORT_RUNTIME_READ_ONLY");
        if (request.method === "POST") {
          const body = await readJsonBody(request);
          if (!body || typeof body !== "object")
            throw httpError(400, "Select directory paths.", "INVALID_IMPORT_PATHS");
          const paths = body.paths ?? (body.path !== undefined ? [body.path] : []);
          if (
            (body.paths !== undefined && body.path !== undefined) ||
            !Array.isArray(paths) ||
            !paths.length ||
            paths.length > 64 ||
            paths.some((value) => typeof value !== "string" || !value.trim())
          )
            throw httpError(400, "Select between 1 and 64 directory paths.", "INVALID_IMPORT_PATHS");
          const result = await admitImport(async () => {
            if (["running", "ready"].includes(importTask?.status)) {
              const selected = new Set();
              for (const value of paths) {
                const directory = normalizeImportPath(value, options);
                const classified = await classifyImportDirectory(directory);
                selected.add(await importPathIdentity(classified.path || directory));
              }
              const active = await Promise.all(importTask.paths.map(importPathIdentity));
              if (selected.size !== active.length || active.some((directory) => !selected.has(directory)))
                throw httpError(409, "Import is in progress.", "IMPORT_IN_PROGRESS");
              return { imports: await listImportEntries(), importTask };
            }
            if (syncPromise) await syncPromise.catch(() => {});
            const added = await sourceImports.add(paths);
            await usageOptions();
            await summaryCache.invalidate();
            storeStatus = null;
            publishedSource = synchronizedSource = null;
            if (sourceRetryTimer !== null) {
              clearTimeout(sourceRetryTimer);
              sourceRetryTimer = null;
            }
            importTask = {
              id: randomUUID(),
              status: "running",
              stage: "reading",
              startedAt: Date.now(),
              sourceVersion,
              paths: added.selected.map((entry) => entry.path),
              sourceIds: added.selected.map((entry) => entry.id),
              count: added.selected.length,
            };
            void runImport(importTask);
            void usageSourceWatcher.refresh();
            return {
              import: await describeImportEntry(added.selected[0].path),
              imports: await listImportEntries(),
              importTask,
            };
          });
          sendJson(response, 200, result);
          return;
        }

        if (request.method === "DELETE") {
          await admitImport(async () => {
            if (["running", "ready"].includes(importTask?.status))
              throw httpError(409, "Import is in progress.", "IMPORT_IN_PROGRESS");
            if (syncPromise) await syncPromise.catch(() => {});
            await sourceImports.remove(url.searchParams.get("path"));
            await summaryCache.invalidate();
            storeStatus = null;
            publishedSource = synchronizedSource = null;
            importTask = null;
          });
          void usageSourceWatcher.refresh();
          sendJson(response, 200, { imports: await listImportEntries() });
          return;
        }

        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/internal/shutdown") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (!options.shutdownToken || request.headers["x-codex-usage-shutdown-token"] !== options.shutdownToken) {
          sendJson(response, 403, { error: "Forbidden" });
          return;
        }
        response.writeHead(202, { "cache-control": "no-store" });
        response.end();
        setImmediate(() => options.onShutdown?.());
        return;
      }

      if (url.pathname === "/api/pick-directory") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }

        if (directoryPicker) throw httpError(409, "A directory picker is already open.", "DIRECTORY_PICKER_BUSY");
        const controller = new AbortController();
        directoryPicker = controller;
        const cancel = () => controller.abort();
        response.once("close", cancel);
        try {
          const directory = await pickDirectory(options, controller.signal);
          if (!controller.signal.aborted) sendJson(response, 200, { path: directory });
        } finally {
          response.off("close", cancel);
          if (directoryPicker === controller) directoryPicker = null;
        }
        return;
      }

      if (url.pathname === "/api/usage" || url.pathname === "/api/summary") {
        await features?.startup;
        const releaseWorker = usageStore.retainWorker();
        response.once("finish", releaseWorker);
        response.once("close", releaseWorker);
        const filters = requestFilters(url);
        const check = url.searchParams.get("skipCheck") !== "1";
        // 已有快照先查找并校验；新快照只在请求组合受支持时创建。
        const requestedSnapshotId = url.searchParams.get("snapshot");
        const requestedFreeze = url.searchParams.get("freeze") === "1";
        let frozen = requestedSnapshotId ? snapshots.get(requestedSnapshotId) : null;
        if (requestedSnapshotId && !frozen) {
          throw httpError(410, "Snapshot is no longer available.", "SNAPSHOT_EXPIRED");
        }
        const wantsFullDetail =
          url.pathname === "/api/usage" && url.searchParams.get("detail") === "full" && !isQuotaPreset(filters.preset);
        const snapshotCoupled = Boolean(frozen) || requestedFreeze;

        if (wantsFullDetail) {
          if (importContext) {
            sendJson(response, 400, {
              code: "IMPORT_FULL_DETAIL_UNSUPPORTED",
              error: "detail=full is unavailable for an imported runtime; use the indexed summary API.",
            });
            return;
          }
          // M4.3 返工1：`detail=full` 走的是**内存**报告路径（`buildUsageReport`），它读的是当前
          // 文件系统，无法与某个已冻结的 SQLite/`asOf` 对齐。冻结请求**不得**用 live 结果冒充 ⇒
          // 明确拒绝并登记该参数组合（卡片允许"提供同一冻结数据"或"明确拒绝"二选一）。
          // 未知 snapshot 的 410 校验已在上面完成，这里只处理"与冻结组合"。
          if (snapshotCoupled) {
            sendJson(response, 400, {
              code: "SNAPSHOT_FULL_DETAIL_UNSUPPORTED",
              error:
                "detail=full cannot be combined with snapshot= or freeze=1: the full report is built from in-memory sources and cannot be bound to a frozen snapshot.",
            });
            return;
          }
          const pricingCatalog = features?.pricingCatalog();
          const payload = await runQueryContext(pricingCatalog, async () => {
            if (!isFullDetailHeapAvailable()) {
              await loadUsageStore();
              const summary = await usageStore.summarize({ ...filters, now: new Date() });
              sendJson(response, 413, {
                code: "FULL_DETAIL_UNAVAILABLE",
                error:
                  "Full detail report is disabled in low-memory gateway mode. Restart with waifu-agent-usage gateway --memory-mb 512.",
                quota: summary.quota,
              });
              return null;
            }

            const indexedStatus = await loadUsageStore({ check });
            const currentUsageOptions = await usageOptions();
            const status = await buildUsageFingerprint(currentUsageOptions);
            const fullReport = await buildUsageReport({
              ...currentUsageOptions,
              quotaSourceEvidenceSnapshot: usageStore.quotaSourceEvidenceSnapshot,
            });
            const missingSources = indexedStatus.missingSources ?? [];
            let usePublishedHistory = missingSources.length > 0;
            if (!usePublishedHistory) {
              const archives = await usageStore.historyArchives();
              usePublishedHistory = (archives.authority?.segmentIds?.length ?? 0) > 0;
            }
            if (usePublishedHistory) {
              const publishedReport = await usageStore.publishedUsageReport();
              fullReport.events = publishedReport.events;
              fullReport.rateLimitObservations = publishedReport.rateLimitObservations;
              const sessions = new Map(
                fullReport.sessions.map((session) => [JSON.stringify([session.homeId, session.id]), session]),
              );
              fullReport.sessions = publishedReport.sessions.map((session) => ({
                ...sessions.get(JSON.stringify([session.homeId, session.id])),
                ...session,
              }));
              const homes = new Map(fullReport.homes.map((home) => [home.id, home]));
              for (const home of publishedReport.homes) homes.set(home.id, { ...homes.get(home.id), ...home });
              fullReport.homes = [...homes.values()];
            }
            const report = withoutExcludedHomes(fullReport, filters.excludeHomes);
            const asOf = new Date();
            const quota = selectQuotaWindows(fullReport.rateLimitObservations || [], asOf);
            Object.assign(filters, { now: asOf, quota, ...features?.queryFilters(pricingCatalog) });
            const summary = summarizeUsage(report, filters);
            const calendar = calendarContext();
            Object.assign(summary.range, { timeZone: calendar.timeZone });
            return {
              fingerprint: clientFingerprint(status.fingerprint, pricingCatalog?.version),
              usageVersion: null,
              checkedAt: status.checkedAt,
              metadata: {
                calendarContext: calendar,
                generatedAt: fullReport.generatedAt,
                eventCount: fullReport.events.length,
                sessionCount: fullReport.sessions.length,
                homeCount: fullReport.homes.length,
                homes: fullReport.homes,
                imports: await listImportEntries(),
                warnings: fullReport.warnings,
              },
              report: { ...toPublicUsageReport(report), ...features?.catalogFields(pricingCatalog) },
              ...features?.catalogFields(pricingCatalog),
              summary,
              quota: summary.quota,
              periodComparison: summarizePeriodComparison(report.events, {
                now: asOf,
                calendarZone: filters.calendarZone,
                ...features?.queryFilters(pricingCatalog),
              }),
            };
          });
          if (payload)
            sendJson(response, 200, {
              ...payload,
              ...(await features?.shareFields(payload.summary, filters)),
            });
          return;
        }

        // 拒绝全文组合后再分配名额，避免失败请求创建不可用快照并淘汰旧快照。
        if (!frozen && requestedFreeze) {
          frozen = await createSnapshot({ check });
          createdSnapshot = frozen;
        }

        // 默认聚合入口与 `/api/summary` 共用同一套冻结选择：冻结时 summary、metadata、quota、
        // periodComparison 与 `asOf` **全部**绑定该冻结 store。
        const usage = frozen?.status || (await loadUsageStore({ check }));
        const store = frozen?.store || usageStore;
        const asOf = frozen?.asOf || new Date();
        const pricingCatalog = frozen?.pricingCatalog || features?.pricingCatalog();
        Object.assign(filters, { now: asOf, ...features?.queryFilters(pricingCatalog) });
        if (frozen)
          filters.calendarContext =
            frozen.calendarContext || frozen.metadata.calendarContext || filters.calendarContext;
        if (!frozen) {
          const includeDetails = url.pathname !== "/api/usage" || url.searchParams.get("view") !== "dashboard";
          let result;
          let source;
          let resultSource;
          let cached;
          let captured = false;
          let readAttempts = 0;
          const key = summaryCacheKey(filters, includeDetails, pricingCatalog);
          do {
            if (readAttempts) await loadUsageStore({ check: false });
            const acquiredStatus = usageStore.status;
            source = !importContext ? publishedSource : null;
            if (source && !syncPromise) {
              const previousSource = source;
              source = publishedSummarySource(source, { ...source, publication: await summaryCache.readPublication() });
              if (publishedSource === previousSource) publishedSource = source;
            }
            result = source ? await summaryCache.get(key, source, asOf) : null;
            cached = Boolean(result);
            if (cached) await usageStore.releaseHistoryVerification();
            resultSource = cached ? source : null;
            captured = false;
            response.setHeader("x-summary-cache", result ? "hit" : "miss");
            if (!result) {
              result = await runQueryContext(pricingCatalog, () => usageStore.dashboard(filters, { includeDetails }));
              if (source && result.status?.fingerprint === source.fingerprint) {
                const currentOptions = await usageOptions();
                const readOptions = {
                  ...currentOptions,
                  importStoreFile: sourceImports.file,
                };
                const afterRead = source.acquisition
                  ? await summaryCache.readCertifiedSourceState(readOptions, {
                      ...source,
                      acquisition: source.acquisition,
                    })
                  : await summaryCache.readSourceState(readOptions);
                if (
                  result.completion &&
                  result.completion === source.completion &&
                  afterRead?.auxiliary === source.auxiliary
                ) {
                  // A completed read remains valid when later raw input or a newer sync arrives.
                  resultSource = source;
                  captured = true;
                  if (!syncPromise && afterRead.fingerprint !== usageStore.status?.fingerprint) {
                    pendingAfterPublication = sourceUpdatePending = true;
                    sourceHints.unknown = true;
                    scheduleSourceRetry();
                  }
                }
                if (
                  !syncPromise &&
                  afterRead?.publication &&
                  afterRead.routingFingerprint === source.routingFingerprint &&
                  afterRead.fingerprint === result.status.fingerprint &&
                  (afterRead.publication.signature === synchronizedSource?.publication?.signature ||
                    (await usageStore.validateAcquisition(result.status.fingerprint)))
                ) {
                  synchronizedSource = afterRead;
                  // Price-check bookkeeping can change cache inputs without changing the captured response prices.
                  if (usageStore.status === acquiredStatus) resultSource = afterRead;
                }
                // A status object can be republished while the captured routing and publication stay unchanged.
                if (
                  afterRead?.publication &&
                  afterRead.routingFingerprint === source.routingFingerprint &&
                  afterRead.publication.signature === source.publication?.signature
                )
                  resultSource = source;
                if (
                  !syncPromise &&
                  afterRead?.inputs === source.inputs &&
                  afterRead.publication?.signature === source.publication?.signature
                ) {
                  try {
                    await summaryCache.publish(key, result, usageStore.stateSnapshot(), source, asOf);
                  } catch {
                    // A cache write failure must not discard a completed fresh result.
                  }
                }
              }
            }
            // A captured cache hit is coherent; a miss must not chase an endless stream of commits.
          } while (
            !cached &&
            !captured &&
            ++readAttempts < 2 &&
            (syncPromise || source?.signature !== publishedSource?.signature)
          );
          if (
            !cached &&
            !captured &&
            (syncPromise ||
              source?.signature !== publishedSource?.signature ||
              source?.fingerprint !== result.status?.fingerprint)
          ) {
            // The worker's fact fingerprint keeps this response coherent and the next check pending.
            source = null;
          }
          const responseCatalog = result.pricingCatalog || pricingCatalog;
          const published = result.status || usage;
          if (importTask?.status === "ready" && importTask.sourceVersion === usage.sourceVersion) {
            importTask.status = "published";
            importTask.finishedAt = Date.now();
          }
          sendJson(response, 200, {
            sourceVersion: usage.sourceVersion,
            fingerprint: clientFingerprint(
              source?.routingFingerprint || published.fingerprint,
              responseCatalog?.version,
              asOf,
              result.summary.range.timeZone,
            ),
            usageVersion: usageVersion(
              published.fingerprint,
              source && (!features || features.sameQueryContext(responseCatalog, pricingCatalog)) ? resultSource : null,
              responseCatalog,
              asOf,
              result.summary.range.timeZone,
            ),
            checkedAt: source?.checkedAt || published.checkedAt,
            updatePending: pendingAfterPublication || Boolean(syncPromise),
            snapshotId: requestedSnapshotId || null,
            metadata: { ...result.metadata, imports: await listImportEntries() },
            ...features?.catalogFields(responseCatalog),
            summary: result.summary,
            ...(await features?.shareFields(result.summary, filters)),
            quota: result.summary.quota,
            periodComparison: result.periodComparison,
          });
          return;
        }
        const includeDetails = url.pathname !== "/api/usage" || url.searchParams.get("view") !== "dashboard";
        const { summary, periodComparison } = await store.runWithActivity(activityContext.getStore() || {}, () =>
          store.dashboard(filters, { includeDetails }),
        );
        sendJson(response, 200, {
          fingerprint: clientFingerprint(
            frozen.fingerprintSource || usage.fingerprint,
            pricingCatalog?.version,
            asOf,
            summary.range.timeZone,
          ),
          usageVersion: null,
          checkedAt: usage.checkedAt,
          snapshotId: frozen.id || requestedSnapshotId || null,
          metadata: frozen.metadata,
          ...features?.catalogFields(pricingCatalog),
          summary,
          ...(await features?.shareFields(summary, filters)),
          quota: summary.quota,
          periodComparison,
        });
        return;
      }

      await serveStatic(url.pathname, response, definition.publicFiles);
    } catch (error) {
      if (
        !recoveryAttempted &&
        !importContext &&
        !url.searchParams.has("snapshot") &&
        usageStore.homes?.some((home) => home.kind === "main") &&
        ["/api/usage", "/api/summary"].includes(url.pathname) &&
        error.code === "QUOTA_WINDOW_UNAVAILABLE" &&
        isQuotaPreset(url.searchParams.get("preset"))
      ) {
        let recovered = false;
        try {
          recovered = await recoverCodexQuota(error.quota, url.searchParams.get("preset"), options);
          if (recovered) await loadUsageStore();
        } catch {
          recovered = false;
          // Keep the original unavailable response when the official read fails.
        }
        if (recovered) {
          if (createdSnapshot) {
            snapshots.delete(createdSnapshot.id);
            await removeSnapshotArtifacts(createdSnapshot, await snapshotDirectoryPromise);
          }
          return handleRequest(request, response, true);
        }
      }
      const statusCode =
        error.statusCode ||
        (error.code === "QUOTA_WINDOW_UNAVAILABLE" ? 409 : error.code === "INVALID_PRESET" ? 400 : 500);
      sendJson(response, statusCode, {
        ...(error.code ? { code: error.code } : {}),
        error: error.message,
        ...(error.path ? { path: error.path } : {}),
        ...(error.quota ? { quota: error.quota } : {}),
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  }
  let executorClosePromise = null;
  function closeUsageExecutor() {
    features?.releaseWorker();
    executorClosePromise ||= Promise.resolve(usageStore.close()).catch(() => {});
    return executorClosePromise;
  }
  server.on("close", () => {
    serverClosed = true;
    clearUsageEventHeartbeat();
    void usageSourceWatcher.stop();
    features?.stopTimers();
    void closeUsageExecutor();
    const closingSnapshots = Promise.all([...snapshots.values()].map((snapshot) => snapshot.store.close()));
    snapshots.clear();
    snapshotDirectoryCleanup = snapshotDirectoryPromise
      ? snapshotDirectoryPromise
          .then(async (directory) => {
            await closingSnapshots;
            await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
          })
          .catch(() => {})
      : Promise.resolve();
  });
  // W1：执行器独占数据库连接 ⇒ `server.close(cb)` 的回调必须等它**真正退出**再触发，
  // 否则调用方（测试 / CLI）随后删除临时目录会在 Windows 上 EBUSY。
  // W1-b：补**显式 Promise/flush 语义** —— `server.close()`（**无**回调）返回 Promise，且只有在执行器
  // 释放连接之后才 settle，调用方可以直接 `await server.close()` 再删库目录；带回调形式保持兼容
  // （仍返回 `server`，`test/server.test.js` 逐字节不变）。
  const closeHttpServer = server.close.bind(server);
  // `checkJs` 里 `Server#close` 的声明只允许返回 `Server`，而 W1-b 的**无回调**形式**故意**返回 Promise
  // （调用方 `await server.close()`）；用一次 JSDoc 断言保留该契约，**运行期逐字不变**。
  /** @type {(callback?: (err?: Error) => void) => unknown} */
  const closeWithExecutorRelease = (callback) => {
    serverClosed = true;
    directoryPicker?.abort();
    if (sourceRetryTimer !== null) clearTimeout(sourceRetryTimer);
    sourceRetryTimer = null;
    features?.stopTimers();
    // Stop admission before ending streams can prompt EventSource reconnects.
    const httpClosed = new Promise((resolve) => closeHttpServer(() => resolve(undefined)));
    const done = closeUsageEventStreams()
      .catch(() => {})
      .then(() => httpClosed)
      .then(async () => {
        await features?.drainAchievements();
        await closeUsageExecutor();
        summaryCache.close();
        // A refresh can start its merged successor in a fulfillment continuation.
        await features?.drainPricing();
        await snapshotDirectoryCleanup;
      });
    if (typeof callback === "function") {
      done.then(
        () => callback(),
        () => callback(),
      );
      return server;
    }
    return done;
  };
  server.close = /** @type {typeof server.close} */ (closeWithExecutorRelease);
  server.once("listening", () => features?.onListening());
  return server;
}
