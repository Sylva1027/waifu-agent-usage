import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { buildUsageReport, buildUsageIndex } from "../src/usage-sources.js";
import { summarizeUsage, summarizeUsageIndex } from "../src/usage-summary.js";
import { summarizeUsage as summarizeWaifuUsage } from "../src/usage-core.js";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";

test("literal, parsed and compact usage summaries match the independent four-event contract", async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const report = await buildUsageReport(fixture.options);
  const index = await buildUsageIndex(fixture.options);
  for (const summary of [
    summarizeUsage(fixture.report, fixture.filters),
    summarizeUsage(report, fixture.filters),
    summarizeUsageIndex(index, fixture.filters),
  ]) {
    assert.deepEqual(summary.totals, fixture.expected.totals);
    assert.equal(summary.cacheHitRate, 1 / 3);
    assert.equal(summary.details.cacheRateInput, 150);
    assert.equal(summary.details.cacheRateCached, 50);
    assert.equal(summary.eventCount, 4);
    for (const name of ["costEstimate", "rangeMetrics", "records"]) assert.equal(Object.hasOwn(summary, name), false);
    for (const row of summary.timeline) {
      for (const name of ["costByModel", "pricedTokens", "pricingStatus", "scenarioReasons"])
        assert.equal(Object.hasOwn(row, name), false);
    }
  }
  const waifu = summarizeWaifuUsage(report, fixture.filters);
  assert.equal(waifu.cacheHitRate, 1 / 3);
  assert.ok(waifu.costEstimate.pricedTokens > 0);
  assert.ok(waifu.rangeMetrics);
});

test("real pure report and compact-index pipelines run with every Waifu dependency forbidden", async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const probe = createLiteBoundaryProbe(fixture.root, {
    forbiddenModules: [
      "src/usage-core.js",
      "src/pricing.js",
      "src/pricing-store.js",
      "src/usage-record-store.js",
      "public/pricing-models.js",
      "public/range-metrics.js",
      "public/waifu-timeline.js",
      "src/achievement-runtime.js",
      "src/achievement-store.js",
      "src/achievement-hermes-source.js",
      "src/waifu/usage-source-evidence.js",
      "src/waifu/usage-summary.js",
    ],
  });
  const source = new URL("../src/usage-sources.js", import.meta.url).href;
  const summary = new URL("../src/usage-summary.js", import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const {buildUsageReport,buildUsageIndex}=await import(${JSON.stringify(source)});
    const {summarizeUsage,summarizeUsageIndex}=await import(${JSON.stringify(summary)});
    const options=${JSON.stringify(fixture.options)},filters=${JSON.stringify(fixture.filters)};
    const report=await buildUsageReport(options),index=await buildUsageIndex(options);
    console.log(JSON.stringify([summarizeUsage(report,filters).cacheHitRate,summarizeUsageIndex(index,filters).cacheHitRate]));
  `,
    ],
    { env: probe.env, windowsHide: true },
  );
  assert.deepEqual(JSON.parse(stdout), [1 / 3, 1 / 3]);
  assert.equal(probe.read().filter((entry) => entry.forbidden).length, 0);
});
