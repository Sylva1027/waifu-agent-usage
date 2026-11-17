import { getPricingCatalog } from "./pricing.js";
import { serviceTierEvidenceFromSnapshot, serviceTierEvidenceSnapshot } from "./service-tier-evidence.js";
import { createUsageExecutorClient } from "./usage-executor-client.js";

const PRICED_REQUESTS = new Set([
  "sync",
  "summarize",
  "dashboard",
  "periodComparison",
  "snapshot",
  "backupHistory",
  "achievementPrepare",
  "achievementStart",
  "achievementUpdate",
]);

function restoreServiceTierEvidenceRecord(record) {
  if (!record || typeof record !== "object" || !Object.hasOwn(record, "serviceTierEvidence")) return record;
  return {
    ...record,
    serviceTierEvidence:
      record.serviceTierEvidence === null ? null : serviceTierEvidenceFromSnapshot(record.serviceTierEvidence),
  };
}

/**
 * @param {any} [options]
 * @param {Omit<NonNullable<Parameters<typeof createUsageExecutorClient>[1]>, "workerFile"> & {
 * pricing?: () => any, onAchievementSnapshot?: (snapshot: any) => void}} [configuration]
 */
export function createUsageExecutor(
  options = {},
  { pricing = getPricingCatalog, onAchievementSnapshot = (_snapshot) => {}, ...clientOptions } = {},
) {
  let settings = options.achievement ?? null;
  let snapshot = null;
  const client = createUsageExecutorClient(options, {
    ...clientOptions,
    workerFile: new URL("./usage-executor.js", import.meta.url),
    workerOptions: () => ({ ...options, ...(settings ? { achievement: settings } : {}) }),
    requestContext: (type) => (PRICED_REQUESTS.has(type) ? { pricing: pricing() } : {}),
    serialize: (type, value) => {
      if (type === "state") {
        return {
          ...value,
          serviceTierEvidence:
            value.serviceTierEvidence == null ? null : serviceTierEvidenceSnapshot(value.serviceTierEvidence),
        };
      }
      const frozen = value.frozen;
      if (type === "open" && typeof frozen?.serviceTierEvidence?.resolve === "function") {
        return {
          ...value,
          frozen: { ...frozen, serviceTierEvidence: serviceTierEvidenceSnapshot(frozen.serviceTierEvidence) },
        };
      }
      return value;
    },
    deserialize: (type, value) =>
      type === "state" || type === "snapshot" ? restoreServiceTierEvidenceRecord(value) : value,
    hasActivity: (type) => !type.startsWith("achievement"),
    onState: (state) => {
      const { achievements, ...usageState } = state;
      if (Object.hasOwn(state, "achievements")) {
        snapshot = achievements;
        try {
          void Promise.resolve(onAchievementSnapshot(snapshot)).catch(() => {});
        } catch {
          // Observers must not change request settlement.
        }
      }
      return usageState;
    },
  });
  const waifuClient = /** @type {typeof client & {
    readonly serviceTierEvidence: ReturnType<typeof serviceTierEvidenceFromSnapshot> | null}} */ (
    Object.defineProperty(client, "serviceTierEvidence", {
      enumerable: true,
      configurable: true,
      get: () => client.stateValue("serviceTierEvidence") ?? null,
    })
  );
  return Object.assign(waifuClient, {
    achievementPrepare: (args = {}) => client.request("achievementPrepare", { args }),
    achievementStart: async (args) => {
      if (args?.edition !== "waifu")
        throw Object.assign(new Error("Achievements require a live Waifu service"), {
          code: "ACHIEVEMENT_CONTEXT_REQUIRED",
        });
      const previous = settings;
      settings = args;
      try {
        return await client.request("achievementStart", { args });
      } catch (error) {
        settings = previous;
        throw error;
      }
    },
    achievementUpdate: () => client.request("achievementUpdate"),
    achievementRead: () => client.request("achievementRead"),
    achievementDiagnostics: () => client.request("achievementDiagnostics"),
    achievementSnapshot: () => snapshot,
    achievementShareReceipt: (summary, range) =>
      client.request("achievementShareReceipt", { args: { summary, range } }),
    achievementOperation: (args) => client.request("achievementOperation", { args }),
    achievementSeen: (args) => client.request("achievementSeen", { args }),
  });
}
