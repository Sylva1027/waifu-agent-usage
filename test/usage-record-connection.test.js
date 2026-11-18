import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { removeLegacyUsageRecordTriggers } from "../src/usage-record-migration.js";
import {
  buildStoredRecordChampions,
  ensureUsageRecordSchema,
  readStoredRecordChampions,
  USAGE_RECORD_TABLE_NAMES,
} from "../src/usage-record-store.js";

const NAMES = ["usage_record_dirty_insert", "usage_record_dirty_update", "usage_record_dirty_delete"];
const estimateRow = () => ({ currency: "USD", totalUsd: 0, inputUsd: 0, cachedInputUsd: 0, outputUsd: 0 });
const options = (database) => ({ database, key: "connection-records", factsKey: "same-key", zone: "utc", estimateRow });
const triggers = (database, schema) =>
  database
    .prepare(
      `SELECT name FROM ${schema}.sqlite_schema WHERE type='trigger' AND name LIKE 'usage_record_dirty_%' ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
const revision = (database) => database.prepare("SELECT revision FROM usage_business_revision").get().revision;
const snapshot = (database) =>
  USAGE_RECORD_TABLE_NAMES.map((name) => [name, database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);

function createFacts(database) {
  database.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL,
    day_key TEXT NOT NULL,week_key TEXT NOT NULL,month_key TEXT NOT NULL,
    session_id TEXT DEFAULT 's',model TEXT DEFAULT 'm',channel TEXT DEFAULT 'CLI',home_id TEXT DEFAULT 'home',
    total REAL NOT NULL,input REAL DEFAULT 0,cached REAL DEFAULT 0,output REAL DEFAULT 0,reasoning REAL DEFAULT 0,
    detail_mask INTEGER DEFAULT 0,cache_write_tokens INTEGER DEFAULT 0,cache_write_known INTEGER DEFAULT 0,
    request_input_tokens INTEGER DEFAULT 0,context_level TEXT DEFAULT 'unknown',service_tier TEXT DEFAULT 'unknown');
    CREATE TABLE usage_business_revision(singleton INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
    INSERT INTO usage_business_revision VALUES(1,0);`);
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    database.exec(`CREATE TRIGGER usage_business_events_${operation} AFTER ${operation} ON events BEGIN
      UPDATE usage_business_revision SET revision=revision+1 WHERE singleton=1; END`);
  }
}

function insert(database, id, total, day = Math.floor(id / 10) + 9, replace = false) {
  const date = `2026-07-${String(day).padStart(2, "0")}`;
  database
    .prepare(`INSERT ${replace ? "OR REPLACE" : ""} INTO main.events
    (id,timestamp_ms,day_key,week_key,month_key,total) VALUES(?,?,?,?,?,?)`)
    .run(id, Date.parse(`${date}T01:00:00Z`), date, "2026-07-06", "2026-07", total);
}

function legacy(database) {
  database.exec("CREATE TABLE legacy_writes(n INTEGER); INSERT INTO legacy_writes VALUES(0)");
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    database.exec(`CREATE TRIGGER usage_record_dirty_${operation.toLowerCase()} AFTER ${operation} ON events
      BEGIN UPDATE legacy_writes SET n=n+1; END`);
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "usage-record-connection-"));
  const file = path.join(root, "facts.sqlite");
  const waifu = new DatabaseSync(file);
  const lite = new DatabaseSync(file);
  const value = { waifu, lite, file };
  t.after(async () => {
    for (const database of [value.waifu, lite]) {
      if (database.isTransaction) database.exec("ROLLBACK");
      database.close();
    }
    await rm(root, { recursive: true, force: true });
  });
  waifu.exec("PRAGMA journal_mode=WAL");
  createFacts(waifu);
  ensureUsageRecordSchema(waifu);
  insert(waifu, 10, 300);
  insert(waifu, 20, 200);
  insert(waifu, 30, 100);
  return value;
}

test("pure migration imports no record implementation, with a forbidden-import positive control", () => {
  const projectUrl = new URL("../", import.meta.url).href;
  const migration = new URL("../src/usage-record-migration.js", import.meta.url).href;
  const records = new URL("../src/usage-record-store.js", import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { DatabaseSync } from 'node:sqlite';
    const projectUrl = ${JSON.stringify(projectUrl)};
    registerHooks({resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (resolved.url.startsWith(projectUrl) &&
          /usage-record-store|pricing|waifu|achievement/.test(resolved.url.slice(projectUrl.length))) {
        throw new Error('forbidden record implementation');
      }
      return resolved;
    }});
    const { removeLegacyUsageRecordTriggers } = await import(${JSON.stringify(migration)});
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE events(id); CREATE TRIGGER usage_record_dirty_insert AFTER INSERT ON events BEGIN SELECT 1; END');
    assert.equal(removeLegacyUsageRecordTriggers(database), true);
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(x=>x.name), ['events']);
    await assert.rejects(import(${JSON.stringify(records)}), /forbidden record implementation/);
    database.close();
  `,
    ],
    { stdio: "pipe", windowsHide: true },
  );
});

test("legacy removal rolls back all three drops on failure, retries, and respects the caller transaction", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createFacts(database);
    legacy(database);
    insert(database, 10, 300);
    assert.equal(database.prepare("SELECT n FROM legacy_writes").get().n, 1, "legacy trigger positive control");
    const exec = database.exec.bind(database);
    database.exec = (sql) => {
      if (sql.includes("DROP TRIGGER IF EXISTS main.usage_record_dirty_update"))
        throw new Error("injected second drop failure");
      return exec(sql);
    };
    assert.throws(() => removeLegacyUsageRecordTriggers(database), /injected second drop failure/);
    database.exec = exec;
    assert.equal(database.isTransaction, false);
    assert.deepEqual(triggers(database, "main"), [...NAMES].sort());
    database.exec("BEGIN");
    assert.equal(removeLegacyUsageRecordTriggers(database), true);
    assert.equal(database.isTransaction, true);
    database.exec("ROLLBACK");
    assert.deepEqual(triggers(database, "main"), [...NAMES].sort());
    assert.equal(removeLegacyUsageRecordTriggers(database), true);
    assert.deepEqual(triggers(database, "main"), []);
    database.exec = () => {
      throw new Error("already migrated must not execute DDL");
    };
    assert.equal(removeLegacyUsageRecordTriggers(database), false);
    database.exec = exec;
    assert.equal(revision(database), 1);
    assert.equal(database.prepare("SELECT n FROM legacy_writes").get().n, 1);
  } finally {
    database.close();
  }
});

test("migration targets main only and leaves TEMP, attached triggers and unrelated fact tracking intact", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createFacts(database);
    legacy(database);
    database.exec(`CREATE TEMP TRIGGER usage_record_dirty_insert AFTER INSERT ON main.events BEGIN SELECT 1; END;
      ATTACH ':memory:' AS other;
      CREATE TABLE other.events(id);
      CREATE TRIGGER other.usage_record_dirty_insert AFTER INSERT ON events BEGIN SELECT 1; END;`);
    assert.equal(removeLegacyUsageRecordTriggers(database), true);
    assert.deepEqual(triggers(database, "main"), []);
    assert.deepEqual(triggers(database, "temp"), ["usage_record_dirty_insert"]);
    assert.deepEqual(triggers(database, "other"), ["usage_record_dirty_insert"]);
    insert(database, 10, 300);
    assert.equal(revision(database), 1);
    assert.equal(database.prepare("SELECT n FROM legacy_writes").get().n, 0);
  } finally {
    database.close();
  }
});

test("Waifu TEMP triggers bind main.events and local fact rollback also restores dirty coverage", async (t) => {
  const { waifu, lite } = await fixture(t);
  const input = options(waifu);
  const initial = buildStoredRecordChampions(input);
  assert.deepEqual(triggers(waifu, "main"), []);
  assert.deepEqual(triggers(waifu, "temp"), [...NAMES].sort());
  assert.deepEqual(triggers(lite, "temp"), []);
  const before = snapshot(waifu);
  waifu.exec("CREATE TEMP TABLE events(id INTEGER); INSERT INTO temp.events VALUES(1)");
  assert.deepEqual(snapshot(waifu), before, "shadow TEMP events do not invoke main fact triggers");
  waifu.exec("BEGIN");
  insert(waifu, 40, 900);
  waifu.prepare("UPDATE main.events SET total=1 WHERE id=10").run();
  waifu.prepare("DELETE FROM main.events WHERE id=20").run();
  assert.ok(
    waifu.prepare("SELECT COUNT(*) n FROM usage_record_cache_dirty").get().n > 0,
    "local dirty positive control",
  );
  assert.equal(revision(waifu), 6);
  assert.equal(readStoredRecordChampions(input), null);
  waifu.exec("ROLLBACK; DROP TABLE temp.events");
  assert.equal(revision(waifu), 3);
  assert.deepEqual(snapshot(waifu), before);
  assert.deepEqual(readStoredRecordChampions(input), initial);
});

for (const operation of ["insert", "update", "delete", "replace"]) {
  test(`Lite ${operation} leaves all record tables untouched; Waifu rejects the same key and rebuilds once`, async (t) => {
    const { waifu, lite } = await fixture(t);
    const input = options(waifu);
    buildStoredRecordChampions(input);
    const before = snapshot(waifu);
    if (operation === "insert") insert(lite, 40, 900);
    if (operation === "update") lite.prepare("UPDATE events SET total=50 WHERE id=10").run();
    if (operation === "delete") lite.prepare("DELETE FROM events WHERE id=10").run();
    if (operation === "replace") insert(lite, 10, 50, 13, true);
    assert.equal(removeLegacyUsageRecordTriggers(lite), false);
    assert.deepEqual(snapshot(waifu), before, "Lite performs zero record maintenance");
    assert.equal(readStoredRecordChampions(input), null, "factsKey/max(id)/row-count cannot prove a cached winner");
    const ids = [];
    const result = buildStoredRecordChampions({
      ...input,
      estimateRow(row) {
        ids.push(row.id);
        return estimateRow();
      },
    });
    assert.deepEqual(
      ids,
      lite
        .prepare("SELECT id FROM events ORDER BY id")
        .all()
        .map((row) => row.id),
    );
    assert.deepEqual(
      result.day.totalTokens,
      operation === "insert" ? { period: "2026-07-13", value: 900 } : { period: "2026-07-11", value: 200 },
    );
    assert.deepEqual(readStoredRecordChampions(input), result);
    const writes = waifu.prepare("SELECT total_changes() n").get().n;
    assert.deepEqual(
      buildStoredRecordChampions({
        ...input,
        estimateRow() {
          throw new Error("unchanged facts rescanned");
        },
      }),
      result,
    );
    assert.equal(waifu.prepare("SELECT total_changes() n").get().n, writes, "unchanged reuse writes no derived state");
    const appended = [];
    insert(waifu, 50, 1000);
    const next = buildStoredRecordChampions({
      ...input,
      estimateRow(row) {
        appended.push(row.id);
        return estimateRow();
      },
    });
    assert.deepEqual(appended, [50], "local pure append resumes after the controlled rebuild");
    assert.deepEqual(next.day.totalTokens, { period: "2026-07-14", value: 1000 });
  });
}

test("closed Waifu loses its TEMP triggers; reopen checks persisted coverage after untracked changes", async (t) => {
  const value = await fixture(t);
  buildStoredRecordChampions(options(value.waifu));
  const before = snapshot(value.lite);
  value.waifu.close();
  insert(value.lite, 40, 900);
  value.lite.prepare("UPDATE events SET total=50 WHERE id=10").run();
  value.lite.prepare("DELETE FROM events WHERE id=20").run();
  assert.deepEqual(snapshot(value.lite), before);
  value.waifu = new DatabaseSync(value.file);
  assert.deepEqual(triggers(value.waifu, "temp"), []);
  assert.equal(readStoredRecordChampions(options(value.waifu)), null);
  const result = buildStoredRecordChampions(options(value.waifu));
  assert.deepEqual(result.day.totalTokens, { period: "2026-07-13", value: 900 });
  assert.deepEqual(triggers(value.waifu, "temp"), [...NAMES].sort());
});

test("untracked changes followed by local append cannot hide a revision gap or bypass scope validation", async (t) => {
  const { waifu, lite } = await fixture(t);
  const input = options(waifu);
  buildStoredRecordChampions(input);
  lite.prepare("UPDATE events SET total=2000 WHERE id=10").run();
  insert(waifu, 40, 900);
  const before = snapshot(waifu);
  assert.throws(
    () => buildStoredRecordChampions({ ...input, where: "WHERE id > ?", params: [20] }),
    (error) => error.code === "USAGE_RECORD_KEY_CONFLICT",
  );
  assert.deepEqual(snapshot(waifu), before);
  const ids = [];
  const result = buildStoredRecordChampions({
    ...input,
    estimateRow(row) {
      ids.push(row.id);
      return estimateRow();
    },
  });
  assert.deepEqual(ids, [10, 20, 30, 40]);
  assert.deepEqual(result.day.totalTokens, { period: "2026-07-10", value: 2000 });
});

test("local INSERT OR REPLACE invalidates missing old-period evidence without relying on recursive deletes", async (t) => {
  const { waifu } = await fixture(t);
  const input = options(waifu);
  buildStoredRecordChampions(input);
  waifu.exec("PRAGMA recursive_triggers=OFF");
  insert(waifu, 10, 50, 13, true);
  const result = buildStoredRecordChampions(input);
  assert.deepEqual(result.day.totalTokens, { period: "2026-07-11", value: 200 });
  assert.equal(
    waifu.prepare("SELECT 1 FROM usage_record_cache_periods WHERE unit='day' AND period_key='2026-07-10'").get(),
    undefined,
  );
});

test("another Waifu connection supplies continuous dirty proof and preserves incremental append", async (t) => {
  const { waifu, lite: other } = await fixture(t);
  const input = options(waifu);
  buildStoredRecordChampions(input);
  ensureUsageRecordSchema(other);
  insert(other, 40, 900);
  assert.ok(waifu.prepare("SELECT COUNT(*) n FROM usage_record_cache_dirty").get().n > 0);
  const ids = [];
  const result = buildStoredRecordChampions({
    ...input,
    estimateRow(row) {
      ids.push(row.id);
      return estimateRow();
    },
  });
  assert.deepEqual(ids, [40]);
  assert.deepEqual(result.day.totalTokens, { period: "2026-07-13", value: 900 });
});

test("a revision gap invalidates interrupted append cursors even when the caller reuses factsKey", async (t) => {
  const { waifu, lite } = await fixture(t);
  const input = options(waifu);
  buildStoredRecordChampions(input);
  insert(waifu, 40, 900);
  assert.throws(
    () =>
      buildStoredRecordChampions({
        ...input,
        batchSize: 1,
        afterBatch() {
          lite.prepare("UPDATE events SET total=2000 WHERE id=10").run();
        },
      }),
    (error) => error.code === "USAGE_RECORD_FACTS_CHANGED",
  );
  assert.equal(readStoredRecordChampions(input), null);
  const ids = [];
  const result = buildStoredRecordChampions({
    ...input,
    estimateRow(row) {
      ids.push(row.id);
      return estimateRow();
    },
  });
  assert.deepEqual(ids, [10, 20, 30, 40]);
  assert.deepEqual(result.day.totalTokens, { period: "2026-07-10", value: 2000 });
});

test("same-connection changes during build cannot publish a mixed fact revision", async (t) => {
  const { waifu } = await fixture(t);
  let changed = false;
  const input = options(waifu);
  assert.throws(
    () =>
      buildStoredRecordChampions({
        ...input,
        batchSize: 2,
        afterBatch() {
          if (changed) return;
          changed = true;
          waifu.prepare("UPDATE events SET total=2000 WHERE id=10").run();
        },
      }),
    (error) => error.code === "USAGE_RECORD_FACTS_CHANGED",
  );
  assert.equal(readStoredRecordChampions(input), null);
  assert.deepEqual(buildStoredRecordChampions(input).day.totalTokens, { period: "2026-07-10", value: 2000 });
});
