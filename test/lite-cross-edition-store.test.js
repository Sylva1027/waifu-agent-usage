import assert from "node:assert/strict";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { UsageStore as WaifuStore } from "../src/usage-store.js";
import { UsageStore as LiteStore } from "../src/usage-store-lite.js";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";

test("a busy source replacement cannot acknowledge a partially indexed scan", async (t) => {
  const fixture = createLiteEditionFixture();
  const store = new LiteStore(fixture.options);
  let writer;
  try {
    await store.sync();
    const original = await readFile(fixture.rolloutFiles[0], "utf8");
    await writeFile(fixture.rolloutFiles[0], original.replace('"total_tokens":120', '"total_tokens":220'));
    writer = new DatabaseSync(fixture.options.databaseFile);
    store.database.exec("PRAGMA busy_timeout = 0");
    const replaceFile = store.replaceFile;
    const locked = t.mock.method(store, "replaceFile", async function (...args) {
      writer.exec("BEGIN IMMEDIATE");
      try {
        return await replaceFile.apply(this, args);
      } finally {
        writer.exec("ROLLBACK");
      }
    });
    await assert.rejects(store.sync({ forceFull: true }), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    assert.ok(locked.mock.callCount() > 0);
    locked.mock.restore();
    await store.sync();
    assert.equal(store.summarize(fixture.filters).totals.total, 410);
  } finally {
    writer?.close();
    store.close();
    fixture.close();
  }
});

function waifuRows(database) {
  const names = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'usage_record_%' OR (name LIKE 'usage_all_summary_%' AND name NOT LIKE 'usage_all_summary_usage_%')) ORDER BY name",
    )
    .all();
  return names.map(({ name }) => [
    name,
    database
      .prepare(`SELECT * FROM ${name}`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort(),
  ]);
}

test("Lite changes facts without maintaining Waifu caches; Waifu reentry rebuilds uncovered records", async (t) => {
  const fixture = createLiteEditionFixture();
  let store;
  t.after(() => {
    try {
      store?.close();
    } finally {
      fixture.close();
    }
  });
  const line = (date, total) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: date,
      payload: { type: "token_count", info: { last_token_usage: { total_tokens: total, input_tokens: total } } },
    }) + String.fromCharCode(10);
  await appendFile(fixture.rolloutFiles[0], line("2026-11-14T12:00:00Z", 10) + line("2026-11-15T12:00:00Z", 20));
  const filters = {
    preset: "custom",
    startDate: "2026-11-16",
    endDate: "2026-11-16",
    calendarZone: "utc",
    now: "2026-11-17T12:00:00Z",
  };
  store = new WaifuStore(fixture.options);
  await store.sync();
  assert.equal(store.summarize(filters, { includeDetails: false }).records.totalTokens.value, 310);
  store.summarize({ ...filters, preset: "all" }, { includeDetails: false });
  const before = waifuRows(store.database);
  const revision = store.database.prepare("SELECT revision FROM usage_business_revision").get().revision;
  store.close();
  store = new LiteStore(fixture.options);
  await store.sync();
  assert.equal(
    store.database.prepare("SELECT revision FROM usage_business_revision").get().revision,
    revision,
    "edition change alone must not rewrite facts",
  );
  const file = await readFile(fixture.rolloutFiles[0], "utf8");
  await writeFile(fixture.rolloutFiles[0], file.replace('"total_tokens":120', '"total_tokens":220'));
  await store.sync();
  const lite = await store.dashboardHistory({ ...filters, preset: "all" }, { includeDetails: false });
  assert.equal(lite.summary.totals.total, 440);
  assert.deepEqual(
    waifuRows(store.database),
    before,
    "the Lite actor must leave all existing Waifu derived rows untouched",
  );
  assert.equal("costEstimate" in lite.summary, false);
  store.close();
  store = new WaifuStore(fixture.options);
  await store.open();
  const recovered = store.summarize(filters, { includeDetails: false });
  assert.equal(recovered.records.totalTokens.value, 410);
  assert.ok(recovered.costEstimate);
  assert.equal(store.summarize({ ...filters, preset: "all" }, { includeDetails: false }).totals.total, 440);
});
