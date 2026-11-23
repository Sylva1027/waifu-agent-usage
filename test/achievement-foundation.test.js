import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AchievementFoundation, achievementDatabaseFile } from "../src/achievement-foundation.js";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { streamAchievementHermesEvents as streamHermesDbEvents } from "../src/achievement-hermes-source.js";
import { UsageStore } from "../src/usage-store.js";
import { createUsageExecutor } from "../src/usage-executor.js";

const T0 = Date.parse("2026-11-17T00:00:00Z");
const DAY = 86_400_000;
const sum = (input) => input.facts.reduce((total, fact) => total + BigInt(fact.totalTokens), 0n);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "achievement-foundation-"));
  const options = {
    homeDir: root,
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
    importStoreFile: path.join(root, "imports.json"),
    databaseFile: path.join(root, "usage-index.sqlite"),
  };
  const store = new UsageStore(options);
  await store.open();
  const foundation = new AchievementFoundation({ usageStore: store, clock: () => T0 + 4 * DAY });
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    foundation.close();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const sourcePath = path.join(root, "source.jsonl");
  await writeFile(sourcePath, "\n");
  store.database
    .prepare("INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?)")
    .run(sourcePath, "codex", "home", "fixture", root, 1, 0, new Date(T0).toISOString());
  const insert = (overrides = {}) => {
    const event = {
      source_path: sourcePath,
      timestamp_ms: T0 + 1000,
      session_id: "s",
      home_id: "home",
      home_label: "fixture",
      channel: "Codex",
      project: root,
      model: "gpt-6-sol",
      hour_key: "raw-hour",
      day_key: "raw-day",
      week_key: "raw-week",
      month_key: "raw-month",
      total: 100,
      input: 80,
      cached: 60,
      output: 20,
      reasoning: 5,
      ...overrides,
    };
    const columns = Object.keys(event);
    store.database
      .prepare(`INSERT INTO events (${columns.join(",")}) VALUES (${columns.map(() => "?")})`)
      .run(...Object.values(event));
  };
  const prepare = (extra = {}) =>
    foundation.prepare({ enabledAt: T0, timeZone: "UTC", cutoff: T0 + 4 * DAY, ...extra });
  return { root, store, foundation, sourcePath, options, insert, prepare, cleanup };
}

test("explicit preparation uses complete facts, stable inputs, owned archive and borrowed usage connection", async (t) => {
  const f = await fixture(t);
  f.insert({ timestamp_ms: T0 - 1 });
  f.insert();
  f.insert();
  assert.equal(existsSync(path.join(f.root, "achievements.sqlite")), false);
  const first = await f.prepare();
  assert.equal(sum(first), 300n);
  assert.equal(first.facts.length, 3);
  assert.equal(first.profile.enabledAt, new Date(T0).toISOString());
  assert.equal(f.foundation.archive.readSnapshot().state, "preparing");
  assert.equal(f.foundation.archive.readSnapshot().rows, null);
  const repeated = await f.prepare({ cutoff: T0 + 4 * DAY + 1000 });
  assert.deepEqual(repeated.facts, first.facts);
  assert.equal(repeated.inputKey, first.inputKey);
  f.foundation.close();
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM events").get().n, 3);
  const reopened = await f.prepare({ enabledAt: T0 + DAY, timeZone: "Asia/Shanghai" });
  assert.equal(reopened.profile.profileId, first.profile.profileId);
  assert.equal(reopened.profile.timeZone, "UTC");
  assert.equal(reopened.profile.enabledAt, first.profile.enabledAt);
  assert.deepEqual(reopened.facts, first.facts);
});

test("complete hot/cold input preserves identity and applies cold revision overlays through restart", async (t) => {
  const f = await fixture(t);
  f.insert({ timestamp_ms: T0 - 1 });
  f.insert();
  f.insert({ timestamp_ms: T0 + 2 * DAY });
  const before = await f.prepare();
  assert.equal(sum(before), 300n);
  const candidate = path.join(f.root, "archive.sqlite");
  await createHistoryArchiveCandidate(f.store.database, candidate, { startMs: T0 - DAY, endMs: T0 + DAY });
  await f.store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(f.store.database, candidate));
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
  const cold = await f.prepare();
  assert.deepEqual(cold.facts, before.facts);
  assert.equal(cold.inputKey, before.inputKey);
  const segment = f.store.database.prepare("SELECT * FROM archive_segments").get();
  const raw = (await f.store.readHistoryArchiveEvents(segment.segment_id))[0];
  const { id: _id, ...payload } = raw;
  const sourceIdentity = f.store.database
    .prepare("SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?")
    .get(f.sourcePath);
  const revision = {
    segmentId: segment.segment_id,
    databaseSha256: segment.database_sha256,
    sourceIdentity,
    removed: [{ payload, count: 1 }],
    added: [{ payload: { ...payload, total: payload.total + 19, output: payload.output + 19 }, count: 1 }],
  };
  f.store.database
    .prepare("INSERT INTO store_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run("history_archive_event_revisions", JSON.stringify({ formatVersion: 1, revisions: [revision] }));
  const revised = await f.prepare();
  assert.equal(sum(revised), 319n);
  assert.notEqual(revised.inputKey, cold.inputKey);
  f.foundation.close();
  f.store.close();
  await f.store.open();
  const reopened = await f.prepare();
  assert.deepEqual(reopened.facts, revised.facts);
  assert.equal(reopened.inputKey, revised.inputKey);
});

test("common repository evidence survives the original worktree directory disappearing", async (t) => {
  const f = await fixture(t);
  const main = path.join(f.root, "main"),
    branch = path.join(f.root, "branch");
  await mkdir(path.join(main, ".git", "worktrees", "branch"), { recursive: true });
  await mkdir(branch);
  await writeFile(path.join(branch, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "branch")}\n`);
  await writeFile(path.join(main, ".git", "worktrees", "branch", "commondir"), "../..\n");
  f.insert({ repository_key: "legacy-main", repository_kind: "git", repository_path: main });
  f.insert({ repository_key: "legacy-branch", repository_kind: "git", repository_path: branch });
  const first = await f.prepare();
  assert.equal(new Set(first.facts.map((x) => x.repositoryKey)).size, 1);
  await rm(branch, { recursive: true });
  f.foundation.close();
  const reopened = await f.prepare();
  assert.deepEqual(reopened.facts, first.facts);
  assert.equal(reopened.inputKey, first.inputKey);
});

test("Hermes credits complete historical coverage and preserves later segments through restart", async (t) => {
  const f = await fixture(t);
  const ledgerFile = path.join(f.root, "state.db");
  const ledger = new DatabaseSync(ledgerFile);
  f.cleanup.push(() => ledger.close());
  ledger.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,cwd TEXT,started_at REAL,last_activity_at REAL,input_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER)",
  );
  ledger
    .prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("hermes-session", "cli", f.root, (T0 - DAY) / 1000, (T0 + 1000) / 1000, 100, 0, 0, 0, 0);
  const source = { id: "home", label: "fixture", path: f.root };
  const capture = async () => {
    const events = [];
    await streamHermesDbEvents(ledgerFile, source, (event) => events.push(event), {});
    return events[0];
  };
  f.store.database.prepare("UPDATE source_files SET path=?,kind='hermes' WHERE path=?").run(ledgerFile, f.sourcePath);
  let event = await capture();
  f.insert({
    source_path: ledgerFile,
    timestamp_ms: event.timestampMs,
    total: 100,
    input: 100,
    cached: 0,
    output: 0,
    reasoning: 0,
    source_event_id: event.sourceEventId,
    model: "Unknown model",
    channel: "Hermes",
  });
  const baseline = await f.prepare({ cutoff: T0 + 2000 });
  assert.equal(sum(baseline), 100n);
  assert.deepEqual(baseline.facts[0].coverage, { start: T0 - DAY, end: T0 + 1000 });
  ledger.prepare("UPDATE sessions SET input_tokens=150,last_activity_at=?").run((T0 + 4000) / 1000);
  event = await capture();
  f.store.database.prepare("UPDATE events SET total=150,input=150,timestamp_ms=?").run(event.timestampMs);
  const after = await f.prepare({ cutoff: T0 + 5000 });
  assert.equal(sum(after), 150n);
  assert.equal(after.facts.length, 2);
  const delta = after.facts.find(({ totalTokens }) => totalTokens === "50");
  assert.equal(delta.precision, "interval");
  assert.deepEqual(delta.coverage, { start: T0 + 2000, end: T0 + 4000 });
  f.foundation.close();
  const reopened = await f.prepare({ cutoff: T0 + 6000 });
  assert.deepEqual(reopened.facts, after.facts);
  assert.equal(reopened.inputKey, after.inputKey);
  assert.equal(f.foundation.archive.readSnapshot().rows, null);
});

test("free evidence is persisted by effective time and does not follow mutable prices", async (t) => {
  const f = await fixture(t);
  f.insert({ model: "hy4free" });
  f.insert({ model: "codex-auto-review" });
  const policy = {
    evidenceKey: "fixture-only",
    version: "1",
    validFrom: T0,
    validUntil: T0 + DAY,
    sourceKind: "codex",
    model: "hy4free",
    route: "",
    freeClass: "free",
    type: "explicit-free-identity",
  };
  const first = await f.prepare({ policies: [policy] });
  assert.deepEqual(new Set(first.facts.map((x) => x.freeClass)), new Set(["free", "review"]));
  f.foundation.close();
  f.store.database.exec("UPDATE events SET price_version='new-paid-quote'");
  const repeated = await f.prepare();
  assert.deepEqual(repeated.facts, first.facts);
  assert.equal(repeated.inputKey, first.inputKey);
});

test("path ownership and read-only contexts do not accidentally create a profile", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "forbidden.sqlite");
  const readOnly = new AchievementFoundation({ usageStore: f.store, databaseFile: file, readOnlyContext: true });
  assert.throws(() => readOnly.open(), /cannot initialize/);
  assert.equal(existsSync(file), false);
  assert.throws(() => achievementDatabaseFile(":memory:"), /isolated/);
  assert.equal(
    achievementDatabaseFile(path.join(f.root, "a.sqlite")),
    path.join(f.root, "a.sqlite.achievements.sqlite"),
  );
});

test("existing executor prepares only explicit Waifu input and reopens the same persistent archive", async (t) => {
  const f = await fixture(t);
  f.insert();
  f.store.close();
  let executor = createUsageExecutor(f.options, { idleTimeoutMs: 10000 });
  f.cleanup.push(async () => {
    await executor.close();
  });
  assert.equal((await executor.publishedUsageEvents()).length, 1);
  assert.equal(existsSync(path.join(f.root, "achievements.sqlite")), false);
  await assert.rejects(executor.achievementPrepare({ edition: "lite" }), { code: "ACHIEVEMENT_CONTEXT_REQUIRED" });
  const args = { edition: "waifu", enabledAt: T0, timeZone: "UTC", cutoff: T0 + DAY };
  const first = await executor.achievementPrepare(args);
  assert.equal(sum(first), 100n);
  await executor.close();
  executor = createUsageExecutor(f.options, { idleTimeoutMs: 10000 });
  const reopened = await executor.achievementPrepare(args);
  assert.equal(reopened.profile.profileId, first.profile.profileId);
  assert.equal(reopened.inputKey, first.inputKey);
});
