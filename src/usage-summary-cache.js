import {
  UsageSummaryCache as CommonSummaryCache,
  refreshSummaryClock as refreshUsageClock,
  summaryCacheKey as usageCacheKey,
} from "./usage-summary-cache-core.js";
import { buildModelActivity } from "../public/pricing-models.js";
import { readWaifuUsageSourceInputs } from "./waifu/usage-source-inputs.js";
export { publishedSummarySource } from "./usage-summary-cache-core.js";
export function refreshSummaryClock(payload, now) {
  refreshUsageClock(payload, now);
  const observations = Object.entries(payload.metadata.modelLastSeen || {}).flatMap(([harness, models]) =>
    Object.entries(models).map(([model, timestamp]) => ({ harness, model, timestamp })),
  );
  Object.assign(payload.metadata, buildModelActivity(observations, now));

  return payload;
}
export function summaryCacheKey(filters, includeDetails, pricing) {
  return usageCacheKey(filters, includeDetails, { edition: "waifu", pricing });
}
export class UsageSummaryCache extends CommonSummaryCache {
  constructor(options = {}) {
    super(options, { readInputs: readWaifuUsageSourceInputs, refreshClock: refreshSummaryClock, cacheName: "" });
  }
}
