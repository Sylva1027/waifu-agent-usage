import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { UsageStore } from "../src/usage-store.js";
import { UsageReader } from "../src/usage-reader.js";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";

test("the real store delegates SQL reads to a reusable view with no writing resources", async (t) => {
  const fixture = createLiteEditionFixture();
  const store = new UsageStore(fixture.options);
  t.after(() => {
    store.close();
    fixture.close();
  });
  await store.sync();
  const view = store.usageReadView();
  assert.ok(view instanceof UsageReader);
  assert.equal(view.metadata().eventCount, 4);
  assert.equal(view.metadata().homes[0].status, "active");
  assert.equal(Object.hasOwn(view.metadata(), "activeHarnessModels"), false);
  assert.equal(Object.hasOwn(view.metadata(), "harnessModels"), false);
  const summary = view.summarize(fixture.filters);
  assert.deepEqual(summary.totals, fixture.expected.totals);
  assert.equal(summary.cacheHitRate, 1 / 3);
  assert.equal(view.periodComparison(fixture.filters).totals.all.total, 310);
  for (const name of ["costEstimate", "rangeMetrics", "records"]) assert.equal(name in summary, false);
  const compact = view.summarize(fixture.filters, { includeDetails: false });
  for (const name of ["homes", "projects", "repositories"]) assert.equal(name in compact, false);
  for (const name of [
    "sourceProof",
    "sourceAcquisition",
    "repositoryResolver",
    "eventCostMemo",
    "options",
    "open",
    "sync",
    "replaceFile",
  ])
    assert.equal(name in view, false, name);
  const range = { preset: "all", start: null, end: null };
  assert.equal(store.aggregateRange(range).total, 310);
  assert.equal(store.usageReadView(), view);
  store.commitStoreRevision("reader-fixture");
  const replacement = store.usageReadView();
  assert.notEqual(replacement, view);
  assert.equal(view.database, null);
  assert.equal(replacement.aggregateRange(range).total, 310);
  replacement.close();
  assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 4);
  assert.equal(store.aggregateRange(range).total, 310);
});

test("a read-only SQL view runs independently with store and all Waifu dependencies prohibited", async (t) => {
  const fixture = createLiteEditionFixture();
  const store = new UsageStore(fixture.options);
  t.after(() => {
    store.close();
    fixture.close();
  });
  await store.sync();
  const probe = createLiteBoundaryProbe(fixture.root, {
    forbiddenModules: [
      "src/usage-store.js",
      "src/usage-core.js",
      "src/usage-sources.js",
      "src/usage-source-proof.js",
      "src/pricing.js",
      "src/usage-record-store.js",
      "public/pricing-models.js",
      "public/range-metrics.js",
      "src/achievement-store.js",
      "src/achievement-runtime.js",
    ],
  });
  const entry = new URL("../src/usage-reader.js", import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {DatabaseSync} from 'node:sqlite';
    const {UsageReader}=await import(${JSON.stringify(entry)});
    const database=new DatabaseSync(${JSON.stringify(fixture.options.databaseFile)},{readOnly:true});
    const reader=new UsageReader({database});
    const range={preset:'all',start:null,end:null};
    try {
      const totals=reader.aggregateRange(range),details=reader.rangeDetails(range);
      const groups=reader.groupedRange('home_label',range);
      const repositories=reader.repositoriesRange(range);
      const summary=reader.summarize(${JSON.stringify(fixture.filters)});
      const periods=reader.periodComparison(${JSON.stringify(fixture.filters)});
      console.log(JSON.stringify([totals.total,details.cacheRateInput,details.cacheRateCached,groups[0].total.total,repositories[0].total.total,summary.cacheHitRate,periods.totals.all.total]));
    } finally {reader.close(); database.close();}
  `,
    ],
    { env: probe.env, windowsHide: true },
  );
  assert.deepEqual(JSON.parse(stdout), [310, 150, 50, 310, 310, 1 / 3, 310]);
  assert.equal(probe.read().filter((entry) => entry.forbidden).length, 0);
});
