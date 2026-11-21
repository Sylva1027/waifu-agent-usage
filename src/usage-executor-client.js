import { AsyncLocalStorage } from "node:async_hooks";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { calendarContext } from "./calendar-context.js";
import { isSqliteBusy } from "./sqlite-busy.js";
import { activityKind, executorError, toWire } from "./usage-executor-protocol.js";

const REQUEST_TIMEOUT_MS = 900_000;
const IDLE_TIMEOUT_MS = 200;
const CLOSE_TIMEOUT_MS = 5_000;
const EXECUTOR_CHILD_ENV = "CODEX_USAGE_EXECUTOR_CHILD";
const EXECUTOR_CHILD_MARKER = "1";
const EXECUTOR_EXEC_ARGV = ["--max-old-space-size=224", "--max-semi-space-size=4"];

/** 只丢掉函数（`onShutdown` 等）与其他不可克隆值，其余选项**原样**转发给执行器。 */
function executorOptions(options = {}) {
  const forwarded = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === "executorIdleTimeoutMs") continue;
    if (typeof value === "function") continue;
    try {
      structuredClone(value);
      forwarded[key] = value;
    } catch {
      // 不可结构化克隆（函数/句柄等）⇒ 不转发（执行器不需要，也不能跨线程共享）。
    }
  }
  return forwarded;
}

/**
 * 把**任意**请求载荷变成可 `postMessage` 的形状：先试 structured clone（保类实例），
 * 失败才深拷贝并**只丢函数**。`sync` 的 `options` 里可能带 `schedulePricingDiscovery`/
 * `cancelPricingDiscovery` 这类注入桩（测试/CLI 用），它们过不了 structured clone。
 */
function toTransferable(value) {
  try {
    structuredClone(value);
    return value;
  } catch {
    if (typeof value === "function") return undefined;
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value;
    if (Array.isArray(value)) {
      return value.map((item) => toTransferable(item)).filter((item) => item !== undefined);
    }
    const forwarded = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toTransferable(item);
      if (converted !== undefined) forwarded[key] = converted;
    }
    return forwarded;
  }
}

/**
 * @param {any} [options]
 * @param {{workerFile?: string | URL, requestTimeoutMs?: number, idleTimeoutMs?: number,
 * workerOptions?: () => any, requestContext?: (type: string) => any,
 * serialize?: (type: string, value: any) => any, deserialize?: (type: string, value: any) => any,
 * onState?: (value: any) => any, hasActivity?: (type: string) => boolean,
 * onImportStage?: (stage: any) => void, onActivity?: (activity: any) => void}} [configuration]
 */
export function createUsageExecutorClient(
  options = {},
  {
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    idleTimeoutMs = options.executorIdleTimeoutMs ?? IDLE_TIMEOUT_MS,
    workerFile,
    workerOptions = () => options,
    requestContext = (_type) => ({}),
    serialize = (_type, value) => value,
    deserialize = (_type, value) => value,
    onState = (value) => value,
    hasActivity = (_type) => true,
    onImportStage = (_stage) => {},
    onActivity = (_activity) => {},
  } = {},
) {
  if (!workerFile) throw new TypeError("An executor worker entry is required");
  const idleDelayMs =
    Number.isFinite(idleTimeoutMs) && idleTimeoutMs >= 0 ? Math.floor(idleTimeoutMs) : IDLE_TIMEOUT_MS;
  const emptyState = () => ({
    status: null,
    metadata: null,
    homes: null,
    warnings: [],
    quotaSourceEvidenceSnapshot: null,
    checkedAt: null,
    lastCheckpoint: null,
  });
  /** @type {import("node:child_process").ChildProcess | null} */
  let worker = null;
  let workerTimeZone = null;
  let fixedCalendarTimeZone = options.calendarTimeZone;
  let dispatchTail = Promise.resolve();
  const inFlight = new Set();
  let exitResolve = null;
  let exitPromise = Promise.resolve();
  let idleTimer = null;
  let retained = 0;
  let idleRetiring = false;
  let terminating = false;
  let expectedExit = false;
  let restartPending = false;
  let childFatalError = null;
  let nextId = 1;
  const pending = new Map();
  const activityStorage = new AsyncLocalStorage();
  let generation = null;
  let nextGeneration = randomUUID();

  const reportActivity = (activity, state, phase = activity?.phase, error = null) => {
    if (!activity || (activity.state === state && activity.phase === phase)) return;
    activity.state = state;
    activity.phase = phase;
    try {
      void Promise.resolve(
        onActivity({
          ...activity,
          ...(error
            ? { error: { code: error.code ?? "EXECUTOR_ERROR", message: error.message ?? String(error) } }
            : {}),
        }),
      ).catch(() => {});
    } catch {
      // Observers must not change execution or request settlement.
    }
  };
  /** 用户已显式 `close()` ⇒ **永久**不可用（不再重启）。 */
  let closed = false;
  /** 正在 `close()`（幂等；期间不重启）。 */
  let closing = false;
  let closePromise = null;
  let ready = false;
  /** 硬崩溃后的**就地重启**次数（一次重启 = 一次恢复；不做无限重试）。 */
  let restarts = 0;
  let state = emptyState();
  let nextHistoryVerification = 0;
  let pendingHistoryVerification = null;

  const unavailableError = (message = "usage executor is not available") =>
    executorError(new Error(message), "EXECUTOR_UNAVAILABLE");

  const rejectAll = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const clearIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const stateSnapshot = () => toWire(serialize("state", state));

  const restoreState = (snapshot = {}) => {
    const record = snapshot?.state && typeof snapshot.state === "object" ? snapshot.state : snapshot;
    if (!record || typeof record !== "object") return;
    const restored = deserialize("state", structuredClone(record));
    state = {
      ...emptyState(),
      ...restored,
      homes: restored.homes ?? null,
      warnings: [...(restored.warnings ?? [])],
      quotaSourceEvidenceSnapshot: restored.quotaSourceEvidenceSnapshot ?? null,
    };
  };

  const lightStateForChild = () => stateSnapshot();

  const terminateChild = (target) => {
    if (worker !== target) return exitPromise;
    clearIdleTimer();
    if (!terminating) {
      terminating = true;
      idleRetiring = false;
      expectedExit = false;
      try {
        target.kill("SIGKILL");
      } catch {
        // The exit event below remains the source of truth.
      }
    }
    return exitPromise;
  };

  const scheduleIdle = () => {
    clearIdleTimer();
    if (closed || closing || !worker || !ready || pending.size > 0 || retained > 0 || terminating || idleRetiring)
      return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      const target = worker;
      if (closed || closing || !target || !ready || pending.size > 0 || retained > 0 || terminating || idleRetiring) {
        return;
      }
      idleRetiring = true;
      expectedExit = false;
      try {
        target.send({ type: "idleClose" }, (error) => {
          if (!error || worker !== target) return;
          expectedExit = false;
          void terminateChild(target);
        });
      } catch {
        expectedExit = false;
        void terminateChild(target);
      }
    }, idleDelayMs);
    idleTimer.unref?.();
  };

  /**
   * 拉起执行器进程（首次、空闲恢复与崩溃重启共用）。空闲退出保留已发布状态；
   * 真实崩溃在 exit 时清空状态，下一个请求只做一次就地恢复。
   */
  function spawn(timeZone) {
    if (worker) return worker;
    ready = false;
    idleRetiring = false;
    terminating = false;
    expectedExit = false;
    childFatalError = null;
    exitPromise = new Promise((resolve) => {
      exitResolve = resolve;
    });
    const created = fork(workerFile, [], {
      env: { ...process.env, TZ: timeZone, [EXECUTOR_CHILD_ENV]: EXECUTOR_CHILD_MARKER },
      execArgv: [...process.execArgv, ...EXECUTOR_EXEC_ARGV],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    worker = created;
    workerTimeZone = timeZone;
    generation = nextGeneration;
    nextGeneration = randomUUID();
    let finalized = false;
    const finalize = () => {
      if (finalized || worker !== created) return;
      finalized = true;
      worker = null;
      pendingHistoryVerification = null;
      ready = false;
      clearIdleTimer();
      const preserveState = expectedExit || closing || closed;
      idleRetiring = false;
      terminating = false;
      expectedExit = false;
      exitResolve?.();
      exitResolve = null;
      rejectAll(childFatalError ?? executorError(new Error("usage executor exited"), "EXECUTOR_EXITED"));
      if (!preserveState) {
        state = emptyState();
        restartPending = true;
      }
    };
    created.on("message", (rawMessage) => {
      if (worker !== created) return;
      const message = /** @type {any} */ (rawMessage);
      if (message.type === "activity") {
        const entry = pending.get(message.id);
        if (entry) reportActivity(entry.activity, message.state, message.phase);
        return;
      }
      if (message.type === "import-stage") {
        onImportStage(message.stage);
        return;
      }
      if (message.type === "state") {
        state = { ...state, ...deserialize("state", onState(message.state)) };
        return;
      }
      if (message.type === "ready") {
        ready = true;
        scheduleIdle();
        return;
      }
      if (message.type === "idle-exit") {
        idleRetiring = true;
        expectedExit = true;
        return;
      }
      if (message.type === "fatal") {
        childFatalError = executorError(message.error, message.error?.code);
        rejectAll(childFatalError);
        void terminateChild(created);
        return;
      }
      if (message.type === "response") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (entry.type === "sync" && message.historyVerification === nextHistoryVerification)
          pendingHistoryVerification = message.historyVerification;
        if (message.ok) {
          entry.resolve(deserialize(entry.type, message.result));
        } else entry.reject(executorError(message.error, message.error?.code));
        scheduleIdle();
      }
    });
    created.on("error", (error) => {
      if (worker !== created) return;
      childFatalError = executorError(error, "EXECUTOR_EXITED");
      rejectAll(childFatalError);
      void terminateChild(created);
    });
    created.once("exit", finalize);
    created.once("close", finalize);
    created.send(
      {
        type: "init",
        options: executorOptions(workerOptions()),
        state: lightStateForChild(),
      },
      (error) => {
        if (!error || worker !== created) return;
        childFatalError = executorError(error, "EXECUTOR_EXITED");
        rejectAll(childFatalError);
        void terminateChild(created);
      },
    );
    return created;
  }

  const killOnParentExit = () => {
    try {
      worker?.kill("SIGKILL");
    } catch {
      // Best-effort on process shutdown; the child also exits on IPC disconnect.
    }
  };
  process.once("exit", killOnParentExit);

  const ensureChild = async ({
    allowClosing = false,
    allowSpawn = true,
    timeZone = calendarContext().timeZone,
  } = {}) => {
    if (closed || (closing && !allowClosing)) throw unavailableError();
    if (worker && (terminating || idleRetiring)) await exitPromise;
    if (worker && workerTimeZone !== timeZone && allowSpawn) {
      // Drain the old calendar before replacing its process and every local-date cache.
      await Promise.allSettled([...inFlight]);
      if (worker) {
        idleRetiring = true;
        const target = worker;
        try {
          target.send({ type: "idleClose" }, (error) => {
            if (error && worker === target) void terminateChild(target);
          });
        } catch {
          void terminateChild(target);
        }
        await exitPromise;
      }
    }
    if (closed || (closing && !allowClosing)) throw unavailableError();
    if (!worker) {
      if (!allowSpawn) throw unavailableError();
      if (restartPending) {
        restarts += 1;
        restartPending = false;
      }
      try {
        spawn(timeZone);
      } catch (error) {
        if (worker) void terminateChild(worker);
        restartPending = true;
        state = emptyState();
        throw executorError(error, "EXECUTOR_UNAVAILABLE");
      }
    }
    return worker;
  };

  const request = async (
    type,
    payload = {},
    { allowClosing = false, allowSpawn = true, timeoutMs = requestTimeoutMs } = {},
  ) => {
    if (closed || (closing && !allowClosing)) throw unavailableError();
    clearIdleTimer();
    const id = nextId++;
    const context = activityStorage.getStore();
    const activity =
      type === "close" || type === "releaseHistoryVerification" || !hasActivity(type)
        ? null
        : {
            id: `executor:${worker && !terminating && !idleRetiring ? generation : nextGeneration}:${id}`,
            requestId: context?.requestId ?? null,
            shared: context?.shared === true,
            kind: context?.kind ?? activityKind(type),
            state: null,
            phase: "queued",
          };
    reportActivity(activity, "queued");
    try {
      const acceptedContext = requestContext(type);
      const timeZone = calendarContext(fixedCalendarTimeZone || payload.filters?.calendarContext?.timeZone).timeZone;
      /** @type {Promise<any>} */
      let completion;
      const dispatched = dispatchTail.then(async () => {
        const target = await ensureChild({ allowClosing: true, allowSpawn, timeZone });
        completion = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            reject(executorError(new Error(`usage executor request timed out: ${type}`), "EXECUTOR_TIMEOUT"));
            void terminateChild(target);
          }, timeoutMs);
          timer.unref?.();
          pending.set(id, { resolve, reject, timer, type, activity });
          try {
            target.send(
              {
                ...toTransferable(
                  serialize(type, {
                    type,
                    id,
                    ...payload,
                    ...acceptedContext,
                    activityContext: activity && {
                      requestId: activity.requestId,
                      shared: activity.shared,
                      kind: activity.kind,
                    },
                  }),
                ),
              },
              (error) => {
                if (!error || !pending.has(id)) return;
                const entry = pending.get(id);
                pending.delete(id);
                clearTimeout(entry.timer);
                entry.reject(executorError(error, "EXECUTOR_UNAVAILABLE"));
                void terminateChild(target);
              },
            );
          } catch (error) {
            pending.delete(id);
            clearTimeout(timer);
            reject(executorError(error, "EXECUTOR_UNAVAILABLE"));
            void terminateChild(target);
          }
        });
        inFlight.add(completion);
        void completion.finally(() => inFlight.delete(completion)).catch(() => {});
      });
      dispatchTail = dispatched.catch(() => {});
      await dispatched;
      const result = await completion;
      reportActivity(activity, "done");
      return result;
    } catch (error) {
      const failure =
        isSqliteBusy(error) && ["sync", "check", "statistics"].includes(context?.kind)
          ? executorError({ message: "Source update is still pending", statusCode: 409 }, "SOURCE_UPDATE_PENDING")
          : error;
      reportActivity(activity, "failed", activity?.phase, failure);
      throw failure;
    }
  };

  return {
    request,
    runWithActivity: (context, action) => activityStorage.run(context, action),
    // —— 阻塞工作（消息） ——
    retainWorker: () => {
      retained += 1;
      clearIdleTimer();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained -= 1;
        scheduleIdle();
      };
    },
    open: (payload = {}) => {
      if (payload.frozen) {
        fixedCalendarTimeZone ||=
          payload.frozen.calendarContext?.timeZone ||
          payload.frozen.metadata?.calendarContext?.timeZone ||
          calendarContext().timeZone;
      }
      return request("open", payload);
    },
    sync: (payload = {}) => {
      const historyVerification = ++nextHistoryVerification;
      pendingHistoryVerification = null;
      return request("sync", {
        options: payload.options,
        certifiedOnly: payload.certifiedOnly,
        sourceHints: payload.sourceHints,
        historyVerification,
      });
    },
    checkSources: (options) => request("checkSources", { options }),
    validateAcquisition: async (fingerprint, { completion = false } = {}) => {
      if (!worker || idleRetiring || terminating) return false;
      try {
        return await request("validateAcquisition", { fingerprint, completion }, { allowSpawn: false });
      } catch {
        return false;
      }
    },
    summarize: (filters = {}, summarizeOptions = {}) => request("summarize", { filters, options: summarizeOptions }),
    dashboard: (filters = {}, summarizeOptions = {}) => {
      const historyVerification = pendingHistoryVerification;
      pendingHistoryVerification = null;
      return request("dashboard", { filters, options: summarizeOptions, historyVerification });
    },
    releaseHistoryVerification: async () => {
      const historyVerification = pendingHistoryVerification;
      pendingHistoryVerification = null;
      if (historyVerification === null || !worker || idleRetiring || terminating) return;
      try {
        await request("releaseHistoryVerification", { historyVerification }, { allowSpawn: false });
      } catch {
        // Process exit has already released its package read locks.
      }
    },
    periodComparison: (args = {}) => request("periodComparison", { args }),
    metadataFor: (asOf) => request("metadata", { asOf: asOf instanceof Date ? asOf.getTime() : asOf }),
    publishedUsageEvents: () => request("publishedUsageEvents"),
    publishedUsageHomes: () => request("publishedUsageHomes"),
    publishedUsageReport: () => request("publishedUsageReport"),
    snapshot: (payload = {}) => request("snapshot", { ...payload }),
    backupHistory: (databaseFile) => request("backupHistory", { databaseFile }),
    backupHistoryBundle: (directory) => request("backupHistory", { directory }),
    rebuildHistoryRollups: () => request("rebuildHistoryRollups"),
    historyArchives: () => request("historyArchives"),
    historyArchiveDays: (segmentId) => request("historyArchiveDays", { segmentId }),
    /** @param {string} segmentId @param {{startMs: number, endMs: number, afterId?: number, limit?: number}} page */
    historyArchiveEventPage: (segmentId, page) => request("historyArchiveEventPage", { segmentId, page }),
    /** @param {Record<string, any>} plan */
    commitHistoryArchiveEvents: (plan) => request("historyArchiveEventCommit", { plan }),
    /** @param {{ sourceDirectory?: string, importDirectory?: string }} [payload] */
    historyArchiveImport: ({ sourceDirectory, importDirectory } = {}) =>
      request("historyArchiveImport", { sourceDirectory, importDirectory }),
    close: () => {
      // 幂等：多次 `close()` 共享同一个 promise；`close()` 之后**永不**重启。
      if (closePromise) return closePromise;
      closing = true;
      clearIdleTimer();
      closePromise = (async () => {
        // Requests accepted before close keep their place at the calendar boundary.
        await dispatchTail;
        let drainTimer;
        const drained = await Promise.race([
          Promise.allSettled([...inFlight]).then(() => true),
          new Promise((resolve) => {
            drainTimer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
            drainTimer.unref?.();
          }),
        ]).finally(() => clearTimeout(drainTimer));
        if (!drained && worker) await terminateChild(worker);
        if (worker && !terminating) {
          await request("close", {}, { allowClosing: true, allowSpawn: false, timeoutMs: CLOSE_TIMEOUT_MS }).catch(
            () => {},
          );
        }
        if (worker) {
          const target = worker;
          const exited = await Promise.race([
            exitPromise.then(() => true),
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
          if (!exited && worker === target) {
            await terminateChild(target);
            await Promise.race([
              exitPromise,
              new Promise((resolve) => {
                const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
                timer.unref?.();
              }),
            ]);
          }
        }
        closed = true;
        ready = false;
        process.removeListener("exit", killOnParentExit);
        rejectAll(executorError(new Error("usage executor closed"), "EXECUTOR_CLOSED"));
      })();
      return closePromise;
    },
    restoreState,
    stateSnapshot,
    stateValue: (key) => state[key],
    /**
     * **仅故障注入/诊断**：强制终止当前执行器进程（模拟硬崩溃，例如外部 kill 或进程内致命错误）。
     * 产品路径不需要它；它让"崩溃→在途可重试→下一个请求恢复"可被确定性测试。
     */
    crashWorkerForTest: async () => {
      await dispatchTail;
      const target = worker;
      if (!target) return false;
      await terminateChild(target);
      return true;
    },
    // —— 读侧快照（主线程就地应答；不碰库） ——
    get status() {
      return state.status;
    },
    get checkedAt() {
      return state.checkedAt;
    },
    get lastCheckpoint() {
      return state.lastCheckpoint;
    },
    get homes() {
      return state.homes ?? [];
    },
    get warnings() {
      return state.warnings ?? [];
    },
    get quotaSourceEvidenceSnapshot() {
      return state.quotaSourceEvidenceSnapshot;
    },
    get ready() {
      return ready;
    },
    /** 执行器进程是否**活着**（空闲退出或崩溃后未重启 ⇒ false；`close()` 后 ⇒ false）。 */
    get alive() {
      return Boolean(worker) && !closed && worker.exitCode === null && worker.signalCode === null;
    },
    get pid() {
      return worker?.pid ?? null;
    },
    /** 崩溃就地重启次数（0 = 未发生过硬崩溃）。 */
    get restarts() {
      return restarts;
    },
    metadata: () => state.metadata,
    get state() {
      return stateSnapshot();
    },
  };
}
