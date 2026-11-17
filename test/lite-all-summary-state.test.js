import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import {
  buildStoredAllSummary,
  ensureUsageAllSummarySchema,
  markStoredHistoryAllSummaryDirty,
  readStoredAllSummary,
  USAGE_ALL_SUMMARY_TABLE_NAMES,
  USAGE_HISTORY_ALL_SUMMARY_TABLE_NAMES,
} from "../src/usage-all-summary-store.js";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";

const BASE = Date.parse("2026-07-01T12:00:00Z");
const RANGE = { preset: "all", start: "2026-07-01", end: "2026-07-05T23:59:59Z", calendarZone: "utc" };
const SCHEMA = `PRAGMA journal_mode=WAL;
  CREATE TABLE usage_business_revision(singleton INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
  INSERT INTO usage_business_revision VALUES(1,0);
  CREATE TABLE source_files(path TEXT PRIMARY KEY,kind TEXT,home_id TEXT,home_label TEXT,home_path TEXT);
  INSERT INTO source_files VALUES('source','codex','home','Home','/fixture');
  CREATE TABLE events(id INTEGER PRIMARY KEY,timestamp_ms INTEGER NOT NULL,logical_id INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL DEFAULT 'session',home_id TEXT NOT NULL DEFAULT 'home',model TEXT NOT NULL DEFAULT 'gpt-6-sol',
    detail_mask INTEGER NOT NULL DEFAULT 15,total INTEGER NOT NULL DEFAULT 10,input INTEGER NOT NULL DEFAULT 8,
    cached INTEGER NOT NULL DEFAULT 1,output INTEGER NOT NULL DEFAULT 2,reasoning INTEGER NOT NULL DEFAULT 0);
  CREATE TRIGGER usage_business_events_INSERT AFTER INSERT ON events BEGIN
    UPDATE usage_business_revision SET revision=revision+1; END;
  CREATE TRIGGER usage_business_events_UPDATE AFTER UPDATE ON events BEGIN
    UPDATE usage_business_revision SET revision=revision+1; END;
  CREATE TRIGGER usage_business_events_DELETE AFTER DELETE ON events BEGIN
    UPDATE usage_business_revision SET revision=revision+1; END;`;

function fixture(t, mode = "hot") {
  const root = mkdtempSync(path.join(tmpdir(), "lite-all-summary-"));
  const file = path.join(root, "facts.sqlite");
  const f = { root, file, database: new DatabaseSync(file), mode, connections: [] };
  f.database.exec(SCHEMA);
  ensureUsageAllSummarySchema(f.database, { mode });
  t.after(() => {
    for (const connection of f.connections) connection.close();
    f.database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return f;
}

function input(f, extra = {}) {
  const history = f.mode === "history";
  return {
    database: f.database,
    mode: f.mode,
    key: "usage-fixture-v1",
    range: RANGE,
    bucket: "day",
    *eventsAfter(at, limit) {
      const rows =
        f.database.prepare(`SELECT * FROM events WHERE ${history ? "(timestamp_ms,logical_id)>(?,?)" : "id>?"}
        ORDER BY ${history ? "timestamp_ms,logical_id" : "id"} LIMIT ?`);
      for (const row of rows.iterate(...(history ? [at.ms, at.id, limit] : [at.id, limit]))) {
        yield {
          id: Number(history ? row.logical_id : row.id),
          timestamp: Number(row.timestamp_ms),
          sessionId: String(row.session_id),
          homeId: String(row.home_id),
          model: String(row.model),
          channel: "Codex",
          sourceKind: "codex",
          detailMask: Number(row.detail_mask),
          total: {
            total: Number(row.total),
            input: Number(row.input),
            cached: Number(row.cached),
            output: Number(row.output),
            reasoning: Number(row.reasoning),
          },
        };
      }
    },
    ...extra,
  };
}

function usageOnly(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.doesNotMatch(key, /cost|pric|scenario|currency|quote|estimated|records/i);
    usageOnly(item);
  }
}

function checkpoints(f, names = USAGE_ALL_SUMMARY_TABLE_NAMES) {
  return f.database.prepare(`SELECT state_json FROM ${names[1]} ORDER BY block`).all();
}

test("pure checkpoints need only usage facts and reopen without reading or constructing pricing", (t) => {
  const f = fixture(t);
  f.database.exec(`INSERT INTO events(id,timestamp_ms,total,input,cached,output,reasoning,detail_mask) VALUES
    (1,${BASE},120,100,40,20,5,15),(2,${BASE + 1},60,50,10,10,2,15),
    (3,${BASE + 2},100,80,0,20,0,5),(4,${BASE + 3},30,0,0,0,0,0);`);
  const options = input(f);
  Object.defineProperty(options, "pricing", {
    get() {
      throw new Error("pure build read pricing");
    },
  });
  Object.defineProperty(options, "pricingModels", {
    get() {
      throw new Error("pure build read pricingModels");
    },
  });
  usageOnly(buildStoredAllSummary(options));
  const result = readStoredAllSummary(options);
  assert.deepEqual(result.aggregate, {
    event_count: 4,
    session_count: 1,
    home_count: 1,
    total: 310,
    input: 230,
    cached: 50,
    output: 50,
    reasoning: 7,
  });
  usageOnly(result);
  for (const row of checkpoints(f)) usageOnly(JSON.parse(row.state_json));
  assert.deepEqual(
    f.database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'usage%summary%' ORDER BY name")
      .all()
      .map((row) => row.name),
    [...USAGE_ALL_SUMMARY_TABLE_NAMES].sort(),
  );
  f.database.close();
  f.database = new DatabaseSync(f.file);
  ensureUsageAllSummarySchema(f.database);
  const warm = input(f, {
    eventsAfter() {
      throw new Error("ready pure cache reread");
    },
  });
  const writes = f.database.prepare("SELECT total_changes() n").get().n;
  assert.equal(buildStoredAllSummary(warm).reused, true);
  assert.deepEqual(readStoredAllSummary(warm), result);
  assert.equal(f.database.prepare("SELECT total_changes() n").get().n, writes);
});

test("pure checkpoints retain 32 blocks, append one tail, and replay old corrections exactly", (t) => {
  const f = fixture(t);
  const count = 34 * 1024 + 5;
  f.database.exec("BEGIN");
  const insert = f.database.prepare("INSERT INTO events(id,timestamp_ms,session_id) VALUES(?,?,?)");
  for (let id = 1; id <= count; id++) insert.run(id, BASE + id, `session-${id % 3}`);
  f.database.exec("COMMIT");
  assert.equal(buildStoredAllSummary(input(f)).readEvents, count);
  assert.equal(checkpoints(f).length, 33);
  insert.run(count + 1, BASE + count + 1, "session-0");
  assert.equal(buildStoredAllSummary(input(f)).readEvents, 1);
  f.database.exec("UPDATE events SET total=11,input=9,session_id='correction' WHERE id=10");
  assert.equal(buildStoredAllSummary(input(f)).readEvents, count + 1);
  const result = readStoredAllSummary(input(f));
  assert.equal(result.aggregate.total, (count + 1) * 10 + 1);
  assert.equal(result.aggregate.session_count, 4);
  assert.equal(
    result.timeline.reduce((sum, row) => sum + row.total.total, 0),
    result.aggregate.total,
  );
  assert.equal(checkpoints(f).length, 33);
  usageOnly(result);
});

test("pure interruption and damaged checkpoints recover without changing fact revision", (t) => {
  const f = fixture(t);
  f.database.exec(`INSERT INTO events(id,timestamp_ms) VALUES(1,${BASE}),(2,${BASE + 1}),(3,${BASE + 2});`);
  const interrupted = input(f, {
    batchSize: 1,
    afterBatch() {
      throw new Error("fixture interrupted");
    },
  });
  assert.throws(() => buildStoredAllSummary(interrupted), /fixture interrupted/);
  assert.equal(readStoredAllSummary(input(f)), null);
  f.database.close();
  f.database = new DatabaseSync(f.file);
  ensureUsageAllSummarySchema(f.database);
  assert.equal(buildStoredAllSummary(input(f)).readEvents, 2);
  const revision = f.database.prepare("SELECT revision FROM usage_business_revision").get().revision;
  f.database.exec(`UPDATE ${USAGE_ALL_SUMMARY_TABLE_NAMES[1]} SET state_json='{broken'`);
  assert.equal(readStoredAllSummary(input(f)), null);
  assert.equal(buildStoredAllSummary(input(f)).rebuilt, true);
  assert.equal(readStoredAllSummary(input(f)).aggregate.total, 30);
  assert.equal(f.database.prepare("SELECT revision FROM usage_business_revision").get().revision, revision);
});

test("pure cold checkpoints follow logical timestamp/tie cursors and retain session deduplication", (t) => {
  const f = fixture(t, "history");
  f.database.exec(`INSERT INTO events(id,timestamp_ms,logical_id) VALUES
    (30,${BASE},0),(5,${BASE},1),(10,${BASE + 86400000},0);`);
  buildStoredAllSummary(input(f));
  f.database.exec(`INSERT INTO events(id,timestamp_ms,logical_id) VALUES(1,${BASE + 2 * 86400000},0);`);
  markStoredHistoryAllSummaryDirty(f.database, { ms: BASE + 2 * 86400000, id: 0 });
  assert.equal(buildStoredAllSummary(input(f)).readEvents, 1);
  f.database.exec(`INSERT INTO events(id,timestamp_ms,logical_id) VALUES(2,${BASE},2);`);
  markStoredHistoryAllSummaryDirty(f.database, { ms: BASE, id: 2 });
  assert.equal(readStoredAllSummary(input(f)), null);
  assert.equal(buildStoredAllSummary(input(f)).readEvents, 5);
  const result = readStoredAllSummary(input(f));
  assert.equal(result.aggregate.total, 50);
  assert.equal(result.aggregate.session_count, 1);
  usageOnly(result);
  for (const row of checkpoints(f, USAGE_HISTORY_ALL_SUMMARY_TABLE_NAMES)) usageOnly(JSON.parse(row.state_json));
});

test("cold namespaces keep Waifu state untouched when Lite marks and rebuilds its projection", async (t) => {
  const { createWaifuAllSummaryExtension, WAIFU_HISTORY_ALL_SUMMARY_TABLE_NAMES } = await import(
    "../src/waifu/usage-all-summary.js"
  );
  const { createEventPricing } = await import("../src/pricing.js");
  const f = fixture(t, "history");
  const extension = createWaifuAllSummaryExtension(createEventPricing());
  const waifu = input(f, { extension });
  ensureUsageAllSummarySchema(f.database, waifu);
  f.database.exec(`INSERT INTO events(id,timestamp_ms) VALUES(1,${BASE});`);
  buildStoredAllSummary(input(f));
  buildStoredAllSummary(waifu);
  const saved = WAIFU_HISTORY_ALL_SUMMARY_TABLE_NAMES.map((name) => f.database.prepare(`SELECT * FROM ${name}`).all());
  f.database.exec(`INSERT INTO events(id,timestamp_ms) VALUES(2,${BASE + 1});`);
  markStoredHistoryAllSummaryDirty(f.database, { ms: BASE + 1, id: 0 });
  assert.equal(buildStoredAllSummary(input(f)).readEvents, 1);
  assert.deepEqual(
    WAIFU_HISTORY_ALL_SUMMARY_TABLE_NAMES.map((name) => f.database.prepare(`SELECT * FROM ${name}`).all()),
    saved,
  );
  assert.equal(readStoredAllSummary(waifu), null);
  assert.equal(buildStoredAllSummary(waifu).readEvents, 2, "missing extension dirty evidence requires replay");
  assert.equal(readStoredAllSummary(waifu).aggregate.total, 20);
});

test("Lite migrates old Waifu triggers atomically and never maintains Waifu tables across writes", async (t) => {
  const { createWaifuAllSummaryExtension, WAIFU_ALL_SUMMARY_TABLE_NAMES } = await import(
    "../src/waifu/usage-all-summary.js"
  );
  const { createEventPricing, getPricingCatalog, setPricingCatalog } = await import("../src/pricing.js");
  const original = getPricingCatalog();
  t.after(() => setPricingCatalog(original));
  const f = fixture(t);
  f.database.exec(`INSERT INTO events(id,timestamp_ms) VALUES(1,${BASE});`);
  buildStoredAllSummary(input(f));
  const waifu = (extra = {}) => input(f, { ...extra, extension: createWaifuAllSummaryExtension(createEventPricing()) });
  ensureUsageAllSummarySchema(f.database, waifu());
  buildStoredAllSummary(waifu());
  assert.ok(readStoredAllSummary(waifu()).costEstimate.totalUsd > 0);
  const readonly = new DatabaseSync(f.file, { readOnly: true });
  f.connections.push(readonly);
  assert.deepEqual(
    readStoredAllSummary(input({ ...f, database: readonly }, { extension: waifu().extension })),
    readStoredAllSummary(waifu()),
  );
  f.database.exec(`CREATE TRIGGER usage_all_insert AFTER INSERT ON events BEGIN
    INSERT OR REPLACE INTO usage_all_summary_dirty VALUES(1,NEW.timestamp_ms,NEW.id); END;`);
  const lite = new DatabaseSync(f.file);
  f.connections.push(lite);
  const exec = lite.exec.bind(lite);
  const mocked = t.mock.method(lite, "exec", (sql) => {
    if (sql.includes("CREATE TABLE IF NOT EXISTS usage_all_summary_usage_format")) throw new Error("migration failure");
    return exec(sql);
  });
  assert.throws(() => ensureUsageAllSummarySchema(lite), /migration failure/);
  mocked.mock.restore();
  assert.ok(lite.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_all_insert'").get());
  ensureUsageAllSummarySchema(lite);
  assert.equal(lite.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_all_insert'").get(), undefined);
  const state = () => WAIFU_ALL_SUMMARY_TABLE_NAMES.map((name) => f.database.prepare(`SELECT * FROM ${name}`).all());
  const before = state();
  lite.exec(`INSERT INTO events(id,timestamp_ms) VALUES(2,${BASE + 1});`);
  assert.deepEqual(state(), before);
  assert.equal(readStoredAllSummary(waifu()), null);
  assert.equal(buildStoredAllSummary(waifu()).readEvents, 2);
  assert.equal(buildStoredAllSummary(waifu()).readEvents, 0);
  buildStoredAllSummary(input({ ...f, database: lite }));
  assert.equal(
    buildStoredAllSummary(
      waifu({
        eventsAfter() {
          throw new Error("pure cache commit invalidated Waifu");
        },
      }),
    ).reused,
    true,
  );
  const updated = state();
  lite.exec("UPDATE events SET total=15,input=13 WHERE id=1");
  assert.deepEqual(state(), updated);
  f.database.exec(`INSERT INTO events(id,timestamp_ms) VALUES(3,${BASE + 2});`);
  assert.equal(buildStoredAllSummary(waifu()).readEvents, 3, "a local tail cannot cover a missed external correction");
  assert.equal(readStoredAllSummary(waifu()).aggregate.total, 35);
  for (const sql of [
    "DELETE FROM events WHERE id=2",
    `INSERT OR REPLACE INTO events(id,timestamp_ms,total,input) VALUES(1,${BASE},18,16)`,
  ]) {
    const saved = state();
    lite.exec(sql);
    assert.deepEqual(state(), saved);
    assert.equal(readStoredAllSummary(waifu()), null);
    assert.equal(buildStoredAllSummary(waifu()).rebuilt, true);
  }
  assert.equal(readStoredAllSummary(waifu()).aggregate.total, 28);
  buildStoredAllSummary(input(f));
  const pure = checkpoints(f);
  const rates = getPricingCatalog();
  rates.models["gpt-6-sol"].short.input *= 3;
  setPricingCatalog(rates);
  const repriced = waifu({ key: "changed-waifu-price" });
  buildStoredAllSummary(repriced);
  assert.deepEqual(checkpoints(f), pure);
  assert.equal(
    buildStoredAllSummary(
      input(f, {
        eventsAfter() {
          throw new Error("price change rescanned Lite facts");
        },
      }),
    ).readEvents,
    0,
  );
  f.database.close();
  f.database = new DatabaseSync(f.file);
  ensureUsageAllSummarySchema(f.database, repriced);
  assert.equal(buildStoredAllSummary(waifu({ key: "changed-waifu-price" })).readEvents, 0);
  f.database.close();
  lite.exec("UPDATE events SET total=19,input=17 WHERE id=1");
  f.database = new DatabaseSync(f.file);
  ensureUsageAllSummarySchema(f.database, repriced);
  assert.equal(buildStoredAllSummary(waifu({ key: "changed-waifu-price" })).readEvents, 2);
  assert.equal(readStoredAllSummary(waifu({ key: "changed-waifu-price" })).aggregate.total, 29);
});

test("pure all-summary runs with pricing and Waifu timeline modules forbidden", async (t) => {
  const f = fixture(t);
  const probe = createLiteBoundaryProbe(f.root, {
    forbiddenModules: [
      "src/pricing.js",
      "public/pricing-models.js",
      "public/waifu-timeline.js",
      "src/waifu/usage-all-summary.js",
      "src/usage-store.js",
      "src/usage-core.js",
    ],
  });
  const entry = new URL("../src/usage-all-summary-store.js", import.meta.url).href;
  const source = `import assert from 'node:assert/strict'; import {DatabaseSync} from 'node:sqlite';
    import {buildStoredAllSummary,ensureUsageAllSummarySchema,readStoredAllSummary} from ${JSON.stringify(entry)};
    const RANGE=${JSON.stringify(RANGE)};
    ${input.toString()}
    ${usageOnly.toString()}
    for(const mode of ['hot','history']) {
    const f={database:new DatabaseSync(':memory:'),mode};
    try { f.database.exec(${JSON.stringify(SCHEMA)}); ensureUsageAllSummarySchema(f.database,{mode});
      f.database.exec('INSERT INTO events(id,timestamp_ms) VALUES(1,${BASE})');
      usageOnly(buildStoredAllSummary(input(f))); usageOnly(readStoredAllSummary(input(f)));
      assert.equal(readStoredAllSummary(input(f)).aggregate.total,10);
    } finally { f.database.close(); }} console.log('pure passed');`;
  const run = promisify(execFile);
  const result = await run(process.execPath, ["--input-type=module", "-e", source], {
    env: probe.env,
    windowsHide: true,
  });
  assert.equal(result.stdout.trim(), "pure passed");
  assert.equal(probe.read().filter((event) => event.forbidden).length, 0);
  const waifu = new URL("../src/waifu/usage-all-summary.js", import.meta.url).href;
  await assert.rejects(
    run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(waifu)})`], {
      env: probe.env,
      windowsHide: true,
    }),
    (error) => error.stderr.includes("LITE_BOUNDARY_MODULE"),
  );
});
