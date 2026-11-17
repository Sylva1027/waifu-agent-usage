import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { resolveDateRange, previousUsageRange, summarizeUsage } from "../src/usage-core.js";
import { canonicalRecentValue, displayRecentValue } from "../public/i18n.js";
import { createPricingPolicyFixture } from "../test-support/pricing-official-fixture.mjs";
import { UsageStore } from "../src/usage-store.js";

test("last year uses complete calendar years and year comparisons clamp leap days", () => {
  for (const [now, start, end] of [
    ["2026-11-15T12:00:00Z", "2025-01-01T00:00:00.000Z", "2025-12-31T23:59:59.999Z"],
    ["2025-01-01T00:00:00Z", "2024-01-01T00:00:00.000Z", "2024-12-31T23:59:59.999Z"],
  ]) {
    const range = resolveDateRange({ preset: "recent", recentValue: "去年", calendarZone: "utc", now });
    assert.equal(range.start.toISOString(), start);
    assert.equal(range.end.toISOString(), end);
    assert.equal(range.bucket, "month");
    assert.equal(range.recentValue, "去年");
    assert.equal(previousUsageRange(range).end.getTime(), range.start.getTime() - 1);
  }
  const year = resolveDateRange({
    preset: "recent",
    recentValue: "今年",
    calendarZone: "utc",
    now: "2024-02-29T12:00:00Z",
  });
  assert.equal(previousUsageRange(year).end.toISOString(), "2023-02-28T23:59:59.999Z");
  const month = resolveDateRange({ preset: "recent", recentValue: "上个月", calendarZone: "utc", now: "2024-03-15" });
  assert.equal(previousUsageRange(month).start.toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal(previousUsageRange(month).end.toISOString(), "2024-01-31T23:59:59.999Z");
  assert.equal(canonicalRecentValue("Last Year"), "去年");
  assert.equal(displayRecentValue("去年", "en-US"), "Last Year");
});

test("local year boundaries use the selected non-UTC calendar", () => {
  const code = `import assert from 'node:assert/strict';import {resolveDateRange} from ${JSON.stringify(new URL("../src/usage-core.js", import.meta.url).href)};const r=resolveDateRange({preset:'recent',recentValue:'去年',calendarZone:'local',now:'2026-01-01T01:00:00Z'});assert.equal(r.start.toISOString(),'2024-01-01T05:00:00.000Z');assert.equal(r.end.toISOString(),'2025-01-01T04:59:59.999Z');`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, TZ: "America/New_York" },
  });
});

test("range details preserve known cohorts and named identity across SQL and memory, including open bounds", async () => {
  const fixture = createPricingPolicyFixture();
  const store = new UsageStore(fixture.options);
  try {
    await store.sync();
    const report = await store.publishedHistoryUsageReport();
    for (const selection of [
      { preset: "today" },
      { preset: "week" },
      { preset: "month" },
      { preset: "all" },
      { preset: "recent", recentValue: "上个月" },
      { preset: "recent", recentValue: "今年" },
      { preset: "recent", recentValue: "去年" },
      { preset: "custom", startDate: "2026-01-01" },
      { preset: "custom", endDate: "2026-12-31" },
      { preset: "custom" },
    ]) {
      const filters = { ...fixture.filters, ...selection, now: new Date(fixture.filters.now), calendarZone: "utc" };
      const memory = summarizeUsage(report, filters),
        payload = await store.dashboardHistory(filters, { includeDetails: false });
      assert.deepEqual(payload.summary.details, memory.details, JSON.stringify(selection));
      assert.deepEqual(payload.summary.rangeMetrics, memory.rangeMetrics, JSON.stringify(selection));
      assert.equal(payload.summary.range.recentValue, memory.range.recentValue);
      assert.equal(payload.summary.range.asOf, memory.range.asOf);
    }
    const s = await store.dashboardHistory(
      { ...fixture.filters, now: new Date(fixture.filters.now), preset: "all" },
      { includeDetails: false },
    );
    assert.equal(s.summary.details.uncachedInput, 480);
    assert.equal(s.summary.details.uncachedInputUnavailableTokens, 600);
  } finally {
    store.close();
    fixture.close();
  }
});
