import { UsageStore } from "./usage-store.js";
import { runUsageExecutorProcess } from "./usage-executor-worker.js";
import { createWaifuExecutorRuntime } from "./waifu/usage-executor-runtime.js";
export { createUsageExecutor } from "./usage-executor-waifu.js";
export {
  checkpointUsageStore,
  syncUsageStore,
  readHistoryArchiveStatus,
  readHistoryArchiveDays,
} from "./usage-executor-worker.js";
if (process.env.CODEX_USAGE_EXECUTOR_CHILD === "1") {
  void runUsageExecutorProcess({
    createStore: (options) => new UsageStore(options),
    createRuntime: createWaifuExecutorRuntime,
  });
}
