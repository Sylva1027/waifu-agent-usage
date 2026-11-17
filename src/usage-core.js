import { getPricingCatalog } from "./pricing.js";
import { canonicalModelName } from "../public/pricing-models.js";
import { buildUsageReport as buildUsageFactsReport, buildUsageIndex as buildUsageFactsIndex } from "./usage-sources.js";
import {
  summarizeUsage as summarizeUsageFacts,
  summarizeUsageIndex as summarizeUsageFactsIndex,
} from "./usage-summary.js";
import { createWaifuEventDecorator } from "./waifu/usage-source-evidence.js";
import { createWaifuSummaryExtension } from "./waifu/usage-summary.js";
export * from "./usage-query.js";
export * from "./usage-sources.js";

export function buildUsageReport(options = {}) {
  return buildUsageFactsReport(options, { createEventDecorator: createWaifuEventDecorator });
}
export function buildUsageIndex(options = {}) {
  return buildUsageFactsIndex(options, { createEventDecorator: createWaifuEventDecorator });
}
function summaryOptions(filters) {
  const models = filters.pricingModels ?? getPricingCatalog().models;
  return { modelName: (model) => canonicalModelName(model, models), createExtension: createWaifuSummaryExtension };
}
export function summarizeUsage(report, filters = {}) {
  return summarizeUsageFacts(report, filters, summaryOptions(filters));
}
export function summarizeUsageIndex(index, filters = {}) {
  return summarizeUsageFactsIndex(index, filters, summaryOptions(filters));
}
