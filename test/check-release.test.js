import assert from "node:assert/strict";
import test from "node:test";
import { assertEditionPayload, commonUsageContract } from "../scripts/release-contracts.mjs";

function payload() {
  const total = { total: 120, input: 100, cached: 40, output: 20, reasoning: 5 };
  const group = { key: "source", name: "source", count: 1, sessions: 1, total };
  return {
    usageVersion: "real-publication-1",
    summary: {
      range: { asOf: "clock", start: "start", end: "end" },
      totals: total,
      details: { cacheRateInput: 100, cacheRateCached: 40 },
      cacheHitRate: 0.4,
      comparison: {},
      eventCount: 1,
      sessionCount: 1,
      homeCount: 1,
      timeline: [{ ...group, models: [group], channels: [group] }],
      channels: [group],
      models: [group],
      homes: [],
      projects: [],
      repositories: [],
      timelineError: null,
    },
    periodComparison: { asOf: "clock", periods: [], totals: { all: total }, models: [], repositories: [] },
    metadata: {
      generatedAt: "clock",
      eventCount: 1,
      sessionCount: 1,
      homeCount: 1,
      homes: [],
      warnings: [],
      calendarContext: { timeZone: "Asia/Shanghai" },
      imports: [],
    },
    quota: { asOf: "clock", windows: {} },
  };
}

test("release comparison keeps six-card, timeline, period and metadata values while excluding edition extensions", () => {
  const lite = payload(),
    waifu = structuredClone(lite);
  waifu.pricingCatalog = {};
  waifu.achievementShareReceipt = null;
  Object.assign(waifu.summary, { costEstimate: { pricedTokens: 120 }, records: {}, rangeMetrics: {} });
  waifu.summary.timeline[0].pricedTokens = 120;
  waifu.metadata.activeHarnessModels = {};
  waifu.periodComparison.asOf = "later";
  assertEditionPayload("lite", lite);
  assertEditionPayload("waifu", waifu);
  assert.deepEqual(commonUsageContract(lite), commonUsageContract(waifu));
  for (const mutate of [
    (p) => {
      p.summary.totals.input++;
    },
    (p) => {
      p.summary.cacheHitRate = 0.5;
    },
    (p) => {
      p.summary.timeline[0].sessions++;
    },
    (p) => {
      p.periodComparison.models.push({ key: "other" });
    },
    (p) => {
      p.metadata.eventCount++;
    },
  ]) {
    const changed = structuredClone(waifu);
    mutate(changed);
    assert.notDeepEqual(commonUsageContract(lite), commonUsageContract(changed));
  }
});

test("release boundaries reject missing common fields, residual nested pricing and absent Waifu calculations", () => {
  const p = payload();
  delete p.metadata.imports;
  assert.throws(() => commonUsageContract(p), /Missing common contract field: imports/);
  const nested = payload();
  nested.summary.timeline[0].models[0].costByModel = {};
  assert.throws(() => assertEditionPayload("lite", nested), /Lite exclusive field/);
  assert.throws(() => assertEditionPayload("waifu", payload()), /pricingCatalog/);
  const unversioned = payload();
  unversioned.usageVersion = "";
  assert.throws(() => assertEditionPayload("lite", unversioned), /usageVersion/);
});
