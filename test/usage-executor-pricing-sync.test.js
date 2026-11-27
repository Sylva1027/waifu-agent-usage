import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { createRemainingHarnessFixture, insertDatabaseEvent } from "../test-support/remaining-harness-fixture.mjs";

const filters = { preset: "all", calendarZone: "utc", bucket: "day" };
function assertQuote({ summary, pricingCatalog }, catalog, eventCount, totalUsd) {
  assert.equal(summary.eventCount, eventCount);
  assert.equal(pricingCatalog.version, catalog.version);
  assert.deepEqual(summary.costEstimate.priceVersions, [catalog.version]);
  assert.equal(summary.costEstimate.usdToCnyRate, catalog.usdToCnyRate);
  assert.equal(summary.costEstimate.pricedRecords, eventCount);
  assert.ok(
    Math.abs(summary.costEstimate.totalUsd - totalUsd) < 1e-12,
    `expected USD ${totalUsd}, received ${summary.costEstimate.totalUsd}`,
  );
}
function database(file, operation) {
  const db = new DatabaseSync(file);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}
async function fixture(t, { pause = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "executor-pricing-sync-"));
  const original = getPricingCatalog(),
    argv = [...process.execArgv];
  const home = path.join(root, ".zcode"),
    directory = path.join(home, "cli", "db");
  const input = createRemainingHarnessFixture(directory, "zcode", 3);
  const sourceFile = path.join(directory, "db.sqlite");
  renameSync(input.filePath, sourceFile);
  const options = {
    homeDir: root,
    env: {},
    importDirs: [home],
    databaseFile: path.join(root, "index.sqlite"),
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
  let catalog = setPricingCatalog({
    ...original,
    checkedAt: "2026-11-06",
    usdToCnyRate: 7.123,
    models: {
      ...original.models,
      "gpt-6-sol": { currency: "USD", short: { input: 2, cachedInput: 2, cacheWrite: 2, output: 2 } },
    },
  });
  const clients = [];
  const marker = (name) => path.join(root, name);
  if (pause) {
    const hook = `import {registerHooks} from 'node:module';registerHooks({load(url,ctx,next){
      const result=next(url,ctx);if(!url.endsWith('/src/usage-store.js'))return result;
      return {...result,source:result.source+${JSON.stringify(`
        import {existsSync as pricingGateExists,renameSync as pricingGateRename,writeFileSync as pricingGateWrite} from 'node:fs';
        const pricingSyncReplace=UsageStore.prototype.replaceFile;
        UsageStore.prototype.replaceFile=async function(file,...args){
          if(file.source.kind==='zcode'&&pricingGateExists(${JSON.stringify(marker("gate"))})){
            // Publish the marker only after its contents have been written.
            pricingGateWrite(${JSON.stringify(marker("entering"))},'ready');
            pricingGateRename(${JSON.stringify(marker("entering"))},${JSON.stringify(marker("entered"))});
            const deadline=Date.now()+30000;
            while(!pricingGateExists(${JSON.stringify(marker("release"))})){
              if(Date.now()>deadline)throw new Error('pricing sync gate timed out');
              await new Promise(resolve=>setTimeout(resolve,10));
            }
            const summary=await this.summarizeHistory(${JSON.stringify(filters)},{includeDetails:false});
            pricingGateWrite(${JSON.stringify(marker("resumed"))},JSON.stringify({summary,pricingCatalog:getPricingCatalog()}));
          }
          return pricingSyncReplace.call(this,file,...args);
        };
      `)}};}});`;
    process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(hook)}`);
  }
  t.after(async () => {
    writeFileSync(marker("release"), "release");
    for (const client of clients) await client.close();
    process.execArgv.splice(0, process.execArgv.length, ...argv);
    setPricingCatalog(original);
    rmSync(root, { recursive: true, force: true });
  });
  const open = () => {
    const client = createUsageExecutor(options, { pricing: () => catalog, idleTimeoutMs: 60_000 });
    clients.push(client);
    return client;
  };
  const rows = () => database(options.databaseFile, (db) => db.prepare("SELECT * FROM events ORDER BY id").all());
  const revision = () =>
    database(options.databaseFile, (db) => db.prepare("SELECT revision FROM usage_business_revision").get().revision);
  return {
    open,
    options,
    rows,
    revision,
    marker,
    append: (index) => database(sourceFile, (db) => insertDatabaseEvent(db, "zcode", index)),
    get catalog() {
      return catalog;
    },
    reprice: () =>
      (catalog = setPricingCatalog({
        ...catalog,
        usdToCnyRate: 8.123,
        models: {
          ...catalog.models,
          "gpt-6-sol": { currency: "USD", short: { input: 5, cachedInput: 5, cacheWrite: 5, output: 5 } },
        },
      })),
  };
}

test("sync keeps raw facts unpriced while queries use authoritative prices on warm reuse and restart", async (t) => {
  const f = await fixture(t);
  let client = f.open();
  await client.sync({ options: f.options });
  const initial = f.rows();
  assert.equal(initial.length, 3);
  assert.deepEqual([...new Set(initial.map((row) => row.price_version))], [""]);
  // Fixture totals are 160 + index; every token costs USD 2 (then 5) per million.
  assertQuote(await client.dashboard(filters, { includeDetails: false }), f.catalog, 3, 0.000966);
  let before = f.revision();
  await client.sync({ options: f.options });
  assert.deepEqual(f.rows(), initial);
  assert.equal(f.revision(), before, "unchanged directory sync must not rewrite facts");
  assertQuote(await client.dashboard(filters, { includeDetails: false }), f.catalog, 3, 0.000966);
  f.append(3);
  await client.sync({ options: f.options });
  assert.deepEqual(f.rows().slice(0, 3), initial);
  assert.equal(f.revision() - before, 1, "warm append must only insert its new fact");
  assertQuote(await client.dashboard(filters, { includeDetails: false }), f.catalog, 4, 0.001292);
  const warm = f.rows();
  await client.close();
  client = f.open();
  before = f.revision();
  f.append(4);
  await client.sync({ options: f.options });
  assert.equal(f.revision() - before, 1, "restart must only insert the new fact");
  assert.deepEqual(f.rows().slice(0, 4), warm);
  assert.ok(f.rows().every((row) => row.price_version === ""));
  assertQuote(await client.dashboard(filters, { includeDetails: false }), f.catalog, 5, 0.00162);
  const facts = f.rows(),
    version = f.catalog.version;
  before = f.revision();
  f.reprice();
  assert.notEqual(f.catalog.version, version);
  assertQuote(await client.dashboard(filters, { includeDetails: false }), f.catalog, 5, 0.00405);
  assert.deepEqual(f.rows(), facts, "repricing must not change original facts");
  assert.equal(f.revision(), before);
  f.append(5);
  before = f.revision();
  await client.sync({ options: f.options });
  assert.equal(f.revision() - before, 1, "a new catalog must not cause full fact replacement");
  assert.deepEqual(f.rows().slice(0, 5), facts);
  assert.ok(f.rows().every((row) => row.price_version === ""));
  assertQuote(await client.dashboard(filters, { includeDetails: false }), f.catalog, 6, 0.004875);
});

test("a concurrent dashboard catalog cannot change the catalog captured by an awaiting sync", async (t) => {
  const f = await fixture(t, { pause: true });
  const client = f.open();
  await client.sync({ options: f.options });
  const captured = f.catalog,
    initial = f.rows();
  assertQuote(await client.dashboard(filters, { includeDetails: false }), captured, 3, 0.000966);
  f.append(3);
  writeFileSync(f.marker("gate"), "pause");
  const before = f.revision(),
    pending = client.sync({ options: f.options });
  const deadline = Date.now() + 30_000;
  try {
    while (!existsSync(f.marker("entered"))) {
      assert.ok(Date.now() < deadline, "sync never reached its source parser");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(readFileSync(f.marker("entered"), "utf8"), "ready");
    f.reprice();
    assert.notEqual(f.catalog.version, captured.version);
    const response = await client.dashboard(filters, { includeDetails: false });
    assert.equal(response.summary.eventCount, 3, "the concurrent reader sees the committed version");
    assertQuote(response, f.catalog, 3, 0.002415);
  } finally {
    writeFileSync(f.marker("release"), "release");
    await pending;
  }
  assertQuote(JSON.parse(readFileSync(f.marker("resumed"), "utf8")), captured, 3, 0.000966);
  assert.deepEqual(f.rows().slice(0, 3), initial);
  assert.deepEqual([...new Set(f.rows().map((row) => row.price_version))], [""]);
  assert.equal(f.revision() - before, 1);
  assertQuote(await client.dashboard(filters, { includeDetails: false }), f.catalog, 4, 0.00323);
});
