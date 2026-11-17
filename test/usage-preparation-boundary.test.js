import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { UsageStore } from "../src/usage-store.js";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";

function persistentSnapshot(database) {
  return database
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((table) => ({
      ...table,
      rows: database.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all(),
    }));
}

async function fixture(t) {
  const input = createLiteEditionFixture();
  const store = new UsageStore(input.options);
  t.after(() => {
    store.close();
    input.close();
  });
  await store.sync();
  return { input, store };
}

test("prepared summary, metadata and periods read without persistent preparation or writes", async (t) => {
  const { input, store } = await fixture(t);
  store.prepareUsageRead(input.filters, {}, { summary: true, metadata: true, periods: true });
  for (const name of [
    "prepareHotRollups",
    "prepareQuotaProjection",
    "prepareRecordProjection",
    "prepareAllSummaryProjection",
    "prepareMetadataProjection",
  ])
    t.mock.method(store, name, () => {
      throw new Error(`implicit preparation: ${name}`);
    });
  const before = persistentSnapshot(store.database);
  store.database.exec("BEGIN");
  store.summarySnapshotRead = store.metadataSnapshotRead = store.periodComparisonSnapshotRead = true;
  try {
    assert.equal(store.summarizeInReadTransaction(input.filters).totals.total, 310);
    assert.equal(store.readMetadata(new Date(input.filters.now)).eventCount, 4);
    assert.equal(store.readPeriodComparison(input.filters).totals.all.total, 310);
    assert.deepEqual(persistentSnapshot(store.database), before);
  } finally {
    store.summarySnapshotRead = store.metadataSnapshotRead = store.periodComparisonSnapshotRead = false;
    store.database.exec("ROLLBACK");
  }
});

test("a fact commit between preparation and capture retries before returning one dashboard", async (t) => {
  const { input, store } = await fixture(t);
  const external = new DatabaseSync(input.options.databaseFile);
  const prepare = store.prepareUsageRead;
  let prepared = 0;
  t.mock.method(store, "prepareUsageRead", function (...args) {
    const view = prepare.apply(this, args);
    if (++prepared === 1)
      external.exec("UPDATE events SET total=total+1,input=input+1 WHERE id=(SELECT MIN(id) FROM events)");
    return view;
  });
  try {
    const result = await store.dashboardHistory(input.filters);
    assert.equal(prepared, 2, "the stale prepared view was refused");
    assert.equal(result.summary.totals.total, 311);
    assert.equal(result.periodComparison.totals.all.total, 311);
    assert.equal(result.metadata.eventCount, 4);
    assert.equal(store.database.isTransaction, false);
  } finally {
    external.close();
  }
});
