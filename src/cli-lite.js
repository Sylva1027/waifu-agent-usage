#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli-core.js";
import { createUsageServer } from "./server-lite.js";
import { createUsageExecutor } from "./usage-executor-lite.js";
import { UsageStore } from "./usage-store-lite.js";
import { buildUsageReport } from "./usage-sources.js";
import { summarizeUsage } from "./usage-summary.js";

export { readServices, writeServices } from "./cli-core.js";

const entryFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(entryFile) === realpathSync(process.argv[1])) {
  runCli({
    edition: "lite",
    entryFile,
    createUsageServer,
    createUsageExecutor,
    UsageStore,
    buildUsageReport,
    summarizeUsage,
    historyOptions: { pricingCatalog: null, serviceTierSnapshot: null, serviceTierEvidenceFormat: "snapshot" },
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
