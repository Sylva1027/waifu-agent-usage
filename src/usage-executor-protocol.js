export function activityKind(type) {
  if (type === "checkSources" || type === "validateAcquisition") return "check";
  if (type === "sync") return "sync";
  if (type === "historyArchiveImport" || type === "historyArchiveEventCommit") return "import";
  return "statistics";
}

export function activityPhase(type) {
  if (type === "sync" || activityKind(type) === "check") return "checking";
  if (activityKind(type) === "import" || type.startsWith("publishedUsage")) return "reading";
  return "statistics";
}

/**
 * 结果里可能带**类实例**（如 tier resolver）⇒ `postMessage` 的 structured clone 会抛
 * `could not be cloned`。HTTP 层本来就只 `JSON.stringify` 这些结果，因此这里做同样的 JSON 往返，
 * 保证跨线程传的就是"HTTP 会发出的那份数据"（语义等价、且不引入第二套形状）。
 */
export function toWire(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function executorError(error, code) {
  const wrapped = new Error(error?.message ?? String(error));
  // `checkJs` 的 `Error` 类型上没有这些字段：用一次 JSDoc 断言把它们显式化，
  // **运行期行为逐字不变**（只是让 tsc 看得见 `code/statusCode/quota/retryable`）。
  const detail = /** @type {{ code?: string, statusCode?: number, quota?: unknown, retryable?: boolean }} */ (wrapped);
  detail.code = error?.code ?? code ?? "EXECUTOR_ERROR";
  // 保留 HTTP 层需要的字段（`QUOTA_WINDOW_UNAVAILABLE` 的 409 + quota 载荷全靠它）。
  if (error?.statusCode !== undefined && error.statusCode !== null) detail.statusCode = error.statusCode;
  if (error?.quota !== undefined) detail.quota = error.quota;
  detail.retryable = detail.statusCode === undefined;
  return wrapped;
}
