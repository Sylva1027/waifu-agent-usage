import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { compactHistoryArchivePackage } from "../src/history-archive-compaction.js";
import {
  createHistoryArchiveCandidate,
  prepareHistoryArchiveCommit,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
  loadHistoryArchiveImport,
} from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { UsageStore as LiteStore } from "../src/usage-store-lite.js";

const time = Date.parse("2026-06-10T15:00:00Z");
const entry = (id, input = 10, responseId = "", offset = 0) => ({
  type: "message",
  id,
  timestamp: new Date(time + offset).toISOString(),
  message: {
    role: "assistant",
    timestamp: time + offset,
    provider: "test",
    api: "test-api",
    model: "test-model",
    responseId,
    content: [{ type: "text", text: "private-message-never-stored" }],
    usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1 },
  },
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "omp-ledger-"));
  const agent = path.join(root, ".omp", "agent");
  const active = path.join(agent, "sessions", "project");
  const archive = path.join(agent, "archive", "sessions", "project");
  await mkdir(active, { recursive: true });
  await mkdir(archive, { recursive: true });
  const options = { homeDir: root, env: {}, databaseFile: path.join(root, "facts.sqlite") };
  const store = new UsageStore(options);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const write = (name, id, rows, parentSession = "") =>
    writeFile(
      path.join(active, name),
      `${[{ type: "session", id, version: 3, cwd: root, parentSession }, ...rows]
        .map((item) => JSON.stringify(item))
        .join("\n")}\n`,
    );
  return { root, active, archive, write, store, options };
}

const sum = async (store) =>
  (await store.publishedHistoryUsageEvents()).reduce((total, event) => total + event.total.total, 0);

test("OMP upgrades an empty Codex file binding and preserves a populated cold binding at the same path", async (t) => {
  const { store, write, root, active } = await fixture(t);
  await write("empty.jsonl", "new", [entry("a", 10)]);
  await write("occupied.jsonl", "different", [entry("b", 100)]);
  await store.open();
  const empty = path.join(active, "empty.jsonl"),
    occupied = path.join(active, "occupied.jsonl");
  const db = store.database;
  const addSource = db.prepare("INSERT INTO source_files VALUES (?,'extra','old-codex','Old Codex',?,0,0,'old')");
  addSource.run(empty, active);
  addSource.run(occupied, active);
  db.prepare(`INSERT INTO events(source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
    hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning)
    VALUES(?,?,'old','old-codex','Old Codex','Codex','project','model','hour','day','week','month',5,4,0,1,0)`).run(
    occupied,
    time,
  );
  const candidate = path.join(root, "old-codex.sqlite");
  await createHistoryArchiveCandidate(db, candidate, { startMs: time - 1000, endMs: time + 1000 });
  await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(db, candidate));
  await store.sync();
  assert.equal(await sum(store), 16);
  const kind = db.prepare("SELECT kind FROM source_files WHERE path=? COLLATE NOCASE");
  assert.equal(kind.get(empty).kind, "omp");
  assert.equal(kind.get(occupied).kind, "extra");
  assert.ok(store.warnings.some((w) => w.includes("OMP_SOURCE_BINDING_CONFLICT") && w.includes("occupied.jsonl")));
  await store.sync();
  assert.equal(await sum(store), 16);
});

test("OMP waits for a complete snapshot before retracting previously published duplicate calls", async (t) => {
  const { store, active, write } = await fixture(t);
  await write("owner.jsonl", "owner", [entry("a"), entry("b")]);
  await store.sync();
  assert.equal(await sum(store), 22);
  await write("owner.jsonl", "owner", [entry("a", 10, "r"), entry("b", 10, "r")]);
  await appendFile(path.join(active, "owner.jsonl"), '{"type":');
  await store.sync();
  assert.equal(await sum(store), 22);
  await write("owner.jsonl", "owner", [entry("a", 10, "r"), entry("b", 10, "r")]);
  await store.sync();
  assert.equal(await sum(store), 11);
});

test("OMP reconciliation failure rolls back the file baseline, aliases, occurrences and facts together", async (t) => {
  const { store, write } = await fixture(t);
  await write("one.jsonl", "one", [entry("a", 5, "r")]);
  await store.open();
  store.database.exec(
    "CREATE TEMP TRIGGER reject_omp BEFORE INSERT ON main.events BEGIN SELECT RAISE(ABORT,'simulated failure'); END",
  );
  await assert.rejects(store.sync(), /simulated failure/);
  for (const table of ["omp_files", "omp_calls", "omp_aliases", "omp_occurrences", "events"])
    assert.equal(store.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  store.database.exec("DROP TRIGGER reject_omp");
  await store.sync();
  assert.equal(await sum(store), 6);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM omp_aliases").get().n, 2);
});

test("OMP reconsiders a formerly disputed owner and only revises it after a complete snapshot", async (t) => {
  const { store, active, write } = await fixture(t);
  await write("one.jsonl", "one", [entry("a", 7)]);
  await write("two.jsonl", "two", [entry("a", 11)]);
  await store.sync();
  assert.equal(await sum(store), 0);
  await write("two.jsonl", "two", []);
  await store.sync();
  assert.equal(await sum(store), 8);
  assert.ok(!store.warnings.some((w) => w.includes("OMP_IDENTITY_CONFLICT")));
  await write("one.jsonl", "one", [entry("a", 17), entry("b", 5)]);
  await appendFile(path.join(active, "one.jsonl"), '{"type":');
  await store.sync();
  assert.equal(await sum(store), 14);
  await write("one.jsonl", "one", [entry("a", 17), entry("b", 5)]);
  await store.sync();
  assert.equal(await sum(store), 24);
});

test("OMP fork copies, archived moves and shortened logs preserve one published owner and its history", async (t) => {
  const { store, write, active, archive, options } = await fixture(t);
  await write("original.jsonl", "original", [entry("a"), entry("b", 20)]);
  await write("fork.jsonl", "fork", [entry("a"), entry("c", 1)], "original");
  await store.sync();
  assert.equal(await sum(store), 34);
  assert.deepEqual(
    store.database
      .prepare("SELECT session_id FROM omp_calls ORDER BY session_id")
      .all()
      .map((row) => row.session_id),
    ["fork", "original", "original"],
  );
  await write("original.jsonl", "original", [entry("a", 30)]);
  await store.sync();
  assert.equal(await sum(store), 54);
  const archiveFile = path.join(archive, "copy.jsonl.gz");
  await writeFile(archiveFile, gzipSync(await readFile(path.join(active, "original.jsonl"))));
  await rm(path.join(active, "original.jsonl"));
  await store.sync();
  assert.equal(await sum(store), 54);
  await writeFile(archiveFile, Buffer.from("corrupt"));
  await store.sync();
  assert.ok(store.warnings.some((w) => w.includes("OMP_")));
  assert.equal(await sum(store), 54);
  const lite = new LiteStore(options);
  try {
    await lite.open();
    assert.equal(lite.database.prepare("SELECT SUM(total) n FROM events").get().n, 54);
  } finally {
    lite.close();
  }
  assert.ok(!JSON.stringify(store.database.prepare("SELECT * FROM omp_occurrences").all()).includes("private-message"));
});

test("OMP initial conflicts remain unpublished across retries and known aliases merge sealed duplicates", async (t) => {
  const { store, root, write, options } = await fixture(t);
  await write("conflict-a.jsonl", "x", [entry("collision", 2)]);
  await write("conflict-b.jsonl", "y", [entry("collision", 100)]);
  await write("owner.jsonl", "owner", [entry("a", 10), entry("b", 10)]);
  await store.sync();
  assert.equal(await sum(store), 22);
  await store.sync();
  assert.ok(store.warnings.some((w) => w.includes("OMP_IDENTITY_CONFLICT")));
  const candidate = path.join(root, "archive.sqlite");
  await createHistoryArchiveCandidate(store.database, candidate, { startMs: time - 1000, endMs: time + 1000 });
  const compacted = await compactHistoryArchivePackage(candidate, path.join(root, "compact.sqlite"));
  assert.ok(compacted.tables.some(({ table, rows }) => table === "omp_calls" && rows === 2));
  await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, compacted.databaseFile));
  await write("owner.jsonl", "owner", [entry("a", 10, "r"), entry("b", 10, "r")]);
  await write("older.jsonl", "older", [entry("late", 20)]);
  await store.sync();
  assert.equal(await sum(store), 32);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
  await write("owner.jsonl", "owner", [entry("a", 15, "r")]);
  await store.sync();
  assert.equal(await sum(store), 37);
  const bundle = path.join(root, "bundle");
  const imported = path.join(root, "import");
  await publishHistoryArchiveBundle(store.database, bundle);
  await publishHistoryArchiveImport(bundle, imported);
  const loaded = await loadHistoryArchiveImport(imported);
  const restored = new UsageStore({ ...options, databaseFile: loaded.runtimeFile });
  try {
    await restored.open();
    assert.equal(await sum(restored), 37);
    await write("fork.jsonl", "fork", [entry("a", 15, "r")], "owner");
    await restored.sync();
    assert.equal(await sum(restored), 37);
  } finally {
    restored.close();
  }
});
