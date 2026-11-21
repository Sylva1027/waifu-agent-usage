import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { backup } from "node:sqlite";
import { createHistoryBackup } from "./history-backup.js";
import {
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
  stageHistoryArchiveSegments,
} from "./history-archive.js";
import { quotaSourceEvidenceFromSnapshot, quotaSourceEvidenceSnapshot } from "./quota-source-evidence.js";
import { calendarContext } from "./calendar-context.js";
import { activityPhase, executorError, toWire } from "./usage-executor-protocol.js";

const REQUEST_TIMEOUT_MS = 900_000;
const CLOSE_TIMEOUT_MS = 5_000;

function diagnosticError(error, stage) {
  return {
    stage,
    message: error?.message ?? String(error),
    code: error?.code ?? null,
  };
}

/**
 * Try to truncate the WAL without waiting for an external reader. This is a
 * diagnostic operation: a busy reader or any SQLite error must never fail sync.
 * @param {import("node:sqlite").DatabaseSync | null | undefined} database
 */
export function checkpointUsageStore(database) {
  const started = performance.now();
  /** @type {{mode: string, busy: number | null, log: number | null, checkpointed: number | null, elapsedMs: number, error: {stage: string, message: string, code: string | null} | null, restoreError?: {stage: string, message: string, code: string | null}}} */
  const result = {
    mode: "truncate",
    busy: null,
    log: null,
    checkpointed: null,
    elapsedMs: 0,
    error: null,
  };
  let previousTimeout = null;
  try {
    if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
      throw new Error("checkpoint requires an open SQLite connection");
    }
    const row = database.prepare("PRAGMA busy_timeout").get();
    const timeout = Number(row?.timeout);
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      throw new Error(`invalid busy_timeout: ${String(row?.timeout)}`);
    }
    previousTimeout = timeout;
    database.exec("PRAGMA busy_timeout = 0");
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    result.busy = Number(checkpoint?.busy ?? 0);
    result.log = Number(checkpoint?.log ?? -1);
    result.checkpointed = Number(checkpoint?.checkpointed ?? -1);
  } catch (error) {
    result.error = diagnosticError(error, "checkpoint");
  } finally {
    if (previousTimeout !== null) {
      try {
        database.exec(`PRAGMA busy_timeout = ${previousTimeout}`);
      } catch (error) {
        const restoreError = diagnosticError(error, "restore-busy-timeout");
        if (result.error) result.restoreError = restoreError;
        else result.error = restoreError;
      }
    }
    result.elapsedMs = Math.max(0, Math.round((performance.now() - started) * 1000) / 1000);
  }
  return result;
}

/** @param {{sync: (args: any) => Promise<any>}} store @param {any} options */
export async function syncUsageStore(store, options, certifiedOnly = false, sourceHints = null) {
  return store.sync({
    options,
    ...(certifiedOnly ? { certifiedOnly: true } : {}),
    ...(sourceHints ? { sourceHints } : {}),
  });
}

function historyArchiveStatusError(code, message) {
  /** @type {Error & { code?: string }} */
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseHistoryArchiveAuthority(value, registeredSegmentIds) {
  if (value === undefined) return null;
  let authority;
  try {
    authority = JSON.parse(String(value));
  } catch {
    throw historyArchiveStatusError(
      "HISTORY_ARCHIVE_AUTHORITY_INVALID",
      "history archive event authority is not valid JSON",
    );
  }
  if (
    !authority ||
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    Object.keys(authority).sort().join(",") !== "formatVersion,segmentIds" ||
    authority.formatVersion !== 1 ||
    !Array.isArray(authority.segmentIds) ||
    authority.segmentIds.some((segmentId) => typeof segmentId !== "string" || !/^[a-f0-9]{64}$/.test(segmentId)) ||
    new Set(authority.segmentIds).size !== authority.segmentIds.length
  ) {
    throw historyArchiveStatusError(
      "HISTORY_ARCHIVE_AUTHORITY_INVALID",
      "history archive event authority must be a version-1 unique segment id list",
    );
  }
  for (const segmentId of authority.segmentIds) {
    if (!registeredSegmentIds.has(segmentId)) {
      throw historyArchiveStatusError(
        "HISTORY_ARCHIVE_AUTHORITY_INVALID",
        `history archive authority references unregistered segment ${segmentId}`,
      );
    }
  }
  return authority;
}

async function historyArchiveFileStatus(databasePath) {
  try {
    return (await stat(databasePath)).isFile() ? "present" : "unreadable";
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "missing" : "unreadable";
  }
}

/**
 * Read the registered archive inventory without verifying segment contents.
 * @param {{open: () => Promise<unknown>, database: import("node:sqlite").DatabaseSync}} store
 */
export async function readHistoryArchiveStatus(store) {
  try {
    await store.open();
  } catch (error) {
    throw historyArchiveStatusError(
      "HISTORY_ARCHIVES_UNAVAILABLE",
      `history archives are unavailable: ${error?.message ?? String(error)}`,
    );
  }

  let records;
  let authorityValue;
  try {
    records = store.database
      .prepare(
        `SELECT segment_id, database_path, start_ms, end_ms, event_count
         FROM archive_segments ORDER BY start_ms, segment_id`,
      )
      .all();
    authorityValue = store.database
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get("history_archive_event_authority")?.value;
  } catch (error) {
    throw historyArchiveStatusError(
      "HISTORY_ARCHIVES_UNAVAILABLE",
      `history archive registry is unavailable: ${error?.message ?? String(error)}`,
    );
  }

  const registeredSegmentIds = new Set(records.map((record) => String(record.segment_id)));
  const authority = parseHistoryArchiveAuthority(authorityValue, registeredSegmentIds);
  const segments = await Promise.all(
    records.map(async (record) => ({
      segmentId: String(record.segment_id),
      startMs: Number(record.start_ms),
      endMs: Number(record.end_ms),
      eventCount: Number(record.event_count),
      status: await historyArchiveFileStatus(String(record.database_path)),
    })),
  );
  return {
    authority,
    segments,
    counts: {
      segments: segments.length,
      events: segments.reduce((sum, segment) => sum + segment.eventCount, 0),
    },
  };
}

/**
 * Aggregate one sealed archive segment by UTC calendar day without merging hot facts.
 * @param {{readHistoryArchiveEvents: (segmentId: string) => Promise<Array<Record<string, unknown>>>}} store
 * @param {string} segmentId
 */
export async function readHistoryArchiveDays(store, segmentId) {
  const rows = await store.readHistoryArchiveEvents(segmentId);
  const days = new Map();
  for (const row of rows) {
    const dayKey = new Date(Number(row.timestamp_ms)).toISOString().slice(0, 10);
    const day = days.get(dayKey) || {
      day: dayKey,
      eventCount: 0,
      totals: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
    };
    day.eventCount += 1;
    day.totals.total += Number(row.total);
    day.totals.input += Number(row.input);
    day.totals.cached += Number(row.cached);
    day.totals.output += Number(row.output);
    day.totals.reasoning += Number(row.reasoning);
    days.set(dayKey, day);
  }
  return {
    segmentId,
    calendarZone: "utc",
    view: "sealed",
    days: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)),
  };
}

// ---------------------------------------------------------------------------
// 执行器侧（独立进程）
// ---------------------------------------------------------------------------

function restoreExecutorLightState(store, lightState = {}) {
  store.homes = structuredClone(lightState.homes ?? []);
  store.warnings = [...(lightState.warnings ?? [])];
  store.checkedAt = lightState.checkedAt ?? "";
  store.generatedAt = lightState.status?.generatedAt ?? store.generatedAt;
  store.fingerprint = lightState.status?.fingerprint ?? store.fingerprint;
  store.quotaSourceEvidence = lightState.quotaSourceEvidenceSnapshot
    ? quotaSourceEvidenceFromSnapshot(lightState.quotaSourceEvidenceSnapshot)
    : null;
}

/** @param {{createStore: (options: any) => any, createRuntime?: (store: any, send: any) => any, backupOptions?: any}} configuration */
export async function runUsageExecutorProcess({ createStore, createRuntime, backupOptions = {} }) {
  const childProcess = process;
  const childSend = childProcess.send;
  if (!childSend) return;

  let store = null;
  let storeStatus = null;
  let publishedReader = null;
  let publishedReady = Promise.resolve();
  let publicationPending = false;
  let runtime = null;
  let lastCheckpoint = null;
  let completedAcquisition = null;
  let liveReaders = 0;
  let liveReadersDone = Promise.resolve();
  let releaseLiveReaders = () => {};
  let pendingHistoryVerification = null;
  let syncBackupTail = Promise.resolve();
  let initialized = false;
  let initializing = false;
  let stopping = false;
  let active = 0;
  const queued = [];

  const send = (message) =>
    new Promise((resolve, reject) => {
      if (!childProcess.connected) {
        reject(new Error("executor parent IPC disconnected"));
        return;
      }
      childSend.call(childProcess, message, (error) => {
        if (error) reject(error);
        else resolve(undefined);
      });
    });

  const releaseHistoryVerification = async () => {
    const pending = pendingHistoryVerification;
    pendingHistoryVerification = null;
    if (pending) {
      clearTimeout(pending.timer);
      await pending.scope.close();
    }
  };

  const shutdown = async ({ notifyIdle = false, waitForActive = false } = {}) => {
    if (stopping) return;
    stopping = true;
    const forceExit = setTimeout(() => childProcess.exit(0), CLOSE_TIMEOUT_MS);
    try {
      if (waitForActive) {
        while (active > 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      for (const release of [
        releaseHistoryVerification,
        releasePublishedReader,
        () => runtime?.close(),
        () => store?.close(),
      ]) {
        try {
          await release();
        } catch {
          // Continue releasing independent owners before the process exits.
        }
      }
      if (notifyIdle && childProcess.connected) {
        try {
          await send({ type: "idle-exit" });
        } catch {
          // The parent may already be gone.
        }
      }
    } finally {
      clearTimeout(forceExit);
      try {
        if (childProcess.connected) childProcess.disconnect();
      } catch {
        // Already disconnected.
      }
      childProcess.exit(0);
    }
  };

  const postState = ({ includeHomes = false } = {}) => {
    if (!store) return;
    void send({
      type: "state",
      state: toWire({
        status: storeStatus,
        metadata: store.metadata(),
        checkedAt: store.checkedAt ?? storeStatus?.checkedAt ?? null,
        lastCheckpoint,
        ...(includeHomes
          ? {
              homes: store.homes,
              warnings: [...store.warnings],
              ...runtime?.state(),
              quotaSourceEvidenceSnapshot: store.quotaSourceEvidence
                ? quotaSourceEvidenceSnapshot(store.quotaSourceEvidence)
                : null,
            }
          : {}),
      }),
    }).catch(() => {});
  };

  const postCheckpointDiagnostic = () => {
    void send({ type: "state", state: toWire({ lastCheckpoint }) }).catch(() => {
      // A diagnostic must never replace the original sync failure.
    });
  };

  const closePublishedReader = (lease) => {
    const reader = lease.reader;
    lease.reader = null;
    if (!reader) return null;
    let cleanupError = null;
    try {
      reader.database.exec("ROLLBACK");
    } catch (error) {
      cleanupError = error;
    }
    try {
      reader.close();
    } catch (error) {
      cleanupError ??= error;
    }
    return cleanupError;
  };

  const releasePublishedReader = () => {
    const lease = publishedReader;
    publishedReader = null;
    if (!lease) return null;
    lease.retired = true;
    return lease.users ? null : closePublishedReader(lease);
  };

  const serializeSyncBackup = (operation) => {
    const result = syncBackupTail.then(operation);
    // A failed operation must not poison later sync/backup requests.
    syncBackupTail = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const completedPublication = () => {
    const receipt = completedAcquisition;
    if (!receipt) return null;
    const guard = store.usageProjectionGuard({ includeHistory: true });
    return guard &&
      guard.database === receipt.guard.database &&
      guard.identity === receipt.guard.identity &&
      guard.dataVersion === receipt.guard.dataVersion &&
      guard.evidence === receipt.guard.evidence &&
      store.usageProjectionChangeKey(undefined, true) === receipt.key
      ? receipt
      : null;
  };

  const handle = async (message, reportActivity) => {
    switch (message.type) {
      case "open": {
        runtime?.open(message);
        await store.open();
        if (message.frozen) {
          restoreExecutorLightState(store, message.frozen);
          runtime?.restoreState(message.frozen);
          const checkedAt = message.frozen.checkedAt ?? message.frozen.status?.checkedAt ?? new Date().toISOString();
          storeStatus = message.frozen.status
            ? { ...message.frozen.status, checkedAt }
            : {
                fingerprint: store.fingerprint,
                generatedAt: store.generatedAt,
                checkedAt,
                missingSources: store.sourceState().missingSources,
              };
          store.checkedAt = checkedAt;
        } else if (message.imported) {
          store.homes = await store.withSqlHistoryReader((reader) => reader.publishedUsageHomes());
          store.checkedAt = new Date().toISOString();
          storeStatus = {
            fingerprint: store.fingerprint,
            generatedAt: store.generatedAt,
            checkedAt: store.checkedAt,
            missingSources: store.sourceState().missingSources,
          };
        }
        try {
          postState({ includeHomes: true });
        } catch (error) {
          // A live writer must open to repair an interrupted sync; no partial metadata is published.
          if (message.frozen || message.imported || error.code !== "SOURCE_DEPENDENCY_PENDING") throw error;
        }
        return message.frozen || message.imported ? storeStatus : { opened: true };
      }
      case "checkSources": {
        const checked = await store.checkSources(message.options);
        if (checked) storeStatus = checked;
        return checked;
      }
      case "sync": {
        publicationPending = true;
        if (liveReaders > 0) reportActivity("queued", "queued");
        // Cold publication pins the side database, leaving the primary WAL free during sync.
        publishedReady = (async () => {
          // Readers already admitted finish first; later readers use the pinned publication during this sync.
          await liveReadersDone;
          if (!storeStatus) return;
          const completion = completedPublication()?.token;
          const authority = store.database
            .prepare("SELECT value FROM store_meta WHERE key=?")
            .get("history_archive_event_authority")?.value;
          const segments =
            authority === undefined ? [] : store.database.prepare("SELECT segment_id FROM archive_segments").all();
          const cold = parseHistoryArchiveAuthority(authority, new Set(segments.map((row) => String(row.segment_id))))
            ?.segmentIds.length;
          if (cold) {
            const reader = await store.acquirePublishedHistoryReader();
            if (!reader)
              throw executorError(
                new Error("Published history projection is unavailable"),
                "HISTORY_PROJECTION_UNAVAILABLE",
              );
            publishedReader = {
              reader,
              status: storeStatus,
              users: 0,
              retired: false,
              completion: completion && completedPublication()?.token === completion ? completion : null,
            };
            return;
          }
          const reader = store.acquirePublishedHotReader();
          publishedReader = {
            reader,
            status: storeStatus,
            users: 0,
            retired: false,
            completion: completion && completedPublication()?.token === completion ? completion : null,
          };
        })();
        let nextStatus;
        let failure = null;
        let acquisitionStart = null;
        try {
          await publishedReady;
          publicationPending = false;
          reportActivity("running", "checking");
          completedAcquisition = null;
          const identity = store.usageProjectionDatabaseIdentity();
          if (identity && identity === store.openedUsageProjectionIdentity) {
            acquisitionStart = {
              database: store.database,
              identity,
              dataVersion: Number(store.database.prepare("PRAGMA data_version").get()?.data_version),
            };
          }
          nextStatus = await syncUsageStore(
            store,
            {
              ...message.options,
              onImportStage: (stage) => {
                reportActivity("running", stage);
                childProcess.send?.({ type: "import-stage", stage });
              },
            },
            message.certifiedOnly,
            message.sourceHints,
          );
        } catch (error) {
          failure = error;
        } finally {
          reportActivity("running", "settling");
          const readerError = releasePublishedReader();
          if (nextStatus && !failure && !readerError) {
            try {
              store.withBusinessProjection(() => store.prepareMetadataProjection());
            } catch (error) {
              failure = error;
            }
          }
          lastCheckpoint = checkpointUsageStore(store.database);
          publicationPending = false;
          publishedReady = Promise.resolve();
          if (!failure && readerError) failure = readerError;
        }
        if (failure) {
          completedAcquisition = null;
          postCheckpointDiagnostic();
          throw failure;
        }
        if (!nextStatus) return null;
        storeStatus = nextStatus;
        postState({ includeHomes: true });
        // Install after ingestion so rebuilding facts does not pay for query-only tracking.
        if (acquisitionStart && !store.usageProjectionGuard({ includeHistory: true })) {
          store.installUsageProjectionTracker();
          store.observedUsageProjectionChanges = store.usageProjectionChangeKey();
        }
        const guard = store.usageProjectionGuard({ includeHistory: true });
        if (
          acquisitionStart &&
          guard &&
          guard.database === acquisitionStart.database &&
          guard.identity === acquisitionStart.identity &&
          guard.dataVersion === acquisitionStart.dataVersion
        ) {
          completedAcquisition = {
            token: randomUUID(),
            guard,
            key: store.usageProjectionChangeKey(undefined, true),
            fingerprint: storeStatus.fingerprint,
          };
        }
        return { ...storeStatus, completion: completedAcquisition?.token ?? null };
      }
      case "validateAcquisition": {
        const receipt = completedPublication();
        if (!receipt || receipt.fingerprint !== message.fingerprint) return false;
        return message.completion ? receipt.token : true;
      }
      case "publishedUsageEvents": {
        return store.publishedUsageEvents();
      }
      case "publishedUsageHomes": {
        // source_files retains identities when events move into cold archives.
        return store.publishedUsageHomes();
      }
      case "publishedUsageReport": {
        return store.publishedHistoryUsageReport();
      }
      case "dashboard": {
        let ready;
        do {
          ready = publishedReady;
          if (publicationPending) reportActivity("queued", "queued");
          await ready;
        } while (ready !== publishedReady);
        reportActivity("running", "statistics");
        const lease = publishedReader;
        const reader = lease?.reader || store;
        const published = lease ? lease.status : storeStatus;
        const completion = lease ? lease.completion : completedPublication()?.token;
        const status = published && {
          ...published,
        };
        const filters = runtime?.filters(message.filters) ?? { ...(message.filters ?? {}) };
        if (filters.now !== undefined) filters.now = new Date(filters.now);
        if (lease) lease.users++;
        else if (liveReaders++ === 0)
          liveReadersDone = new Promise((resolve) => {
            releaseLiveReaders = resolve;
          });
        let dashboard,
          cleanupError = null;
        try {
          dashboard = await reader.dashboardHistory(filters, message.options ?? {});
        } finally {
          if (lease && --lease.users === 0 && lease.retired) {
            cleanupError = closePublishedReader(lease);
          }
          if (!lease && --liveReaders === 0) releaseLiveReaders();
        }
        if (cleanupError) throw cleanupError;
        return {
          status,
          completion: lease || completion === completedPublication()?.token ? (completion ?? null) : null,
          ...dashboard,
          metadata: { ...dashboard.metadata, calendarContext: calendarContext() },
          summary: {
            ...dashboard.summary,
            range: {
              ...dashboard.summary.range,
              timeZone: filters.calendarZone === "utc" ? "UTC" : calendarContext().timeZone,
            },
          },
          ...runtime?.dashboard(),
        };
      }
      case "summarize": {
        // Dates survive advanced serialization, but legacy callers may still send milliseconds.
        const filters = runtime?.filters(message.filters) ?? { ...(message.filters ?? {}) };
        if (filters.now !== undefined && !(filters.now instanceof Date)) filters.now = new Date(filters.now);
        return store.summarizeHistory(filters, message.options ?? {});
      }
      case "periodComparison": {
        const args = runtime?.filters(message.args) ?? { ...(message.args ?? {}) };
        if (args.now !== undefined && !(args.now instanceof Date)) args.now = new Date(args.now);
        return store.periodComparisonHistory(args);
      }
      case "metadata": {
        // Read-side instants must be evaluated by the caller's asOf, including authorized cold facts.
        return store.metadataHistory(message.asOf ? new Date(message.asOf) : new Date());
      }
      case "snapshot": {
        // User-initiated freeze runs entirely in the executor process.
        const asOf = message.asOf ? new Date(message.asOf) : new Date();
        const cleanupDirectory = `${message.databaseFile}.segments`;
        const cleanupDirectoryExisted = existsSync(cleanupDirectory);
        const databaseFileExisted = existsSync(message.databaseFile);
        let snapshotStore = null;
        let staged = false;
        try {
          await backup(store.database, path.toNamespacedPath(message.databaseFile));
          snapshotStore = createStore({ databaseFile: message.databaseFile });
          await snapshotStore.open();
          const hasSegments =
            Number(snapshotStore.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count) > 0;
          if (hasSegments) {
            // Cold readers must not depend on the live archive paths after freeze.
            const segments = await stageHistoryArchiveSegments(snapshotStore.database, cleanupDirectory);
            staged = true;
            snapshotStore.database.exec("BEGIN IMMEDIATE");
            try {
              const update = snapshotStore.database.prepare(
                "UPDATE archive_segments SET database_path = ? WHERE segment_id = ?",
              );
              for (const segment of segments.segments) {
                update.run(path.resolve(cleanupDirectory, segment.databaseFile), segment.segmentId);
              }
              snapshotStore.database.exec("COMMIT");
            } catch (error) {
              snapshotStore.database.exec("ROLLBACK");
              throw error;
            }
          }
          snapshotStore.homes = structuredClone(store.homes);
          snapshotStore.warnings = [...store.warnings];
          runtime?.copySnapshot(snapshotStore);
          const metadata = await snapshotStore.metadataHistory(asOf);
          postState({ includeHomes: true });
          return {
            status: storeStatus && {
              ...storeStatus,
            },
            asOf: asOf.getTime(),
            calendarContext: calendarContext(),
            metadata: { ...metadata, calendarContext: calendarContext() },
            homes: store.homes,
            warnings: [...store.warnings],
            ...runtime?.snapshot(),
            quotaSourceEvidenceSnapshot: store.quotaSourceEvidence
              ? quotaSourceEvidenceSnapshot(store.quotaSourceEvidence)
              : null,
            checkedAt: store.checkedAt ?? storeStatus?.checkedAt ?? null,
            ...(staged ? { cleanupDirectory } : {}),
          };
        } catch (error) {
          snapshotStore?.close();
          snapshotStore = null;
          if (staged && !cleanupDirectoryExisted) {
            await rm(cleanupDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
          }
          if (!databaseFileExisted) {
            for (const file of [message.databaseFile, `${message.databaseFile}-wal`, `${message.databaseFile}-shm`]) {
              await rm(file, { force: true, maxRetries: 10, retryDelay: 50 });
            }
          }
          throw error;
        } finally {
          snapshotStore?.close();
        }
      }
      case "backupHistory": {
        const create = (options) =>
          message.directory
            ? publishHistoryArchiveBundle(store.database, message.directory, options)
            : createHistoryBackup(store.database, message.databaseFile, options);
        const manifest = runtime ? await runtime.backup(message, create) : await create(backupOptions);
        postState({ includeHomes: true });
        return manifest;
      }
      case "rebuildHistoryRollups": {
        await store.rebuildHistoryRollups();
        postState();
        return { rebuilt: true };
      }
      case "historyArchives": {
        return readHistoryArchiveStatus(store);
      }
      case "historyArchiveDays": {
        return readHistoryArchiveDays(store, message.segmentId);
      }
      case "historyArchiveEventPage": {
        return store.readHistoryArchiveEventPage(message.segmentId, message.page);
      }
      case "historyArchiveEventCommit": {
        const result = await store.commitHistoryArchiveEvents(message.plan);
        postState();
        return result;
      }
      case "historyArchiveImport": {
        const imported = await publishHistoryArchiveImport(message.sourceDirectory, message.importDirectory);
        return {
          runtimeFile: imported.runtimeFile,
          bundleDirectory: imported.bundleDirectory,
          markerFile: imported.markerFile,
          marker: imported.marker,
        };
      }
      case "close": {
        runtime?.close();
        store.close();
        return { closed: true };
      }
      default:
        if (runtime) return runtime.handle(message);
        throw executorError(new Error(`unsupported executor message: ${String(message.type)}`), "EXECUTOR_BAD_MESSAGE");
    }
  };

  const executeMessage = async (message) => {
    if (stopping) return;
    if (message.type === "idleClose") {
      await shutdown({ notifyIdle: true });
      return;
    }
    let activityState = "queued";
    let activityStage = "queued";
    const reportActivity = (state, phase) => {
      if (!message.activityContext || (state === activityState && phase === activityStage)) return;
      activityState = state;
      activityStage = phase;
      void send({ type: "activity", id: message.id, state, phase }).catch(() => {});
    };
    active += 1;
    try {
      await store.open();
      const execute = async () => {
        reportActivity("running", activityPhase(message.type));
        const work = () =>
          runtime ? runtime.run(message, () => handle(message, reportActivity)) : handle(message, reportActivity);
        if (message.type === "sync") {
          await releaseHistoryVerification();
          const scope = await store.createHistoryVerificationScope();
          if (!scope) return work();
          try {
            const result = await scope.run(work);
            if (result && Number.isSafeInteger(message.historyVerification)) {
              const pending = { scope, token: message.historyVerification, timer: null };
              pending.timer = setTimeout(() => {
                if (pendingHistoryVerification === pending) void releaseHistoryVerification();
              }, REQUEST_TIMEOUT_MS);
              pending.timer.unref?.();
              pendingHistoryVerification = pending;
            } else await scope.close();
            return result;
          } catch (error) {
            await scope.close();
            throw error;
          }
        }
        if (message.type === "releaseHistoryVerification") {
          if (pendingHistoryVerification?.token === message.historyVerification) await releaseHistoryVerification();
          return null;
        }
        if (message.type === "dashboard") {
          const pending = pendingHistoryVerification;
          if (pending && pending.token === message.historyVerification) {
            pendingHistoryVerification = null;
            clearTimeout(pending.timer);
            try {
              return await pending.scope.run(work);
            } finally {
              await pending.scope.close();
            }
          }
          return store.withHistoryVerification(work);
        }
        if (
          ["historyArchiveEventCommit", "historyArchiveImport", "snapshot", "backupHistory", "close"].includes(
            message.type,
          )
        )
          await releaseHistoryVerification();
        return work();
      };
      const result =
        message.type === "sync" ||
        message.type === "checkSources" ||
        message.type === "backupHistory" ||
        message.type === "snapshot" ||
        message.type === "rebuildHistoryRollups" ||
        message.type === "historyArchiveDays" ||
        message.type === "historyArchiveEventPage" ||
        message.type === "historyArchiveEventCommit" ||
        message.type === "historyArchiveImport" ||
        message.type === "publishedUsageEvents" ||
        message.type === "publishedUsageHomes" ||
        message.type === "publishedUsageReport" ||
        runtime?.serial(message.type) ||
        message.type === "close"
          ? await serializeSyncBackup(execute)
          : await execute();
      await send({
        type: "response",
        id: message.id,
        ok: true,
        result: toWire(result),
        ...(message.type === "sync" ? { historyVerification: pendingHistoryVerification?.token ?? null } : {}),
      });
      if (message.type === "close") await shutdown();
    } catch (error) {
      try {
        await send({
          type: "response",
          id: message.id,
          ok: false,
          error: {
            message: error?.message ?? String(error),
            code: error?.code ?? "EXECUTOR_ERROR",
            errcode: error?.errcode,
            statusCode: error?.statusCode ?? null,
            quota: toWire(error?.quota ?? null),
          },
        });
      } catch {
        await shutdown();
      }
    } finally {
      active = Math.max(0, active - 1);
    }
  };

  const initialize = async () => {
    if (initializing) return;
    const initIndex = queued.findIndex((message) => message.type === "init");
    if (initIndex < 0) return;
    initializing = true;
    const [init] = queued.splice(initIndex, 1);
    try {
      store = createStore(init.options);
      runtime = createRuntime?.(store, send);
      restoreExecutorLightState(store, init.state);
      runtime?.restoreState(init.state);
      await store.open();
      await runtime?.initialize(
        init.options,
        queued.find((message) => message.type === "open"),
      );
      storeStatus = init.state?.status ?? null;
      lastCheckpoint = init.state?.lastCheckpoint ?? null;
      initialized = true;
      await send({ type: "ready" });
      const batch = queued.splice(0);
      for (const message of batch) void executeMessage(message);
    } catch (error) {
      try {
        await send({
          type: "fatal",
          error: {
            message: error?.message ?? String(error),
            code: error?.code ?? "EXECUTOR_ERROR",
            errcode: error?.errcode,
          },
        });
      } catch {
        // Parent disconnected while starting.
      }
      await shutdown();
    }
  };

  childProcess.on("message", (message) => {
    if (!initialized) {
      queued.push(message);
      void initialize();
      return;
    }
    void executeMessage(message);
  });
  childProcess.once("disconnect", () => {
    void shutdown({ waitForActive: true });
  });
  childProcess.once("SIGTERM", () => {
    void shutdown({ waitForActive: true });
  });
  childProcess.once("SIGINT", () => {
    void shutdown({ waitForActive: true });
  });
}
