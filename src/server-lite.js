import { createUsageServer as createServerCore } from "./server-core.js";
import { createUsageExecutor } from "./usage-executor-lite.js";
import { UsageSummaryCache, summaryCacheKey } from "./usage-summary-cache-lite.js";
import { buildUsageReport } from "./usage-sources.js";
import { summarizeUsage } from "./usage-summary.js";
import { loadHistoryArchiveImport } from "./history-archive.js";

export const LITE_PUBLIC_FILES = [
  "usage-fields.js",
  "usage-metrics.js",
  "html-utils.js",
  "calendar.js",
  "period-comparison.js",
  "timeline-utils.js",
  "timeline-state.js",
  "model-identity.js",
  "dashboard-render.js",
  "usage-dashboard-state.js",
  "locale.js",
  "source-view.js",
  "dashboard-runtime.js",
  "dashboard-view-utils.js",
  "lite/index.html",
  "lite/app.js",
  "lite/app-state.js",
  "lite/styles.css",
];
const publicFiles = new Map(LITE_PUBLIC_FILES.map((file) => [`/${file}`, `/${file}`]));
publicFiles.set("/index.html", "/lite/index.html");

export function createUsageServer(options = {}) {
  return createServerCore(
    { ...options, edition: "lite" },
    {
      edition: "lite",
      createUsageExecutor,
      UsageSummaryCache,
      summaryCacheKey,
      buildUsageReport,
      summarizeUsage,
      publicFiles,
    },
  );
}

export async function createHistoryArchiveImportServer(importDirectory, options = {}) {
  const loaded = await loadHistoryArchiveImport(importDirectory, { serviceTierEvidenceFormat: "snapshot" });
  return createUsageServer({
    ...options,
    databaseFile: loaded.runtimeFile,
    importContext: {},
    automaticDiscoveryEnabled: false,
  });
}
