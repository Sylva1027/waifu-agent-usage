import { createEventCostMemo, getPricingCatalog, runWithPricingCatalog, setPricingCatalog } from "../pricing.js";
import { serviceTierEvidenceFromSnapshot, serviceTierEvidenceSnapshot } from "../service-tier-evidence.js";
import { executorError, toWire } from "../usage-executor-protocol.js";
const EVENT_COST_MEMO_MAX_BYTES = 8 * 1024 * 1024;
const EVENT_COST_MEMO_HARD_MAX_BYTES = 16 * 1024 * 1024;
function serviceTierEvidenceForWire(evidence) {
  return evidence === null ? null : serviceTierEvidenceSnapshot(evidence);
}

/** 把主线程权威价目对齐到执行器的模块实例（版本相同则零开销跳过）。 */
function applyPricingCatalog(pricing) {
  if (!pricing || typeof pricing !== "object") return;
  if (getPricingCatalog().version === pricing.version) return;
  setPricingCatalog(pricing);
}

export function createWaifuExecutorRuntime(store, send) {
  let achievementReadOnlyContext = false;
  let achievements = null;
  let achievementOperations = null;
  let achievementRefreshing = false;
  let achievementError = null;
  store.eventCostMemo = createEventCostMemo({
    maxBytes: EVENT_COST_MEMO_MAX_BYTES,
    hardMaxBytes: EVENT_COST_MEMO_HARD_MAX_BYTES,
  });
  const publishAchievements = () => {
    void send({
      type: "state",
      state: toWire({
        achievements: achievements
          ? {
              ...achievements.readSnapshot(),
              refreshing: achievementRefreshing,
              ...(achievementError ? { error: achievementError } : {}),
            }
          : null,
      }),
    }).catch(() => {});
  };
  const startAchievements = async (settings) => {
    if (achievementReadOnlyContext || settings?.edition !== "waifu")
      throw Object.assign(new Error("Achievements require a live Waifu service"), {
        code: "ACHIEVEMENT_CONTEXT_REQUIRED",
      });
    if (!achievements) {
      const { AchievementRuntime } = await import("../achievement-runtime.js");
      const runtime = new AchievementRuntime({
        usageStore: store,
        ...settings,
        pricingModels: getPricingCatalog().models,
        ...(settings.now === undefined ? {} : { clock: () => settings.now }),
      });
      try {
        await runtime.start();
      } catch (error) {
        runtime.close();
        throw error;
      }
      achievements = runtime;
      const { AchievementOperationService } = await import("../achievement-operations.js");
      achievementOperations = new AchievementOperationService({
        archive: achievements.archive,
        ...(settings.now === undefined ? {} : { clock: () => settings.now }),
      });
    }
    publishAchievements();
    return { ...achievements.readSnapshot(), needsHistoryBackfill: achievements.needsHistoryBackfill };
  };
  const updateAchievements = async () => {
    if (!achievements) return null;
    achievementRefreshing = true;
    publishAchievements();
    try {
      const result = await achievements.update({ pricingModels: getPricingCatalog().models });
      achievementError = null;
      return { ...result, pendingCatchUp: Boolean(achievements.diagnostics?.pendingCatchUp) };
    } catch (error) {
      achievementError = { code: error.code || "ACHIEVEMENT_UPDATE_FAILED", message: error.message };
      throw error;
    } finally {
      achievementRefreshing = false;
      publishAchievements();
    }
  };

  return {
    async initialize(options, firstMessage) {
      achievementReadOnlyContext = Boolean(firstMessage?.frozen || firstMessage?.imported);
      if (options.achievement && !achievementReadOnlyContext) await startAchievements(options.achievement);
    },
    restoreState(lightState = {}) {
      store.serviceTierEvidence =
        lightState.serviceTierEvidence == null ? null : serviceTierEvidenceFromSnapshot(lightState.serviceTierEvidence);
      store.serviceTierEvidenceInput = store.serviceTierEvidenceSignature(store.homes);
    },
    open(message) {
      achievementReadOnlyContext = Boolean(message.frozen || message.imported);
      if (message.imported)
        store.serviceTierEvidence =
          message.serviceTierEvidence === null ? null : serviceTierEvidenceFromSnapshot(message.serviceTierEvidence);
    },
    run(message, action) {
      applyPricingCatalog(message.pricing);
      return ["open", "sync", "dashboard", "summarize", "periodComparison", "snapshot", "backupHistory"].includes(
        message.type,
      ) || message.type.startsWith("achievement")
        ? runWithPricingCatalog(message.pricing, action)
        : action();
    },
    filters(value = {}) {
      return { ...value, pricingModels: value.pricingModels ?? getPricingCatalog().models };
    },
    state: () => ({ serviceTierEvidence: serviceTierEvidenceForWire(store.serviceTierEvidence) }),
    dashboard: () => ({ pricingCatalog: getPricingCatalog() }),
    snapshot: () => ({
      serviceTierEvidence: serviceTierEvidenceForWire(store.serviceTierEvidence),
      pricingCatalog: getPricingCatalog(),
    }),
    copySnapshot: (snapshotStore) => {
      snapshotStore.serviceTierEvidence = store.serviceTierEvidence;
    },
    async backup(message, create) {
      const options = {
        serviceTierEvidence: store.serviceTierEvidence,
        ...(achievements && message.withAchievements !== false
          ? { achievementDatabaseFile: achievements.databaseFile }
          : {}),
      };
      return options.achievementDatabaseFile
        ? (await import("../achievement-backup.js")).withAchievementBackupLock(options.achievementDatabaseFile, () =>
            create(options),
          )
        : create(options);
    },
    serial: (type) => type.startsWith("achievement"),
    close: () => achievements?.close(),
    async handle(message) {
      switch (message.type) {
        case "achievementPrepare": {
          if (achievementReadOnlyContext || message.args?.edition !== "waifu")
            throw Object.assign(new Error("Achievement preparation requires an explicit live Waifu context"), {
              code: "ACHIEVEMENT_CONTEXT_REQUIRED",
            });
          const { AchievementFoundation } = await import("../achievement-foundation.js");
          const foundation = new AchievementFoundation({ usageStore: store, databaseFile: message.args.databaseFile });
          try {
            return await foundation.prepare({ ...message.args, pricingModels: getPricingCatalog().models });
          } finally {
            foundation.close();
          }
        }
        case "achievementStart":
          return startAchievements(message.args);
        case "achievementUpdate":
          return updateAchievements();
        case "achievementRead":
          return achievements?.readSnapshot() ?? null;
        case "achievementDiagnostics":
          return achievements?.diagnostics ?? null;
        case "achievementShareReceipt":
          return achievementOperations?.issueShareReceipt(message.args.summary, message.args.range) ?? null;
        case "achievementOperation": {
          if (!achievementOperations) throw new Error("Achievements are not initialized");
          let recorded;
          try {
            recorded = await achievementOperations.recordBrowserOperation(message.args);
          } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) Object.assign(error, { statusCode: 400 });
            throw error;
          }
          const snapshot = await updateAchievements();
          return { recorded, snapshot };
        }
        case "achievementSeen": {
          if (!achievements || message.args.profileId !== achievements.archive.readProfile().profileId)
            throw Object.assign(new Error("Unknown achievement profile"), {
              statusCode: 409,
              code: "ACHIEVEMENT_PROFILE_MISMATCH",
            });
          let seenThroughRevision;
          try {
            seenThroughRevision = achievements.archive.markSeen(message.args.seenThroughRevision);
          } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) Object.assign(error, { statusCode: 400 });
            throw error;
          }
          publishAchievements();
          return { seenThroughRevision };
        }
        default:
          throw executorError(
            new Error(`unsupported executor message: ${String(message.type)}`),
            "EXECUTOR_BAD_MESSAGE",
          );
      }
    },
  };
}
