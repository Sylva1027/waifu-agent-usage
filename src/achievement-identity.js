import { canonicalModelName } from "../public/pricing-models.js";
import { pricingProvider } from "../public/pricing-directory.js";
import { usageHarness } from "../public/range-metrics.js";
import { sourceGroup } from "../public/timeline-utils.js";
import { sessionIdentity } from "../public/usage-fields.js";

export const ACHIEVEMENT_IDENTITY_VERSION = "achievement-identity-1";

/**
 * repositoryAliases maps existing repository keys to main's common Git key strings.
 * @param {{ pricingModels?: Record<string, any>, repositoryAliases?: Record<string, string> }} [options]
 */
export function createAchievementIdentity({ pricingModels = {}, repositoryAliases = {} } = {}) {
  return function achievementIdentity(event) {
    const model = canonicalModelName(event.rawModel ?? event.raw ?? event.model, pricingModels).toLowerCase();
    const modelId = model && !["unknown", "unknown model"].includes(model) ? model : null;
    const provider = modelId ? pricingProvider(modelId).id : null;
    const harness = usageHarness(event.channel, event.sourceKind);
    // usageHarness's unknown-kind sentinel is truthy, so resolve legacy channels explicitly.
    const harnessId = harness === "Unknown" ? usageHarness(event.channel, sourceGroup(event.channel)) : harness;
    const key = event.repositoryKey;
    const alias = Object.hasOwn(repositoryAliases, key) ? repositoryAliases[key] : null;
    const repositoryKey =
      !key || event.repositoryKind === "unknown" || key.startsWith("unknown:") ? null : alias || key;
    return {
      modelId,
      providerId: provider === "other" ? null : provider,
      harnessId: harnessId === "Unknown" ? null : harnessId,
      sessionKey: event.homeId && event.sessionId ? sessionIdentity(event.homeId, event.sessionId) : null,
      repositoryKey,
    };
  };
}
