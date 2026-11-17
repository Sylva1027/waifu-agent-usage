import { createUsageExecutorClient } from "./usage-executor-client.js";
/** @param {any} [options] @param {Omit<NonNullable<Parameters<typeof createUsageExecutorClient>[1]>, "workerFile">} [configuration] */
export function createUsageExecutor(options = {}, configuration = {}) {
  return createUsageExecutorClient(options, {
    ...configuration,
    workerFile: new URL("./usage-executor-lite.js", import.meta.url),
  });
}
if (process.env.CODEX_USAGE_EXECUTOR_CHILD === "1") {
  const [{ UsageStore }, { runUsageExecutorProcess }] = await Promise.all([
    import("./usage-store-lite.js"),
    import("./usage-executor-worker.js"),
  ]);
  void runUsageExecutorProcess({
    createStore: (options) => new UsageStore(options),
    backupOptions: { pricingCatalog: null },
  });
}
