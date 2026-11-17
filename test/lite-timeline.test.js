import assert from "node:assert/strict";
import test from "node:test";
import { buildTimelineRows, createTimelineAccumulator } from "../public/timeline-utils.js";

const range = { calendarZone: "utc", start: "2026-11-16T00:00:00Z", end: "2026-11-17T23:59:59Z" };
const event = (day, input) => ({
  timestamp: `2026-11-${day}T12:00:00Z`,
  homeId: "home",
  sessionId: `session-${day}`,
  channel: "CLI",
  model: "vendor/GPT-6-SOL",
  total: { total: input + 10, input, cached: 20, output: 10, reasoning: 5 },
  costEstimate: { totalUsd: 100, pricedTokens: 100 },
});

function assertPure(value) {
  const fields = new Set([
    "costs",
    "costByModel",
    "modelCosts",
    "scenarioReasons",
    "estimatedRecords",
    "pricingStatus",
    "pricedTokens",
    "unpricedTokens",
    "minimumEstimatedTokens",
    "serviceTierUnknownTokens",
    "contextUnknownTokens",
    "cacheWriteUnknownTokens",
  ]);
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!fields.has(key), `unexpected exclusive field ${key}`);
    if (child && typeof child === "object") assertPure(child);
  }
}

test("pure timeline ignores prepriced event values and has no cost result or state", () => {
  const accumulator = createTimelineAccumulator(range);
  accumulator.add(event("16", 100));
  const result = accumulator.result();
  assert.equal(result.length, 2);
  assert.equal(result[0].total.total, 110);
  assert.equal(result[0].models[0].name, "gpt-6-sol");
  assert.equal(result[1].total.total, 0);
  assertPure(result);
  assertPure(accumulator.snapshot());
});

test("pure snapshots restore membership and append exactly once", () => {
  const first = createTimelineAccumulator(range);
  first.add(event("16", 100));
  const restored = createTimelineAccumulator(range, "day", { state: first.snapshot() });
  restored.add(event("17", 50));
  assert.deepEqual(restored.result(), buildTimelineRows([event("16", 100), event("17", 50)], range));
  assertPure(restored.snapshot());
  const mixed = { ...first.snapshot(), version: 1 };
  assert.throws(() => createTimelineAccumulator(range, "day", { state: mixed }), { code: "TIMELINE_STATE_INVALID" });
});
