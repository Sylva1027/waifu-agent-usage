import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { UsageStore } from "../src/usage-store-lite.js";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";

const forbiddenModules = [
  "src/usage-store.js",
  "src/usage-core.js",
  "src/pricing.js",
  "src/pricing-store.js",
  "src/usage-record-store.js",
  "src/history-quote-inputs.js",
  "src/service-tier-evidence.js",
  "src/achievement-store.js",
  "src/achievement-runtime.js",
  "src/waifu/usage-reader.js",
  "public/range-metrics.js",
  "public/pricing-models.js",
  "public/waifu-timeline.js",
];

test("the Lite fact store scans and serves the independent four-event contract", async (t) => {
  const fixture = createLiteEditionFixture();
  const store = new UsageStore(fixture.options);
  t.after(() => {
    try {
      store.close();
    } finally {
      fixture.close();
    }
  });
  await store.sync();
  const before = store.database.prepare("SELECT revision FROM usage_business_revision").get().revision;
  const dashboard = await store.dashboardHistory(fixture.filters, { includeDetails: true });
  assert.deepEqual(dashboard.summary.totals, fixture.expected.totals);
  assert.equal(dashboard.summary.cacheHitRate, 1 / 3);
  for (const key of ["costEstimate", "rangeMetrics", "records"]) assert.equal(key in dashboard.summary, false);
  for (const key of ["eventCostMemo", "recordChampionCache", "rangeMetricsCache", "serviceTierEvidence"])
    assert.equal(key in store, false);
  assert.equal(store.database.prepare("SELECT revision FROM usage_business_revision").get().revision, before);
  assert.equal(
    store.database
      .prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'usage_record_%'")
      .get().n,
    0,
  );
  const pinned = store.acquirePublishedHotReader();
  try {
    assert.equal(pinned instanceof UsageStore, false);
    assert.deepEqual((await pinned.dashboardHistory(fixture.filters)).summary.totals, fixture.expected.totals);
  } finally {
    pinned.close();
  }
});

test("the complete Lite fact and hot query entry runs with Waifu dependencies prohibited", async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const probe = createLiteBoundaryProbe(fixture.root, { forbiddenModules });
  const entry = new URL("../src/usage-store-lite.js", import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const {UsageStore}=await import(${JSON.stringify(entry)});
    const store=new UsageStore(${JSON.stringify(fixture.options)});
    try { await store.sync(); console.log(JSON.stringify((await store.dashboardHistory(${JSON.stringify(fixture.filters)})).summary.totals)); }
    finally {store.close();}
  `,
    ],
    { env: probe.env, windowsHide: true },
  );
  assert.deepEqual(JSON.parse(stdout), fixture.expected.totals);
  assert.equal(probe.read().filter((row) => row.forbidden).length, 0);
});
