import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cacheHitRate } from "../public/usage-metrics.js";
import { addPeriodEvent, emptyPeriodMetrics } from "../public/period-comparison.js";
import { USAGE_DETAIL_INCONSISTENT, USAGE_DETAIL_MASK, validateUsageDetails } from "../public/usage-fields.js";

function aggregate(events) {
  const details = emptyPeriodMetrics();
  for (const event of events) addPeriodEvent(details, event);
  return details;
}

test("four independent events retain all known totals and use only paired cache details", () => {
  const details = aggregate([
    { total: { total: 120, input: 100, cached: 40, output: 20, reasoning: 5 }, detailMask: 15 },
    { total: { total: 60, input: 50, cached: 10, output: 10, reasoning: 2 }, detailMask: 15 },
    { total: { total: 100, input: 80, cached: 0, output: 20, reasoning: 0 }, detailMask: 5 },
    { total: { total: 30, input: 0, cached: 0, output: 0, reasoning: 0 }, detailMask: 0 },
  ]);
  assert.deepEqual(details, {
    total: 310,
    input: 230,
    inputUnavailableTokens: 30,
    cached: 50,
    cachedUnavailableTokens: 130,
    uncachedInput: 100,
    uncachedInputUnavailableTokens: 130,
    cacheRateInput: 150,
    cacheRateCached: 50,
    output: 50,
    outputUnavailableTokens: 30,
    reasoning: 7,
    reasoningUnavailableTokens: 130,
    unattributedDetailTokens: 130,
    inconsistentTokens: 0,
    reconciliationGap: 0,
  });
  assert.equal(cacheHitRate(Object.freeze(details)), 1 / 3);
});

test("empty results and known zero inputs have no cache hit rate", () => {
  assert.equal(cacheHitRate(aggregate([])), null);
  const details = aggregate([{ total: { total: 30, input: 0, cached: 0, output: 30, reasoning: 0 }, detailMask: 15 }]);
  assert.equal(details.total, 30);
  assert.equal(cacheHitRate(details), null);
});

test("both mask bits are required even when separate events provide input and cached totals", () => {
  const details = aggregate([
    { total: { total: 10, input: 10, cached: 0 }, detailMask: USAGE_DETAIL_MASK.input },
    { total: { total: 10, input: 0, cached: 5 }, detailMask: USAGE_DETAIL_MASK.cached },
  ]);
  assert.equal(details.input, 10);
  assert.equal(details.cached, 5);
  assert.equal(details.cacheRateInput, 0);
  assert.equal(details.cacheRateCached, 0);
  assert.equal(cacheHitRate(details), null);
});

test("validation excludes cached greater than input without discarding valid input totals", () => {
  const total = { total: 120, input: 100, cached: 101, output: 20, reasoning: 5 };
  const checked = validateUsageDetails(total, USAGE_DETAIL_MASK.complete);
  assert.equal(checked.detailMask & USAGE_DETAIL_MASK.cached, 0);
  assert.ok(checked.detailMask & USAGE_DETAIL_INCONSISTENT);
  const invalid = { total, ...checked };
  assert.equal(cacheHitRate(aggregate([invalid])), null);
  const details = aggregate([
    invalid,
    { total: { total: 60, input: 50, cached: 10, output: 10, reasoning: 2 }, detailMask: 15 },
  ]);
  assert.equal(details.total, 180);
  assert.equal(details.input, 150);
  assert.equal(details.cached, 10);
  assert.equal(details.cacheRateInput, 50);
  assert.equal(cacheHitRate(details), 1 / 5);
});

test("legacy events without a detail mask retain the existing complete-mask compatibility", () => {
  const total = { total: 120, input: 100, cached: 40, output: 20, reasoning: 5 };
  assert.deepEqual(aggregate([{ total }]), aggregate([{ total, detailMask: USAGE_DETAIL_MASK.complete }]));
  assert.equal(cacheHitRate(aggregate([{ total }])), 0.4);

  // addPeriodEvent historically treats absent legacy fields as known zero; explicit masks stay authoritative.
  const partial = { total: { total: 100, input: 100 } };
  assert.equal(cacheHitRate(aggregate([partial])), 0);
  assert.equal(cacheHitRate(aggregate([{ ...partial, detailMask: USAGE_DETAIL_MASK.input }])), null);
});

test("a known zero cache count is zero percent and a fully cached input is one", () => {
  assert.equal(cacheHitRate({ cacheRateInput: 150, cacheRateCached: 0 }), 0);
  assert.equal(cacheHitRate({ cacheRateInput: 150, cacheRateCached: 150 }), 1);
});

test("missing or invalid aggregate fields are unavailable instead of becoming known zero", () => {
  for (const details of [
    undefined,
    null,
    {},
    { input: 150, cached: 50 },
    { cacheRateInput: 150 },
    { cacheRateCached: 50 },
    { cacheRateInput: 0, cacheRateCached: 0 },
    { cacheRateInput: 150, cacheRateCached: null },
    { cacheRateInput: -150, cacheRateCached: 50 },
    { cacheRateInput: 150, cacheRateCached: -1 },
    { cacheRateInput: 150, cacheRateCached: 151 },
    { cacheRateInput: Number.POSITIVE_INFINITY, cacheRateCached: 50 },
    { cacheRateInput: 150, cacheRateCached: Number.NaN },
    { cacheRateInput: "150", cacheRateCached: "50" },
  ]) {
    assert.equal(cacheHitRate(details), null, JSON.stringify(details));
  }
});

test("usage metrics loads standalone without pricing or browser state", async () => {
  const source = await readFile(new URL("../public/usage-metrics.js", import.meta.url), "utf8");
  const metrics = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.equal(metrics.cacheHitRate({ cacheRateInput: 150, cacheRateCached: 50 }), 1 / 3);
});
