import assert from "node:assert/strict";

function pick(value, fields) {
  assert.ok(value && typeof value === "object", "Missing common contract object");
  return Object.fromEntries(
    fields.map((field) => {
      assert.ok(Object.hasOwn(value, field), `Missing common contract field: ${field}`);
      return [field, value[field]];
    }),
  );
}

function withoutClock(value) {
  if (Array.isArray(value)) return value.map(withoutClock);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "asOf" && key !== "generatedAt")
      .map(([key, child]) => [key, withoutClock(child)]),
  );
}

export function commonUsageContract(payload) {
  const { summary, metadata } = payload;
  const common = pick(summary, [
    "range",
    "totals",
    "details",
    "cacheHitRate",
    "comparison",
    "eventCount",
    "sessionCount",
    "homeCount",
    "channels",
    "models",
    "timelineError",
  ]);
  common.timeline = summary.timeline.map((row) =>
    pick(row, ["key", "name", "count", "sessions", "total", "channels", "models"]),
  );
  return withoutClock({
    summary: common,
    periods: pick(payload.periodComparison, ["periods", "totals", "models", "repositories"]),
    metadata: pick(metadata, [
      "eventCount",
      "sessionCount",
      "homeCount",
      "homes",
      "warnings",
      "calendarContext",
      "imports",
    ]),
    quota: payload.quota,
  });
}

const EXCLUSIVE_FIELDS = new Set([
  "costEstimate",
  "records",
  "rangeMetrics",
  "costByModel",
  "modelCosts",
  "scenarioReasons",
  "pricedTokens",
  "unpricedTokens",
  "minimumEstimatedTokens",
  "serviceTierUnknownTokens",
  "contextUnknownTokens",
  "cacheWriteUnknownTokens",
  "pricingStatus",
  "pricingCatalog",
  "achievementShareReceipt",
  "harnessModels",
  "activeHarnessModels",
  "modelLastSeen",
  "modelUsageAsOf",
]);

export function assertEditionPayload(edition, payload) {
  assert.ok(typeof payload.usageVersion === "string" && payload.usageVersion.length > 0, "Missing usageVersion");
  if (edition === "waifu") {
    for (const key of ["pricingCatalog", "achievementShareReceipt"]) assert.ok(Object.hasOwn(payload, key), key);
    for (const key of ["costEstimate", "rangeMetrics", "records"]) assert.ok(Object.hasOwn(payload.summary, key), key);
    assert.ok(payload.summary.costEstimate.pricedTokens > 0, "Waifu pricing must execute");
    return;
  }
  assert.equal(edition, "lite");
  const pure = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!EXCLUSIVE_FIELDS.has(key), `Lite exclusive field: ${key}`);
      pure(child);
    }
  };
  pure(payload);
}
