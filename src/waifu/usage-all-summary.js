import { createCostEstimateAccumulator } from "../pricing.js";
import { createTimelineAccumulator } from "../../public/waifu-timeline.js";

const tableNames = (prefix) => ({
  STATE: `${prefix}_state`,
  CHECKPOINTS: `${prefix}_checkpoints`,
  MEMBERS: `${prefix}_members`,
  DIRTY: `${prefix}_dirty`,
  FORMAT_TABLE: `${prefix}_format`,
});
const hot = tableNames("usage_all_summary");
const history = tableNames("usage_history_all_summary");
export const WAIFU_ALL_SUMMARY_TABLE_NAMES = Object.freeze(Object.values(hot));
export const WAIFU_HISTORY_ALL_SUMMARY_TABLE_NAMES = Object.freeze(Object.values(history));

/** Pass as options.extension to the shared schema/build/read/dirty functions. */
export function createWaifuAllSummaryExtension(pricing) {
  return {
    format: 4,
    stateVersion: 1,
    tables: { hot, history },
    modelName: pricing.modelName,
    createProjection(options, saved, timelineOptions) {
      if (saved && !saved.cost) throw new TypeError("Invalid stored all-summary cost state");
      const cost = createCostEstimateAccumulator({ modelName: pricing.costModelName, state: saved?.cost });
      const timeline = createTimelineAccumulator(options.range, options.bucket, {
        ...timelineOptions,
        pricingModels: options.pricingModels,
      });
      return {
        add(event) {
          const estimate = pricing.estimate(event);
          cost.add(event, estimate);
          timeline.add(event, estimate);
        },
        snapshot: () => ({ cost: cost.snapshot(), timeline: timeline.snapshot() }),
        result: () => ({ costEstimate: cost.result(), timeline: timeline.result(options.range), timelineError: null }),
      };
    },
  };
}
