import { calendarContext } from "../calendar-context.js";
import { buildUsagePricingCoverage } from "../../public/pricing-models.js";
import { AUTO_RETRY_INTERVAL_MS } from "../pricing-auto.js";
import {
  getPricingCatalog,
  runWithPricingCatalog,
  runWithoutPricingCatalog,
  validatePricingCatalog,
} from "../pricing.js";
import {
  getAutomaticPricingStatus,
  loadPricingFile,
  MAX_PRICING_MODELS,
  refreshAutomaticPricing,
  savePricingFile,
} from "../pricing-store.js";
const PRICING_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export function createWaifuServerFeatures(options, context) {
  const importContext = options.importContext ?? null;
  const { usageOptions, runActivity, loadUsageStore, writeUsageEvent, sendJson, httpError, readJsonBody } = context;

  const localPricingCatalog = () => importContext?.pricingCatalog || getPricingCatalog();
  const liveAutomaticPricingStatus = () =>
    importContext ? (importContext.automaticPricingStatus ?? null) : getAutomaticPricingStatus();
  let achievementsEnabled = false;
  let achievementStartup = null;
  let initialAchievementUpdate = null;
  let needsHistoryBackfill = false;
  let usageAcquired = false;
  let achievementUpdatePromise = null;
  let achievementUpdateRequested = false;
  let releaseAchievementWorker = null;
  async function startAchievements() {
    if (importContext || options.achievementsEnabled === false || context.serverClosed) return;
    const edition = "waifu";
    if (edition !== "waifu" || context.serverClosed) return;
    const zone = options.achievementTimeZone || calendarContext().timeZone;
    releaseAchievementWorker = context.usageStore.retainWorker();
    await pricingReady;
    const sourceOptions = await usageOptions();
    const snapshot = await context.usageStore.achievementStart({
      edition: "waifu",
      timeZone: zone,
      sourceHomes: sourceOptions.confirmedSources,
      ...(options.databaseFile === ":memory:" ? { databaseFile: ":memory:" } : {}),
      ...(options.achievementDatabaseFile ? { databaseFile: options.achievementDatabaseFile } : {}),
    });
    needsHistoryBackfill = snapshot?.needsHistoryBackfill === true;
    achievementsEnabled = true;
  }
  function onUsageAcquired() {
    usageAcquired = true;
    scheduleAchievementUpdate();
  }
  function scheduleAchievementUpdate() {
    if (!achievementsEnabled || context.serverClosed) return;
    achievementUpdateRequested = true;
    if (achievementUpdatePromise) return;
    achievementUpdatePromise = (async () => {
      while (achievementUpdateRequested && !context.serverClosed) {
        achievementUpdateRequested = false;
        const result = await context.usageStore.achievementUpdate();
        if (result?.pendingCatchUp) achievementUpdateRequested = true;
      }
    })()
      .catch(() => {
        // The executor publishes the error alongside the last complete snapshot; the next task retries.
      })
      .finally(() => {
        achievementUpdatePromise = null;
      });
  }
  async function shareReceipt(summary, filters) {
    if (!achievementsEnabled) return null;
    const range = Object.fromEntries(
      ["preset", "startDate", "endDate", "recentValue", "excludeHomes", "calendarZone"].map((key) => [
        key,
        filters[key],
      ]),
    );
    try {
      return await context.usageStore.achievementShareReceipt(summary, range);
    } catch {
      return null;
    }
  }
  const pricingReady = importContext ? Promise.resolve() : loadPricingFile(options);
  const pricingRefreshSchedulerEnabled = !importContext && options.pricingRefreshSchedulerEnabled !== false;
  let pricingRefreshPromise = null;
  let pricingRefreshOptions = null;
  let pricingRefreshPending = null;
  let pricingMutationTail = Promise.resolve();
  let pricingRefreshTimer = null;
  let discoveryTimer = null;
  let discoveryTimerSignature = null;
  let activeDiscoverySignature = null;
  let lastAchievementState = null;

  function usedModelNames(value) {
    const groups = Array.isArray(value)
      ? [value]
      : value && typeof value === "object"
        ? Object.values(value).filter(Array.isArray)
        : [];
    return [
      ...new Set(
        groups
          .flat()
          .map((model) => String(model ?? "").trim())
          .filter(Boolean),
      ),
    ].sort();
  }

  function mergeRefreshOptions(left, right) {
    return {
      force: left.force === true || right.force === true,
      discoveryReady: left.discoveryReady !== false || right.discoveryReady !== false,
      automaticDiscoveryEnabled: options.automaticDiscoveryEnabled !== false,
      usedModels: [...new Set([...usedModelNames(left.usedModels), ...usedModelNames(right.usedModels)])].sort(),
    };
  }

  function runPricingMutation(task) {
    const result = pricingMutationTail.then(() => runActivity("pricing", "pricing", task));
    pricingMutationTail = result.catch(() => {});
    return result;
  }

  function requestPricingRefresh(refreshOptions) {
    const normalized = {
      ...refreshOptions,
      automaticDiscoveryEnabled: options.automaticDiscoveryEnabled !== false,
    };
    if (!pricingRefreshPromise) {
      pricingRefreshOptions = normalized;
      pricingRefreshPromise = runPricingMutation(() => refreshAutomaticPricing({ ...options, ...normalized })).finally(
        () => {
          pricingRefreshPromise = null;
          pricingRefreshOptions = null;
        },
      );
      return pricingRefreshPromise;
    }

    const activeOptions = pricingRefreshOptions || {};
    const changedCandidates =
      JSON.stringify(usedModelNames(activeOptions.usedModels)) !==
      JSON.stringify(usedModelNames(normalized.usedModels));
    if (normalized.force || changedCandidates) {
      pricingRefreshPending = pricingRefreshPending
        ? mergeRefreshOptions(pricingRefreshPending, normalized)
        : mergeRefreshOptions(activeOptions, normalized);
      const active = pricingRefreshPromise;
      return active.then((result) => {
        const pending = pricingRefreshPending;
        if (!pending) return result;
        pricingRefreshPending = null;
        return requestPricingRefresh(pending);
      });
    }
    return pricingRefreshPromise;
  }

  function requestTargetedPricingRefresh(model) {
    return runPricingMutation(() =>
      refreshAutomaticPricing({
        ...options,
        model,
        force: false,
        discoveryReady: true,
        automaticDiscoveryEnabled: options.automaticDiscoveryEnabled !== false,
      }),
    );
  }

  function clearPricingRefreshTimer() {
    if (pricingRefreshTimer === null) return;
    (options.cancelPricingRefresh || clearTimeout)(pricingRefreshTimer);
    pricingRefreshTimer = null;
  }

  function schedulePricingRefreshCheck() {
    if (context.serverClosed || !pricingRefreshSchedulerEnabled) return;
    const schedule = options.schedulePricingRefresh || setTimeout;
    pricingRefreshTimer = schedule(() => {
      pricingRefreshTimer = null;
      void runPricingRefreshCheck();
    }, PRICING_REFRESH_INTERVAL_MS);
    pricingRefreshTimer?.unref?.();
  }

  async function runPricingRefreshCheck() {
    if (context.serverClosed || !pricingRefreshSchedulerEnabled) return;
    try {
      await runWithoutPricingCatalog(() => {
        const now = options.pricingRefreshNow;
        const discoveryReady = context.storeStatus !== null;
        return requestPricingRefresh({
          force: false,
          discoveryReady,
          ...(discoveryReady ? { usedModels: context.usageStore.metadata().harnessModels } : {}),
          ...(now === undefined ? {} : { now: typeof now === "function" ? now() : now }),
        });
      });
    } catch {
      // The next hourly check retries a background source or disk failure.
    } finally {
      schedulePricingRefreshCheck();
    }
  }

  function clearDiscoveryTimer() {
    if (discoveryTimer === null) return;
    (options.cancelPricingDiscovery || clearTimeout)(discoveryTimer);
    discoveryTimer = null;
    discoveryTimerSignature = null;
  }

  function scheduleUsageDiscovery(harnessModels) {
    if (context.serverClosed || options.automaticDiscoveryEnabled === false || context.storeStatus === null) return;
    const missing = buildUsagePricingCoverage(harnessModels, getPricingCatalog().models, true)
      .missingUsedModels.map((item) => item.model.toLowerCase())
      .sort();
    if (!missing.length) {
      clearDiscoveryTimer();
      return;
    }
    const nowValue =
      typeof options.pricingDiscoveryNow === "function"
        ? options.pricingDiscoveryNow()
        : options.pricingDiscoveryNow || new Date();
    const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
    const status = getAutomaticPricingStatus();
    const attemptedAt = status.discoveryAttemptedAt || {};
    const resultsByModel = new Map((status.discoveryResults || []).map((result) => [result.model, result]));
    const dueModels = missing.filter((model) => {
      const key = model.toLowerCase();
      const result = resultsByModel.get(key);
      if (result) {
        if (!result.retryable) return false;
        const retryAt = Date.parse(result.nextRetryAt || "");
        return Number.isFinite(retryAt) && (!Number.isFinite(nowMs) || nowMs >= retryAt);
      }
      const lastAttempt = Date.parse(attemptedAt[key] || "");
      return !Number.isFinite(lastAttempt) || !Number.isFinite(nowMs) || nowMs - lastAttempt >= AUTO_RETRY_INTERVAL_MS;
    });
    if (!dueModels.length) {
      clearDiscoveryTimer();
      return;
    }

    const signature = JSON.stringify(dueModels);
    if (signature === activeDiscoverySignature || signature === discoveryTimerSignature) return;
    clearDiscoveryTimer();
    discoveryTimerSignature = signature;
    const schedule = options.schedulePricingDiscovery || setTimeout;
    discoveryTimer = schedule(
      () =>
        runWithoutPricingCatalog(async () => {
          discoveryTimer = null;
          discoveryTimerSignature = null;
          if (context.serverClosed || context.storeStatus === null) return;
          activeDiscoverySignature = signature;
          try {
            const models = context.usageStore.metadata().harnessModels;
            await requestPricingRefresh({ force: false, usedModels: models, discoveryReady: true });
          } catch {
            // A background source or disk failure is returned by the pricing API on its next explicit refresh.
          } finally {
            activeDiscoverySignature = null;
            if (!context.serverClosed && context.storeStatus !== null)
              scheduleUsageDiscovery(context.usageStore.metadata().harnessModels);
          }
        }),
      options.pricingDiscoveryDelayMs ?? 1_000,
    );
    discoveryTimer?.unref?.();
  }

  function usagePricingCoverage(metadata = undefined, catalog = localPricingCatalog()) {
    if (context.storeStatus === null && !metadata) return buildUsagePricingCoverage(null, catalog.models, false);
    return buildUsagePricingCoverage(
      (metadata || context.usageStore.metadata()).activeHarnessModels,
      catalog.models,
      true,
    );
  }

  function broadcastAchievementState(snapshot) {
    if (!snapshot || context.serverClosed) return;
    const data = Object.fromEntries(
      ["profileId", "state", "progressRevision", "awardRevision", "seenAwardRevision"].map((key) => [
        key,
        snapshot[key],
      ]),
    );
    const version = JSON.stringify(data);
    if (version === lastAchievementState) return;
    lastAchievementState = version;
    for (const response of [...context.usageEventClients]) writeUsageEvent(response, "achievement-state", data);
  }
  async function handleRequest(request, response, url) {
    if (url.pathname.startsWith("/api/achievements")) {
      await achievementStartup;
      if (!achievementsEnabled) {
        sendJson(response, 404, { error: "Not found" });
        return true;
      }
      if (url.pathname === "/api/achievements" && request.method === "GET") {
        const snapshot = context.usageStore.achievementSnapshot();
        if (!snapshot) throw httpError(503, "Achievement archive is not ready", "ACHIEVEMENT_UNAVAILABLE");
        sendJson(response, 200, snapshot);
        return true;
      }
      if (
        request.method !== "POST" ||
        !["/api/achievements/seen", "/api/achievements/operations"].includes(url.pathname)
      ) {
        sendJson(response, 404, { error: "Not found" });
        return true;
      }
      const body = await readJsonBody(request, { mediaTypeCode: "ACHIEVEMENT_JSON_REQUIRED" });
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw httpError(400, "Invalid achievement request", "ACHIEVEMENT_INVALID_REQUEST");
      let result;
      if (url.pathname.endsWith("/seen")) {
        if (
          Object.keys(body).some((key) => !["profileId", "seenThroughRevision"].includes(key)) ||
          typeof body.profileId !== "string" ||
          !Number.isSafeInteger(body.seenThroughRevision) ||
          body.seenThroughRevision < 0
        )
          throw httpError(400, "Invalid seen revision", "ACHIEVEMENT_INVALID_REQUEST");
        result = await context.usageStore.achievementSeen(body);
      } else {
        if (
          Object.keys(body).some((key) => !["kind", "receipt", "characterId"].includes(key)) ||
          !["share", "skin"].includes(body.kind)
        )
          throw httpError(400, "Invalid achievement operation", "ACHIEVEMENT_INVALID_REQUEST");
        if (needsHistoryBackfill && !usageAcquired) {
          try {
            await loadUsageStore();
          } catch {
            throw httpError(503, "Achievement history is not ready", "ACHIEVEMENT_UNAVAILABLE");
          }
        }
        result = await context.usageStore.achievementOperation(body);
      }
      sendJson(response, 200, result);
      return true;
    }
    await pricingReady;
    if (url.pathname === "/api/pricing") {
      if (request.method === "GET") {
        const snapshotId = url.searchParams.get("snapshot");
        const snapshot = snapshotId ? context.snapshots.get(snapshotId) : null;
        if (snapshotId && !snapshot) throw httpError(410, "Snapshot is no longer available.", "SNAPSHOT_EXPIRED");
        const metadata =
          snapshot?.metadata || (context.storeStatus === null ? undefined : context.usageStore.metadata());
        const catalog = snapshot?.pricingCatalog || localPricingCatalog();
        sendJson(response, 200, {
          ...catalog,
          automatic: snapshot ? snapshot.automatic : liveAutomaticPricingStatus(),
          usageCoverage: usagePricingCoverage(metadata, catalog),
          modelActivity: metadata
            ? {
                harnessModels: metadata.harnessModels,
                activeHarnessModels: metadata.activeHarnessModels,
                modelLastSeen: metadata.modelLastSeen,
                modelUsageAsOf: metadata.modelUsageAsOf,
              }
            : null,
        });
        return true;
      }
      if (request.method === "PUT") {
        if (importContext) {
          sendJson(response, 405, {
            code: "IMPORT_PRICING_READ_ONLY",
            error: "Imported runtime pricing is read-only.",
          });
          return true;
        }
        let catalog;
        let restoreAutomaticExchangeRate = false;
        const body = await readJsonBody(request, { maxBytes: 128 * 1024 });
        await runPricingMutation(async () => {
          try {
            restoreAutomaticExchangeRate = body.restoreAutomaticExchangeRate === true;
            if (body.version && body.version !== getPricingCatalog().version) {
              throw httpError(
                409,
                "Pricing changed while this editor was open. Reopen it and retry.",
                "PRICING_CHANGED",
              );
            }
            if (
              body.models &&
              typeof body.models === "object" &&
              !Array.isArray(body.models) &&
              Object.keys(body.models).length > MAX_PRICING_MODELS
            ) {
              throw httpError(
                400,
                `Pricing catalog cannot contain more than ${MAX_PRICING_MODELS} models.`,
                "PRICING_CAPACITY",
              );
            }
            catalog = validatePricingCatalog(body);
            await savePricingFile(options, catalog, {
              restoreAutomaticExchangeRate,
            });
          } catch (error) {
            throw httpError(error.statusCode || 400, error.message, error.code || "INVALID_PRICING");
          }
        });
        sendJson(response, 200, getPricingCatalog());
        return true;
      }
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }

    if (url.pathname === "/api/pricing/refresh") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" });
        return true;
      }
      if (importContext) {
        sendJson(response, 405, {
          code: "IMPORT_PRICING_READ_ONLY",
          error: "Imported runtime pricing is read-only.",
        });
        return true;
      }
      const body = await readJsonBody(request, { allowEmpty: true });
      let model = null;
      if (Object.hasOwn(body, "model")) {
        if (typeof body.model !== "string" || !body.model.trim() || body.model.trim().length > 128) {
          throw httpError(
            400,
            "Pricing model must be a non-empty string up to 128 characters.",
            "INVALID_PRICING_MODEL",
          );
        }
        model = body.model.trim();
      }
      const discoveryReady = context.storeStatus !== null;
      const refreshResult = model
        ? await requestTargetedPricingRefresh(model)
        : await requestPricingRefresh({
            force: body.force === true,
            usedModels: discoveryReady ? context.usageStore.metadata().harnessModels : [],
            discoveryReady,
          });
      sendJson(
        response,
        200,
        model || discoveryReady
          ? refreshResult
          : {
              ...refreshResult,
              discovery: {
                addedModels: [],
                results: [{ model: "*", status: "deferred", reason: "usage-not-ready" }],
              },
            },
      );
      return true;
    }
    return false;
  }

  function onListening() {
    achievementStartup = startAchievements();
    initialAchievementUpdate = achievementStartup
      .then(() => {
        if (!achievementsEnabled || context.serverClosed) return;
        // Raw source history may not be in the usage index yet.
        if (needsHistoryBackfill && !usageAcquired) return loadUsageStore();
        scheduleAchievementUpdate();
      })
      .catch(() => {});
    if (pricingRefreshSchedulerEnabled)
      void pricingReady.then(
        () => void runPricingRefreshCheck(),
        () => {},
      );
  }
  function stopTimers() {
    clearPricingRefreshTimer();
    clearDiscoveryTimer();
  }
  function releaseWorker() {
    releaseAchievementWorker?.();
    releaseAchievementWorker = null;
  }
  async function drainAchievements() {
    await initialAchievementUpdate;
    await achievementUpdatePromise;
  }
  async function drainPricing() {
    while (pricingRefreshPromise) await pricingRefreshPromise.catch(() => {});
    await pricingMutationTail;
  }
  function sendAchievementState(response) {
    const snapshot = context.usageStore.achievementSnapshot();
    if (snapshot)
      writeUsageEvent(
        response,
        "achievement-state",
        Object.fromEntries(
          ["profileId", "state", "progressRevision", "awardRevision", "seenAwardRevision"].map((key) => [
            key,
            snapshot[key],
          ]),
        ),
      );
  }
  return {
    get ready() {
      return pricingReady;
    },
    get startup() {
      return achievementStartup;
    },
    activityKind: (path) => (path.startsWith("/api/pricing") ? "pricing" : null),
    pricingCatalog: localPricingCatalog,
    onUsageAcquired,
    scheduleUsageDiscovery,
    handleRequest,
    onListening,
    stopTimers,
    releaseWorker,
    drainAchievements,
    drainPricing,
    sendAchievementState,
    executorOptions: () => ({ pricing: localPricingCatalog, onAchievementSnapshot: broadcastAchievementState }),
    frozenExecutorOptions: (catalog) => ({ pricing: () => catalog }),
    importedOpenFields: () => ({
      pricing: localPricingCatalog(),
      serviceTierEvidence: importContext.serviceTierEvidenceSnapshot,
    }),
    queryFilters: (catalog) => ({ pricingModels: catalog.models }),
    catalogFields: (catalog) => ({ pricingCatalog: catalog }),
    snapshotFields: (catalog, automatic) => ({ pricingCatalog: catalog, automatic }),
    automaticStatus: (catalog) =>
      importContext
        ? (importContext.automaticPricingStatus ?? null)
        : runWithPricingCatalog(catalog, getAutomaticPricingStatus),
    sameQueryContext: (a, b) =>
      a.version === b.version &&
      a.usdToCnyRate === b.usdToCnyRate &&
      JSON.stringify(a.models) === JSON.stringify(b.models),
    versionInputs: (catalog) => [catalog.version, catalog.usdToCnyRate, catalog.models],
    runWithQueryContext: runWithPricingCatalog,
    shareFields: async (summary, filters) => ({ achievementShareReceipt: await shareReceipt(summary, filters) }),
  };
}
