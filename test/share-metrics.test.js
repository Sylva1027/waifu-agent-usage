import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { summarizeUsage } from "../src/usage-core.js";
import { createShareCardData, SHARE_METRICS } from "../public/share-card-data.js";
import { coveredCalendarDays } from "../public/range-metrics.js";
import { createShareRangeFixture } from "../test-support/share-range-fixture.mjs";
import { UsageStore } from "../src/usage-store.js";

const row = (homeId, sessionId, model, total, time, extra = {}) => ({
  homeId,
  sessionId,
  model,
  timestamp: time,
  channel: "Codex",
  repositoryKey: "git:x",
  repositoryKind: "git",
  detailMask: 15,
  total: { total, input: total * 0.8, cached: total * 0.6, output: total * 0.2, reasoning: 0 },
  ...extra,
});

test("share choices omit retired, unknown and redundant day metrics in every single-day range", () => {
  const events = [row("a", "s", "gpt-6-sol", 100, "2026-01-15T12:00Z")];
  const project = (filters = {}, rows = events) =>
    createShareCardData(
      summarizeUsage({ events: rows }, { preset: "today", calendarZone: "utc", now: "2026-01-15T18:00Z", ...filters }),
    );
  const dayMetrics = ["activeDays", "dailyAverage", "activeAverage", "peakDay"];
  for (const filters of [{}, { preset: "custom", startDate: "2026-01-15", endDate: "2026-01-15" }, { preset: "all" }]) {
    const data = project(filters);
    for (const id of ["topModel", "topThree", "free", "freeShare", "review", ...dayMetrics])
      assert.ok(!data.availableMetrics.includes(id), `${JSON.stringify(filters)} hides ${id}`);
    assert.ok(data.availableMetrics.includes("reasoning"), "A known zero remains selectable");
    assert.ok(Object.isFrozen(data.availableMetrics));
  }
  const month = project({ preset: "month" });
  assert.equal(month.metricValues.activeDays, 1);
  for (const id of dayMetrics)
    assert.ok(month.availableMetrics.includes(id), `A month with one active day keeps ${id}`);
  const unknown = project({}, [
    row("a", "s", "unknown", 100, "2026-01-15T12:00Z", {
      detailMask: 1,
      total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
    }),
  ]);
  for (const id of ["cacheHit", "cached", "uncached", "output", "reasoning"])
    assert.ok(!unknown.availableMetrics.includes(id), `Unknown ${id} is not a menu choice`);
  const quota = project({
    preset: "quota_5h",
    quota: {
      asOf: "2026-01-15T01:00Z",
      windows: {
        quota_5h: { state: "available", windowStart: "2026-01-14T22:00Z", windowEndExclusive: "2026-01-15T03:00Z" },
      },
    },
  });
  for (const id of dayMetrics)
    assert.ok(!quota.availableMetrics.includes(id), `A 5h window crossing midnight hides ${id}`);
});

test("comparison choices require previous records in the selected source scope, not just range boundaries", () => {
  const current = row("a", "s", "gpt-6-sol", 100, "2026-01-15T12:00Z");
  const prior = row("b", "old", "gpt-6-sol", 50, "2025-01-05T12:00Z");
  const summary = (events, extra = {}) =>
    summarizeUsage(
      { events },
      { preset: "recent", recentValue: "今年", calendarZone: "utc", now: "2026-01-15T18:00Z", ...extra },
    );
  for (const s of [summary([current]), summary([current, prior], { excludeHomes: ["b"] })]) {
    assert.ok(s.comparison.previousRange);
    const data = createShareCardData(s);
    for (const id of ["previous", "delta", "growth"]) {
      assert.equal(data.metricValues[id], null);
      assert.ok(!data.availableMetrics.includes(id));
    }
  }
  const known = createShareCardData(summary([current, prior]));
  for (const id of ["previous", "delta", "growth"]) assert.ok(known.availableMetrics.includes(id));
  assert.equal(known.metricValues.growth, 1);
  const zero = summary([current, { ...prior, total: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 } }]);
  assert.ok(zero.comparison.previousEventCount > 0);
  const data = createShareCardData(zero);
  assert.ok(data.availableMetrics.includes("previous"));
  assert.ok(data.availableMetrics.includes("delta"));
  assert.ok(!data.availableMetrics.includes("growth"), "Growth cannot use a zero denominator");
});
test("all seventeen added numeric metrics and three chart modules match a hand-calculated cohort", () => {
  const events = [
    row("a", "s", "gpt-6-sol", 100, "2026-01-01T01:00Z"),
    row("a", "s", "codex-auto-review", 300, "2026-01-01T01:10Z"),
    row("b", "s", "openai/gpt-6-sol", 200, "2026-01-03T01:00Z"),
    row("c", "s", "claude-sonnet-5-5", 400, "2026-01-03T01:00Z", {
      repositoryKey: "directory:y",
      repositoryKind: "directory",
    }),
    row("d", "s", "hy4free", 500, "2026-01-03T01:00Z", {
      repositoryKey: "unknown:cwd",
      repositoryKind: "unknown",
      detailMask: 1,
      total: { total: 500, input: 500, cached: 0, output: 0, reasoning: 0 },
    }),
    row("a", "old", "gpt-6-sol", 100, "2025-12-31T01:00Z"),
  ];
  const report = {
    homes: [
      { id: "a", kind: "main" },
      { id: "b", kind: "codex" },
      { id: "c", kind: "claude" },
      { id: "d", kind: "hermes" },
    ],
    events,
  };
  const summary = summarizeUsage(report, {
    preset: "custom",
    startDate: "2026-01-01",
    endDate: "2026-01-03",
    now: "2026-01-03T12:00Z",
    calendarZone: "utc",
  });
  const data = createShareCardData(summary),
    m = data.metricValues;
  assert.equal(SHARE_METRICS.length, 25);
  assert.deepEqual(
    Object.fromEntries(
      [
        "harnesses",
        "providers",
        "repositories",
        "previous",
        "delta",
        "growth",
        "activeDays",
        "dailyAverage",
        "activeAverage",
        "peakDay",
        "peakHour",
        "maxSession",
        "free",
        "review",
      ].map((k) => [k, m[k]]),
    ),
    {
      harnesses: 3,
      providers: 3,
      repositories: 2,
      previous: 100,
      delta: 1400,
      growth: 14,
      activeDays: 2,
      dailyAverage: 500,
      activeAverage: 750,
      peakDay: 1100,
      peakHour: 1100,
      maxSession: 500,
      free: 500,
      review: 300,
    },
  );
  assert.equal(m.topModel, 1 / 3);
  assert.equal(m.topThree, 0.8);
  assert.equal(m.freeShare, 500 / 1500);
  assert.equal(m.cacheHit, 0.75);
  assert.deepEqual(data.charts.composition, { uncached: 200, cached: 600, output: 200, total: 1000 });
  assert.equal(
    data.charts.harnesses.reduce((sum, r) => sum + r.total, 0),
    1500,
  );
  assert.equal(
    data.charts.trend.reduce((sum, r) => sum + r.total, 0),
    1500,
  );
  assert.ok(Object.isFrozen(data.metricValues) && Object.isFrozen(data.charts.composition));
  assert.doesNotMatch(JSON.stringify(data), /git:x|directory:y|sessionId|homeId/);
  const excluded = summarizeUsage(
    { ...report, events: [...events, row("excluded", "s", "gpt-6-sol", 999, "2020-01-01")] },
    { preset: "all", excludeHomes: ["excluded"], now: "2026-01-03T12:00Z", calendarZone: "utc" },
  );
  assert.equal(createShareCardData(excluded).metricValues.dailyAverage, 400);
  const empty = createShareCardData(summarizeUsage({ events: [] }, { preset: "all" }));
  assert.equal(empty.metricValues.dailyAverage, null);
  assert.equal(empty.metricValues.freeShare, null);
  const paid = createShareCardData(
    summarizeUsage({ events: [row("a", "s", "custom-free", 100, "2026-01-01")] }, { preset: "all" }),
    { pricingModels: { "custom-free": {} } },
  );
  assert.equal(paid.metricValues.free, 0, "an exact paid entry overrides the free suffix");
});

test("free metrics exclude review usage while review remains in the total and its own metric", () => {
  const time = "2026-01-03T01:00Z";
  const reviews = ["codex-auto-review", "openai/codex-auto-review", "codex/CODEX-AUTO-REVIEW"].map((model, i) =>
    row("a", `review-${i}`, model, 100, time),
  );
  const project = (events) => createShareCardData(summarizeUsage({ events }, { preset: "all" }));
  const mixed = project([...reviews, row("a", "free", "hy4free", 600, time), row("a", "paid", "gpt-6-sol", 300, time)]);
  assert.equal(mixed.totals.total, 1200);
  assert.equal(mixed.metricValues.review, 300);
  assert.equal(mixed.metricValues.free, 600);
  assert.equal(mixed.metricValues.freeShare, 0.5);
  const onlyReview = project(reviews);
  assert.equal(onlyReview.totals.total, 300);
  assert.equal(onlyReview.metricValues.review, 300);
  assert.equal(onlyReview.metricValues.free, 0);
  assert.equal(onlyReview.metricValues.freeShare, 0);
  assert.equal(onlyReview.cost.amount, 0);
});

test("local day count follows calendar dates and repeated DST hours remain separate", () => {
  const code = `import assert from 'node:assert/strict';import {rangeHourStart,coveredCalendarDays} from ${JSON.stringify(new URL("../public/range-metrics.js", import.meta.url).href)};assert.notEqual(rangeHourStart(Date.parse('2026-11-01T05:30Z'),'local'),rangeHourStart(Date.parse('2026-11-01T06:30Z'),'local'));assert.equal(coveredCalendarDays({start:'2026-03-08T05:00Z',end:'2026-03-09T03:59:59Z',calendarZone:'local'},{}),1);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, TZ: "America/New_York" },
  });
  assert.equal(
    coveredCalendarDays(
      { start: null, end: null, asOf: "2026-01-03T12:00Z", calendarZone: "utc" },
      { first: Date.parse("2026-01-01"), last: Date.parse("2026-01-03") },
    ),
    3,
  );
});

test("stored metrics reuse unchanged aggregates and invalidate on fact correction", async () => {
  const fixture = await createShareRangeFixture(),
    store = new UsageStore(fixture.options);
  try {
    await store.sync();
    const filters = { preset: "all", calendarZone: "utc", now: fixture.now };
    const first = store.summarize(filters, { includeDetails: false });
    const cached = store.rangeMetricsCache;
    assert.ok(cached);
    const second = store.summarize(filters, { includeDetails: false });
    assert.equal(store.rangeMetricsCache, cached);
    assert.deepEqual(second.rangeMetrics, first.rangeMetrics);
    store.database.exec("UPDATE events SET total=total+100, input=input+100 WHERE id=(SELECT MIN(id) FROM events)");
    const corrected = store.summarize(filters, { includeDetails: false });
    assert.notEqual(store.rangeMetricsCache, cached);
    assert.equal(corrected.rangeMetrics.composition.total, first.rangeMetrics.composition.total + 100);
    store.close();
    assert.equal(store.rangeMetricsCache, null);
    await store.open();
    assert.equal(store.rangeMetricsCache, null);
    assert.deepEqual(store.summarize(filters, { includeDetails: false }).rangeMetrics, corrected.rangeMetrics);
  } finally {
    store.close();
    await fixture.close();
  }
});

test("SQL local statistics follow the JS calendar even when TZ differs from the host", () => {
  const code = `import assert from 'node:assert/strict';import {UsageStore} from ${JSON.stringify(new URL("../src/usage-store.js", import.meta.url).href)};import {createShareRangeFixture} from ${JSON.stringify(new URL("../test-support/share-range-fixture.mjs", import.meta.url).href)};const f=await createShareRangeFixture(),s=new UsageStore(f.options);try{await s.sync();s.database.exec("UPDATE events SET timestamp_ms=CASE WHEN id%2=0 THEN 1793514600000 ELSE 1793511000000 END");const m=s.rangeMetrics({preset:'all',calendarZone:'local'},[]);assert.equal(m.activeDays,1);assert.equal(m.peakHour.total,6000000);}finally{s.close();await f.close();}`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, TZ: "America/New_York" },
  });
});
