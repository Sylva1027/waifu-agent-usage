import { createUsageServer as createServerCore } from "./server-core.js";
export { withoutExcludedHomes, isFullDetailHeapAvailable, describeImportEntry, readJsonBody } from "./server-core.js";
import { createUsageExecutor } from "./usage-executor-waifu.js";
import { UsageSummaryCache, summaryCacheKey } from "./usage-summary-cache.js";
import { buildUsageReport, summarizeUsage } from "./usage-core.js";
import { createWaifuServerFeatures } from "./waifu/server-features.js";
import { loadHistoryArchiveImport } from "./history-archive.js";
import { serviceTierEvidenceSnapshot } from "./service-tier-evidence.js";
import { pathToFileURL } from "node:url";
import path from "node:path";
export function createUsageServer(options = {}) {
  return createServerCore(
    { ...options, edition: "waifu" },
    {
      edition: "waifu",
      createUsageExecutor,
      UsageSummaryCache,
      summaryCacheKey,
      buildUsageReport,
      summarizeUsage,
      createFeatures: createWaifuServerFeatures,
    },
  );
}
/**
 * Verify a completed import, then create a server bound to its runtime and pricing context.
 * @param {string} importDirectory
 * @param {Record<string, any>} [options]
 */
export async function createHistoryArchiveImportServer(importDirectory, options = {}) {
  const loaded = await loadHistoryArchiveImport(importDirectory);
  if (!loaded.context.pricingCatalog) {
    const { loadPricingFile } = await import("./pricing-store.js");
    await loadPricingFile(options);
    loaded.context.pricingCatalog = (await import("./pricing.js")).getPricingCatalog();
  }
  return createUsageServer({
    ...options,
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
    databaseFile: loaded.runtimeFile,
    importContext: {
      pricingCatalog: loaded.context.pricingCatalog,
      automaticPricingStatus: null,
      serviceTierEvidenceSnapshot:
        loaded.context.serviceTierEvidence === null
          ? null
          : serviceTierEvidenceSnapshot(loaded.context.serviceTierEvidence),
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3765);
  const host = process.env.HOST || "127.0.0.1";
  const server = createUsageServer();
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Waifu Agent Usage dashboard: http://${host}:${actualPort}`);
  });
}
