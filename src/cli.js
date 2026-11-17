#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli-core.js";
import { createUsageServer } from "./server.js";
import { createUsageExecutor } from "./usage-executor-waifu.js";
import { UsageStore } from "./usage-store.js";
import { buildUsageReport, summarizeUsage } from "./usage-core.js";
import { waifuCliFeatures } from "./waifu/cli-features.js";

export { readServices, writeServices } from "./cli-core.js";

const entryFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(entryFile) === realpathSync(process.argv[1])) {
  runCli({
    edition: "waifu",
    entryFile,
    createUsageServer,
    createUsageExecutor,
    UsageStore,
    buildUsageReport,
    summarizeUsage,
    features: waifuCliFeatures,
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
