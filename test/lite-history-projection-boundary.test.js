import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as shared from "../src/usage-history-projection-store.js";

function seed(database) {
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE events(id INTEGER PRIMARY KEY,source_path TEXT NOT NULL,timestamp_ms INTEGER NOT NULL,
      session_id TEXT DEFAULT 'session',home_id TEXT DEFAULT 'home',channel TEXT DEFAULT 'CLI',model TEXT DEFAULT 'gpt-6-sol',
      project TEXT DEFAULT '/fixture',cwd TEXT DEFAULT '/fixture',hour_key TEXT DEFAULT '2026-07-01 00',
      day_key TEXT DEFAULT '2026-07-01',week_key TEXT DEFAULT '2026-06-29',month_key TEXT DEFAULT '2026-07',
      total REAL NOT NULL,input REAL DEFAULT 10,cached REAL DEFAULT 2,output REAL DEFAULT 1,reasoning REAL DEFAULT 0,
      detail_mask INTEGER DEFAULT 15,reconciliation_gap INTEGER DEFAULT 0,cache_write_tokens INTEGER DEFAULT 0,
      cache_write_known INTEGER DEFAULT 1,request_input_tokens INTEGER DEFAULT 10,context_level TEXT DEFAULT 'short',
      service_tier TEXT DEFAULT 'standard');
    CREATE INDEX fact_time ON events(timestamp_ms);
    CREATE TABLE usage_business_revision(singleton INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
    INSERT INTO usage_business_revision VALUES(1,0);
    CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE source_files(path TEXT PRIMARY KEY,kind TEXT,home_id TEXT,home_label TEXT,home_path TEXT);
    INSERT INTO source_files VALUES('hot-a','codex','home','Home','/fixture');
    CREATE TABLE usage_source_reparse(source_path TEXT PRIMARY KEY REFERENCES source_files(path) ON DELETE CASCADE) STRICT;
    CREATE TABLE archive_segments(segment_id TEXT PRIMARY KEY,start_ms INTEGER,end_ms INTEGER);
    CREATE TABLE rate_limit_observations(source_path TEXT);
    CREATE TABLE quota_usage_sources(source_path TEXT);
    CREATE TABLE usage_record_old(value INTEGER); INSERT INTO usage_record_old VALUES(17);
    CREATE INDEX old_record_index ON usage_record_old(value);
    CREATE TABLE usage_all_summary_old(value INTEGER); INSERT INTO usage_all_summary_old VALUES(23);`);
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    database.exec(`CREATE TRIGGER fact_${operation} AFTER ${operation} ON events BEGIN
      UPDATE usage_business_revision SET revision=revision+1 WHERE singleton=1; END`);
  }
  for (const [id, day, total] of [
    [30, "2026-07-01", 300],
    [5, "2026-07-02", 200],
    [10, "2026-07-03", 100],
  ]) {
    database
      .prepare("INSERT INTO events(id,source_path,timestamp_ms,day_key,total) VALUES(?,'hot-a',?,?,?)")
      .run(id, Date.parse(`${day}T01:00:00Z`), day, total);
  }
}

function canonical(row, ignored) {
  return Object.fromEntries(
    Object.keys(row)
      .filter((key) => !ignored.includes(key))
      .sort()
      .map((key) => [key, row[key]]),
  );
}

function columns(database) {
  return database
    .prepare("PRAGMA table_info(events)")
    .all()
    .map((row) => row.name)
    .filter((name) => name !== "id");
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "lite-history-projection-"));
  const file = path.join(root, "source.sqlite");
  const source = new DatabaseSync(file);
  seed(source);
  shared.ensureHistoryProjectionTracking(source);
  const stores = new Set(),
    queries = new Set();
  t.after(() => {
    for (const store of stores) store.close();
    for (const query of queries) query.close();
    source.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    source,
    store(Class = shared.HistoryProjectionStore) {
      const store = new Class(file, canonical);
      stores.add(store);
      return store;
    },
    prepare(store, calendar = "UTC") {
      const prepared = store.prepare(source, "fixture-identity", calendar);
      queries.add(prepared.query);
      return prepared;
    },
    publish(store, prepared, calendar = "UTC", project = (row) => row) {
      if (prepared.delta) store.applyDelta(prepared, columns(source), project);
      else if (!prepared.reused) prepared.query.finish(columns(source), project);
      return store.publish(source, prepared, "fixture-identity", calendar);
    },
  };
}

function change(source, work, mode = "replace") {
  const before = shared.readHistoryProjectionStamp(source);
  source.exec("BEGIN IMMEDIATE");
  try {
    work();
    shared.recordHistoryProjectionBatch(source, before, { sources: ["hot-a"], mode });
    source.exec("COMMIT");
  } catch (error) {
    source.exec("ROLLBACK");
    throw error;
  }
}

function rows(database) {
  return database
    .prepare("SELECT timestamp_ms,history_ordinal,total,day_key FROM events ORDER BY timestamp_ms,history_ordinal")
    .all();
}

function snapshot(database) {
  return database
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}"`).all()]);
}

async function records(database) {
  const { buildStoredRecordChampions } = await import("../src/usage-record-store.js");
  return buildStoredRecordChampions({
    database,
    mode: "history",
    key: "fixture-records",
    factsKey: String(database.prepare("SELECT revision FROM usage_business_revision").get().revision),
    zone: "utc",
    estimateRow: () => ({ currency: "USD", totalUsd: 0, inputUsd: 0, cachedInputUsd: 0, outputUsd: 0 }),
  });
}

test("pure carrier full capture, delta, publication and reopen load no Waifu modules or legacy schema", () => {
  const code = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { mkdtempSync,rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { DatabaseSync } from 'node:sqlite';
    const forbidden = new Set(['usage-record-store.js','pricing.js','usage-store.js','usage-fact-store.js']);
    registerHooks({load(url,context,next) {
      if (url.includes('/src/waifu/') || forbidden.has(url.split('/').at(-1))) throw new Error('FORBIDDEN_WAIFU_MODULE');
      return next(url,context);
    }});
    const shared = await import(pathToFileURL(path.resolve('src/usage-history-projection-store.js')).href);
    const seed=${seed.toString()}, canonical=${canonical.toString()}, columns=${columns.toString()};
    const root=mkdtempSync(path.join(tmpdir(),'pure-history-boundary-'));
    const file=path.join(root,'facts.sqlite'), source=new DatabaseSync(file);
    const store=new shared.HistoryProjectionStore(file,canonical);
    let reopened;
    try {
      seed(source);
      source.exec("INSERT INTO usage_source_reparse VALUES('hot-a')");
      const first=store.prepare(source,'boundary','UTC');
      first.query.finish(columns(source)); store.publish(source,first,'boundary','UTC');
      assert.equal(first.query.database.prepare('SELECT COUNT(*) n FROM usage_source_reparse').get().n,0,
        'legacy raw capture preserves empty repair-check schema; the parent owner gates pending source repairs');
      assert.equal(source.prepare('SELECT COUNT(*) n FROM usage_source_reparse').get().n,1);
      const before=shared.readHistoryProjectionStamp(source);
      source.exec('BEGIN');
      source.exec("INSERT INTO events(id,source_path,timestamp_ms,total) VALUES(40,'hot-a',1790960400000,900)");
      shared.recordHistoryProjectionBatch(source,before,{sources:['hot-a'],mode:'append'}); source.exec('COMMIT');
      const next=store.prepare(source,'boundary','UTC');
      assert.ok(next.delta);
      store.applyDelta(next,columns(source),(row)=>row); store.publish(source,next,'boundary','UTC');
      const database=next.query.database;
      assert.equal(database.prepare('SELECT SUM(total) n FROM events').get().n,1500);
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%record%' OR name='usage_all_summary_old' OR name='usage_history_all_summary_state'").all(),[]);
      assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name='usage_history_all_summary_usage_state'").get());
      assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name='fact_time'").get());
      assert.equal(source.prepare('SELECT value FROM usage_record_old').get().value,17);
      store.verificationReceipts().add('verified:hash-one');
      store.close(); reopened=new shared.HistoryProjectionStore(file,canonical);
      const reused=reopened.prepare(source,'boundary','UTC'); assert.equal(reused.reused,true);
      assert.equal(reopened.publish(source,reused,'boundary','UTC'),reused.query);
      assert.equal(reopened.verificationReceipts().has('verified:hash-one'),true);
      assert.equal(reopened.verificationReceipts().has('verified:hash-two'),false);
      await assert.rejects(import(pathToFileURL(path.resolve('src/waifu/usage-history-projection-store.js')).href),/FORBIDDEN_WAIFU_MODULE/);
    } finally { reopened?.close(); store.close(); source.close(); rmSync(root,{recursive:true,force:true}); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Waifu wrapper keeps tracking exports and explicitly creates both summary namespaces and record schema", async (t) => {
  const waifu = await import("../src/waifu/usage-history-projection-store.js");
  for (const [name, helper] of Object.entries(shared))
    if (name !== "HistoryProjectionStore") assert.equal(waifu[name], helper);
  const f = fixture(t),
    store = f.store(waifu.HistoryProjectionStore);
  const first = f.prepare(store);
  f.publish(store, first);
  const database = first.query.database;
  for (const name of [
    "usage_history_all_summary_usage_state",
    "usage_history_all_summary_state",
    "usage_history_record_cache",
  ]) {
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name));
  }
  assert.deepEqual((await records(database)).day.totalTokens, { period: "2026-07-01", value: 300 });
  change(f.source, () => f.source.prepare("UPDATE events SET total=50 WHERE id=30").run());
  const next = f.prepare(store);
  f.publish(store, next);
  for (const table of [
    "usage_history_all_summary_usage_dirty",
    "usage_history_all_summary_dirty",
    "usage_history_record_cache_dirty",
  ]) {
    assert.ok(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n > 0, `${table} dirty positive control`);
  }
  assert.deepEqual((await records(database)).day.totalTokens, { period: "2026-07-02", value: 200 });
  const writes = database.prepare("SELECT total_changes() n").get().n;
  f.publish(store, f.prepare(store));
  assert.equal(
    database.prepare("SELECT total_changes() n").get().n,
    writes,
    "unchanged Waifu schema/publication is reusable",
  );
});

test("pure delta leaves existing Waifu tables unchanged; returning Waifu reuses facts and revokes stale projections", async (t) => {
  const waifu = await import("../src/waifu/usage-history-projection-store.js");
  const f = fixture(t),
    full = f.store(waifu.HistoryProjectionStore);
  const first = f.prepare(full);
  f.publish(full, first);
  await records(first.query.database);
  first.query.database.exec(`INSERT INTO usage_history_all_summary_state
    VALUES(1,'old-waifu','utc','day','day',0,0,'complete',0,0,0)`);
  const old = snapshot(first.query.database).filter(
    ([name]) =>
      name.startsWith("usage_history_record_") ||
      (name.startsWith("usage_history_all_summary_") && !name.startsWith("usage_history_all_summary_usage_")),
  );
  full.close();
  const pure = f.store();
  change(f.source, () => f.source.prepare("UPDATE events SET total=20 WHERE id=30").run());
  const next = f.prepare(pure);
  f.publish(pure, next);
  assert.deepEqual(
    snapshot(next.query.database).filter(([name]) => old.some(([previous]) => name === previous)),
    old,
  );
  const returned = f.store(waifu.HistoryProjectionStore);
  assert.equal(
    returned.openPublished(f.source, "fixture-identity", "UTC"),
    null,
    "a read-only lease cannot carry stale Waifu coverage",
  );
  const reused = f.prepare(returned);
  assert.equal(reused.reused, true, "carrier facts need no additional capture or sorting");
  f.publish(returned, reused);
  assert.equal(reused.query.database.prepare("SELECT COUNT(*) n FROM usage_history_all_summary_state").get().n, 0);
  assert.deepEqual((await records(reused.query.database)).day.totalTokens, { period: "2026-07-02", value: 200 });
  const pinned = returned.openPublished(f.source, "fixture-identity", "UTC");
  assert.ok(pinned);
  pinned.database.close();
});

test("derived dirty failure rolls back facts, projection header and all dirty namespaces; retry preserves the delta", async (t) => {
  const waifu = await import("../src/waifu/usage-history-projection-store.js");
  let fail = false,
    schemaFail = false;
  class Failing extends waifu.HistoryProjectionStore {
    ensureDerivedSchema(database) {
      super.ensureDerivedSchema(database);
      if (schemaFail) throw new Error("injected derived schema failure");
    }
    markDerivedDirty(database, dirty) {
      super.markDerivedDirty(database, dirty);
      if (fail) throw new Error("injected derived dirty failure");
    }
  }
  const f = fixture(t),
    store = f.store(Failing);
  const first = f.prepare(store);
  f.publish(store, first);
  await records(first.query.database);
  const before = snapshot(first.query.database);
  change(f.source, () => f.source.prepare("DELETE FROM events WHERE id=30").run());
  fail = true;
  const broken = f.prepare(store);
  assert.throws(() => f.publish(store, broken), /injected derived dirty failure/);
  assert.equal(broken.delta.database, null, "failed capture is released");
  assert.deepEqual(snapshot(first.query.database), before);
  fail = false;
  f.publish(store, f.prepare(store));
  assert.deepEqual((await records(first.query.database)).day.totalTokens, { period: "2026-07-02", value: 200 });
  change(f.source, () => f.source.prepare("UPDATE events SET total=700 WHERE id=5").run());
  const committed = snapshot(first.query.database);
  schemaFail = true;
  const schemaBroken = f.prepare(store);
  assert.throws(() => f.publish(store, schemaBroken), /injected derived schema failure/);
  assert.equal(schemaBroken.delta.database, null, "schema failure also releases captured facts");
  assert.deepEqual(snapshot(first.query.database), committed);
  schemaFail = false;
  f.publish(store, f.prepare(store));
  assert.deepEqual((await records(first.query.database)).day.totalTokens, { period: "2026-07-02", value: 700 });
});

test("carrier preserves logical ordering, append cursors, fact-batch rollback and same-count replacement", (t) => {
  const f = fixture(t),
    store = f.store();
  const first = f.prepare(store);
  f.publish(store, first);
  assert.deepEqual(
    rows(first.query.database).map((row) => row.total),
    [300, 200, 100],
  );
  const stamp = shared.readHistoryProjectionStamp(f.source);
  f.source.exec("BEGIN");
  f.source.exec("UPDATE events SET total=1 WHERE id=30");
  shared.recordHistoryProjectionBatch(f.source, stamp, { sources: ["hot-a"] });
  f.source.exec("ROLLBACK");
  assert.equal(f.prepare(store).reused, true);
  change(
    f.source,
    () => f.source.exec("INSERT INTO events(id,source_path,timestamp_ms,total) VALUES(40,'hot-a',1782954000000,150)"),
    "append",
  );
  const appended = f.prepare(store);
  f.publish(store, appended);
  assert.equal(store.work.rebuilt, false);
  assert.equal(store.work.delta.scanned, 1);
  assert.equal(
    first.query.database.prepare("SELECT last_id FROM usage_history_projection_sources WHERE source_path='hot-a'").get()
      .last_id,
    40,
  );
  const logical = rows(first.query.database);
  for (let index = 1; index < logical.length; index++) {
    const previous = logical[index - 1],
      current = logical[index];
    assert.ok(
      previous.timestamp_ms < current.timestamp_ms ||
        (previous.timestamp_ms === current.timestamp_ms && previous.history_ordinal < current.history_ordinal),
    );
  }
  change(f.source, () => f.source.prepare("UPDATE events SET total=999 WHERE id=5").run());
  f.publish(store, f.prepare(store));
  assert.equal(first.query.database.prepare("SELECT COUNT(*) n FROM events").get().n, 4);
  assert.ok(rows(first.query.database).some((row) => row.total === 999));
});

test("superseded unpublished candidates reopen and catch up without recopying their retained facts", (t) => {
  const f = fixture(t),
    store = f.store();
  const first = f.prepare(store);
  first.query.finish(columns(f.source));
  store.markImported(first.query, "verified-cold-segment");
  change(f.source, () => f.source.exec("UPDATE events SET total=450 WHERE id=30"));
  store.publish(f.source, first, "fixture-identity", "UTC");
  assert.equal(store.work.superseded, true);
  store.close();
  const reopened = f.store(),
    pending = f.prepare(reopened);
  assert.equal(reopened.work.resumed, true);
  assert.equal(reopened.work.hotCopied, 0);
  assert.ok(reopened.imported(pending.query, "verified-cold-segment"));
  f.publish(reopened, pending);
  assert.ok(rows(pending.query.database).some((row) => row.total === 450));
  assert.equal(f.prepare(reopened).reused, true);
});
