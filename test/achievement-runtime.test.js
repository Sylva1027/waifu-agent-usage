import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { evaluateAchievements } from "../src/achievement-evaluator.js";
import { AchievementAggregates } from "../src/achievement-incremental.js";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { streamAchievementHermesEvents as streamHermesDbEvents } from "../src/achievement-hermes-source.js";
import { DAY, T0, observed, runtimeFixture, seedRuntimePerformance } from "./fixtures/achievement-runtime-fixture.js";

test("start establishes T0 without reading history; first update publishes all 42 rows and repeated reads do no work", async (t) => {
  const f = await runtimeFixture(t);
  f.insert({ timestamp_ms: T0 - 1, total: 9999 });
  f.insert({ timestamp_ms: T0, total: 10 });
  f.insert({ timestamp_ms: T0 + 1000, total: 20 });
  assert.equal(existsSync(f.runtime.databaseFile), false);
  assert.equal(f.runtime.readSnapshot(), null);
  const start = await f.runtime.start();
  assert.equal(start.state, "preparing");
  assert.equal(start.rows, null);
  assert.equal(f.runtime.diagnostics.processedRows, 0);
  assert.equal(f.runtime.databaseFile, f.options.databaseFile);
  f.setNow(T0 + 1000);
  const first = await f.runtime.update();
  assert.equal(first.rows.length, 42);
  assert.equal(observed(first, "A01"), "10");
  assert.equal(f.runtime.diagnostics.mode, "rebuild");
  assert.equal(f.runtime.diagnostics.processedRows, 3);
  for (let i = 0; i < 10; i++) assert.deepEqual(f.runtime.readSnapshot(), first);
  const calls = f.store.withSqlHistoryReader;
  f.store.withSqlHistoryReader = () => {
    throw new Error("unchanged must not read full history");
  };
  assert.deepEqual(await f.runtime.update(), first);
  assert.equal(f.runtime.diagnostics.mode, "skip");
  assert.equal(f.runtime.diagnostics.processedRows, 0);
  f.store.withSqlHistoryReader = calls;
  f.setNow(T0 + 1001);
  assert.equal(observed(await f.runtime.update(), "A01"), "30");
  assert.equal(f.runtime.diagnostics.reason, "deferred-cutoff");
});

test("proven hot append reads only new rows and evaluates aggregates, preserving exact totals and record count", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  seedRuntimePerformance(f, 300, T0 + 1000);
  f.setNow(T0 + 2000);
  await f.runtime.update();
  f.insert({ timestamp_ms: T0 + 2500, total: 50_000_000_000 });
  f.insert({ timestamp_ms: T0 + 2600, total: 50_000_000_000 });
  f.setNow(T0 + 3000);
  const read = f.store.withSqlHistoryReader;
  f.store.withSqlHistoryReader = () => {
    throw new Error("hot append must not materialize all events");
  };
  const result = await f.runtime.update();
  f.store.withSqlHistoryReader = read;
  assert.equal(observed(result, "A01"), "100003000000");
  assert.equal(observed(result, "A31"), "302");
  assert.equal(f.runtime.diagnostics.mode, "append");
  assert.equal(f.runtime.diagnostics.processedRows, 2);
  assert.equal(f.runtime.diagnostics.readMode, "hot-tail");
  assert.ok(f.runtime.diagnostics.evaluatedBuckets < 302);
  assert.equal(result.rows.find((row) => row.id === "A01").highestEarned, "bronze");
  const independent = await f.runtime.foundation.prepare({ cutoff: T0 + 3000 });
  assert.deepEqual(
    result.rows.map(({ id, observedValue, nextTarget }) => ({ id, observedValue, nextTarget })),
    evaluateAchievements(independent, result.awards).rows,
  );
});

test("revision, deletion, late append and alias changes rebuild explicitly while keeping earned dates", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  const id = f.insert({ timestamp_ms: T0 + 1, total: 50_000_000_000 });
  f.setNow(T0 + 10);
  const earned = await f.runtime.update();
  f.store.database.prepare("UPDATE events SET total=4 WHERE id=?").run(id);
  const revised = await f.runtime.update();
  assert.equal(observed(revised, "A01"), "4");
  assert.equal(f.runtime.diagnostics.reason, "revision-or-deletion");
  assert.equal(f.runtime.diagnostics.processedRows, 1);
  f.store.database.prepare("DELETE FROM events WHERE id=?").run(id);
  const removed = await f.runtime.update();
  assert.equal(observed(removed, "A01"), "0");
  assert.equal(f.runtime.diagnostics.processedRows, 0);
  assert.deepEqual(removed.awards, earned.awards);
  f.insert({ timestamp_ms: T0 + 2, total: 7, model: "custom-alias" });
  assert.equal(observed(await f.runtime.update(), "A01"), "7");
  assert.equal(f.runtime.diagnostics.reason, "late-append");
  await f.runtime.update({ pricingModels: { "gpt-6-sol": { aliases: ["custom-alias"] } } });
  assert.equal(f.runtime.diagnostics.reason, "identity-or-policy");
});

test("period closure without tokens settles completed week and month; current periods are not settled early", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  for (let d = 0; d < 20; d++) f.insert({ timestamp_ms: T0 + d * DAY + 1000, total: 100_000_000 });
  f.insert({ timestamp_ms: T0 + DAY + 1000, channel: "Codex", total: 1_000_000_000 });
  const claudePath = path.join(f.root, "claude.jsonl");
  await writeFile(claudePath, "\n");
  f.store.database
    .prepare("INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?)")
    .run(claudePath, "claude", "claude-home", "fixture", f.root, 1, 0, new Date(T0).toISOString());
  f.insert({
    source_path: claudePath,
    home_id: "claude-home",
    timestamp_ms: T0 + DAY + 1000,
    channel: "Claude",
    total: 1_000_000_000,
  });
  f.setNow(T0 + 8 * DAY - 1);
  assert.equal(observed(await f.runtime.update(), "A29"), "0");
  f.setNow(T0 + 8 * DAY);
  assert.equal(observed(await f.runtime.update(), "A29"), "2");
  assert.equal(f.runtime.diagnostics.processedRows, 0);
  f.setNow(T0 + 21 * DAY);
  const before = await f.runtime.update();
  assert.equal(observed(before, "A16"), "0");
  assert.equal(observed(before, "A65"), "0");
  f.setNow(Date.parse("2026-12-01T00:00:00Z"));
  const after = await f.runtime.update();
  assert.equal(observed(after, "A16"), "1");
  assert.equal(observed(after, "A65"), "1");
  assert.equal(f.runtime.diagnostics.mode, "settle");
  assert.equal(f.runtime.diagnostics.processedRows, 0);
  assert.equal(after.progressRevision, before.progressRevision + 1);
  assert.equal((await f.runtime.update()).progressRevision, after.progressRevision);
});

test("operation changes settle without adapting usage and replay remains idempotent", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  f.setNow(T0 + 1000);
  await f.runtime.update();
  f.runtime.archive.recordOperation({ kind: "share", key: "trusted-content", occurredAt: T0 + 500, payload: {} });
  const changed = await f.runtime.update();
  assert.equal(observed(changed, "A43"), "1");
  assert.equal(f.runtime.diagnostics.mode, "settle");
  assert.equal(f.runtime.diagnostics.processedRows, 0);
  assert.deepEqual(await f.runtime.update(), changed);
  f.runtime.archive.recordOperation({ kind: "share", key: "at-cutoff", occurredAt: T0 + 1000, payload: {} });
  assert.equal(observed(await f.runtime.update(), "A43"), "1");
  f.setNow(T0 + 1001);
  assert.equal(observed(await f.runtime.update(), "A43"), "2");
  assert.equal(f.runtime.diagnostics.processedRows, 0);
});

test("cold migration, canonical cold revision and hot append agree with independent full evaluation through reopen", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  f.insert({ timestamp_ms: T0 + 100, total: 10 });
  f.insert({ timestamp_ms: T0 + 2 * DAY, total: 20 });
  f.setNow(T0 + 3 * DAY);
  const hot = await f.runtime.update();
  const file = path.join(f.root, "archive.sqlite");
  await createHistoryArchiveCandidate(f.store.database, file, { startMs: T0, endMs: T0 + DAY });
  await f.store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(f.store.database, file));
  const cold = await f.runtime.update();
  assert.equal(observed(cold, "A01"), "30");
  assert.deepEqual(cold.awards, hot.awards);
  assert.equal(f.runtime.diagnostics.reason, "cold-structure");
  assert.equal(f.runtime.diagnostics.processedRows, 2);
  f.insert({ timestamp_ms: T0 + 3 * DAY + 1, total: 40 });
  f.setNow(T0 + 3 * DAY + 2);
  const appended = await f.runtime.update();
  assert.equal(observed(appended, "A01"), "70");
  assert.equal(f.runtime.diagnostics.mode, "append");
  assert.equal(f.runtime.diagnostics.processedRows, 1);
  const segment = f.store.database.prepare("SELECT * FROM archive_segments").get();
  const { id: _id, ...payload } = (await f.store.readHistoryArchiveEvents(segment.segment_id))[0];
  const sourceIdentity = f.store.database
    .prepare("SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?")
    .get(f.sourcePath);
  const revision = {
    segmentId: segment.segment_id,
    databaseSha256: segment.database_sha256,
    sourceIdentity,
    removed: [{ payload, count: 1 }],
    added: [{ payload: { ...payload, total: 11 }, count: 1 }],
  };
  f.store.database
    .prepare("INSERT INTO store_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run("history_archive_event_revisions", JSON.stringify({ formatVersion: 1, revisions: [revision] }));
  const revised = await f.runtime.update();
  assert.equal(observed(revised, "A01"), "71");
  assert.equal(f.runtime.diagnostics.reason, "cold-structure");
  const { profileId, enabledAt, timeZone } = revised;
  const reopened = await f.reopen().start();
  assert.equal(reopened.profileId, profileId);
  assert.equal(reopened.enabledAt, enabledAt);
  assert.equal(reopened.timeZone, timeZone);
  assert.deepEqual(reopened.rows, revised.rows);
  const replay = await f.runtime.update();
  assert.equal(observed(replay, "A01"), "71");
  assert.equal(replay.progressRevision, revised.progressRevision);
  assert.equal(f.runtime.diagnostics.mode, "rebuild");
  assert.equal(f.runtime.diagnostics.processedRows, 3);
});

test("explicit free identities create finite immutable evidence; zero prices, review and unknown history do not count", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  for (const [model, total] of [
    ["hy4free", 10],
    ["router/exact-model-free", 20],
    ["codex-auto-review", 30],
    ["router/paid-model", 40],
    ["gpt-6-sol", 50],
    ["almost-free-model", 60],
  ])
    f.insert({ timestamp_ms: T0 + 1, model, total });
  f.setNow(T0 + 10);
  const result = await f.runtime.update({ pricingModels: { "gpt-6-sol": { input: 0, output: 0 } } });
  assert.equal(observed(result, "A06"), "30");
  assert.equal(observed(result, "A01"), "210");
  assert.deepEqual(await f.runtime.update({ pricingModels: { "gpt-6-sol": { input: 999, output: 999 } } }), result);
  assert.equal(f.runtime.diagnostics.mode, "skip");
  const evidence = f.runtime.archive.readEvidence("free-policy");
  assert.equal(evidence.length, 2);
  for (const { value } of evidence) {
    assert.equal(value.type, "explicit-free-identity");
    assert.equal(value.validFrom, T0 + 1);
    assert.equal(value.validUntil, T0 + 2);
    assert.equal(value.sourceKind, "codex");
    assert.ok(!value.model.includes("*"));
  }
  await f.reopen().start();
  assert.equal(observed(await f.runtime.update(), "A06"), "30");
  assert.deepEqual(f.runtime.archive.readEvidence("free-policy"), evidence);
  const prepared = await f.runtime.foundation.prepare({ cutoff: T0 + 10 });
  assert.equal(prepared.facts.find((row) => row.rawModel === "codex-auto-review").freeClass, "review");
  assert.equal(prepared.facts.find((row) => row.rawModel === "gpt-6-sol").freeClass, "unknown");
});

test("finite identity evidence groups actual batch bounds and stays stable through append and reopen", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  seedRuntimePerformance(f, 300, T0 + 1000);
  f.setNow(T0 + 2000);
  const first = await f.runtime.update();
  const evidence = f.runtime.archive.readEvidence("free-policy");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].value.validFrom, T0 + 1002);
  assert.equal(evidence[0].value.validUntil, T0 + 1300);
  seedRuntimePerformance(f, 10, T0 + 2100);
  f.setNow(T0 + 2200);
  const appended = await f.runtime.update();
  assert.equal(observed(appended, "A06"), "1030000");
  assert.equal(f.runtime.archive.readEvidence("free-policy").length, 2);
  await f.reopen().start();
  const reopened = await f.runtime.update();
  assert.deepEqual(reopened.rows, appended.rows);
  assert.equal(f.runtime.archive.readEvidence("free-policy").length, 2);
  assert.equal(observed(first, "A06"), "1000000");
});

test("native identities in a cold segment cannot be replayed by a new hot tail after dropping the fact-key cache", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  f.insert({ timestamp_ms: T0 + 100, total: 10, source_event_id: "native-event" });
  f.setNow(T0 + 3 * DAY);
  await f.runtime.update();
  const file = path.join(f.root, "archive.sqlite");
  await createHistoryArchiveCandidate(f.store.database, file, { startMs: T0, endMs: T0 + DAY });
  await f.store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(f.store.database, file));
  const before = await f.runtime.update();
  f.insert({ timestamp_ms: T0 + 3 * DAY + 1, total: 10, source_event_id: "native-event" });
  f.setNow(T0 + 3 * DAY + 2);
  await assert.rejects(f.runtime.update(), /Duplicate achievement source event identity/);
  assert.deepEqual(f.runtime.readSnapshot(), before);
});

test("Hermes start captures ledger-only T0 baseline, later positive deltas and missing raw evidence survive restart", async (t) => {
  const f = await runtimeFixture(t);
  const ledgerFile = path.join(f.root, "state.db");
  const ledger = new DatabaseSync(ledgerFile);
  f.cleanup.push(() => ledger.close());
  ledger.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,cwd TEXT,started_at REAL,last_activity_at REAL,input_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER)",
  );
  ledger
    .prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("hermes-session", "cli", f.root, (T0 - DAY) / 1000, (T0 - 1000) / 1000, 100, 0, 0, 0, 0);
  f.store.database.prepare("UPDATE source_files SET path=?,kind='hermes' WHERE path=?").run(ledgerFile, f.sourcePath);
  f.options.sourceHomes = [{ kind: "hermes", id: "home", path: f.root }];
  f.reopen();
  const capture = async () => {
    const rows = [];
    await streamHermesDbEvents(
      ledgerFile,
      { id: "home", label: "fixture", path: f.root },
      (event) => rows.push(event),
      {},
    );
    return rows[0];
  };
  let event = await capture();
  f.insert({
    source_path: ledgerFile,
    model: "Unknown model",
    channel: "Hermes",
    total: 100,
    source_event_id: event.sourceEventId,
    timestamp_ms: event.timestampMs,
  });
  await f.runtime.start();
  assert.equal(f.runtime.diagnostics.baselineRows, 1);
  assert.equal(f.runtime.diagnostics.processedRows, 0);
  ledger.prepare("UPDATE sessions SET input_tokens=150,last_activity_at=?").run((T0 + 1000) / 1000);
  event = await capture();
  f.store.database.prepare("UPDATE events SET total=150,timestamp_ms=?").run(event.timestampMs);
  f.setNow(T0 + 2000);
  assert.equal(observed(await f.runtime.update(), "A01"), "50");
  f.store.database.prepare("UPDATE source_files SET size=2 WHERE path=?").run(ledgerFile);
  const before = f.runtime.readSnapshot();
  const evidenceUpdated = await f.runtime.update();
  assert.deepEqual(evidenceUpdated.rows, before.rows);
  assert.deepEqual(evidenceUpdated.awards, before.awards);
  assert.equal(f.runtime.diagnostics.reason, "source-evidence-or-identity");
  ledger.prepare("UPDATE sessions SET input_tokens=180,last_activity_at=?").run((T0 + 3000) / 1000);
  event = await capture();
  f.store.database.prepare("UPDATE events SET total=180,timestamp_ms=?").run(event.timestampMs);
  f.setNow(T0 + 4000);
  assert.equal(observed(await f.runtime.update(), "A01"), "80");
  assert.equal(f.runtime.diagnostics.reason, "revision-or-deletion");
  f.cleanup.pop()();
  await rm(ledgerFile);
  await f.reopen().start();
  assert.equal(observed(await f.runtime.update(), "A01"), "80");
  assert.equal(f.runtime.diagnostics.evidenceWarnings.length, 1);
});

test("confirmed Hermes homes establish a pre-sync baseline without source_files or ordinary history reads", async (t) => {
  const f = await runtimeFixture(t);
  f.store.database.exec("DELETE FROM source_files");
  const ledgerFile = path.join(f.root, "state.db");
  const ledger = new DatabaseSync(ledgerFile);
  f.cleanup.push(() => ledger.close());
  ledger.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,cwd TEXT,started_at REAL,last_activity_at REAL,input_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER)",
  );
  ledger
    .prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("fresh-session", "cli", f.root, (T0 - DAY) / 1000, (T0 - 1000) / 1000, 100, 0, 0, 0, 0);
  f.options.sourceHomes = [
    { kind: "hermes", id: "fresh-hermes", path: f.root },
    { kind: "codex", id: "ignored", path: f.root },
  ];
  f.reopen();
  const read = f.store.withSqlHistoryReader;
  f.store.withSqlHistoryReader = () => {
    throw new Error("start must not scan ordinary history");
  };
  const initial = await f.runtime.start();
  f.store.withSqlHistoryReader = read;
  assert.equal(initial.state, "preparing");
  assert.equal(f.runtime.diagnostics.baselineRows, 1);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM source_files").get().n, 0);
  const [checkpoint] = Object.values(f.runtime.archive.readCheckpoints());
  assert.equal(checkpoint.homeId, "fresh-hermes");
  assert.equal(checkpoint.sourcePath, ledgerFile);
  assert.equal(checkpoint.total, "100");
  assert.equal(checkpoint.credited, "0");
  assert.equal(checkpoint.observedAt, T0);
  ledger.prepare("UPDATE sessions SET input_tokens=150,last_activity_at=?").run((T0 + 1000) / 1000);
  const rows = [];
  await streamHermesDbEvents(
    ledgerFile,
    { id: "fresh-hermes", label: "fresh-hermes", path: f.root },
    (event) => rows.push(event),
    {},
  );
  const event = rows[0];
  f.store.database
    .prepare("INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?)")
    .run(ledgerFile, "hermes", "fresh-hermes", "fresh-hermes", f.root, 1, 0, new Date(T0).toISOString());
  f.insert({
    source_path: ledgerFile,
    home_id: "fresh-hermes",
    model: "Unknown model",
    channel: "Hermes",
    total: 150,
    timestamp_ms: event.timestampMs,
    source_event_id: event.sourceEventId,
  });
  f.setNow(T0 + 2000);
  assert.equal(observed(await f.runtime.update(), "A01"), "50");
});

test("confirmed Hermes ledgers already advanced after T0 use a conservative observation baseline", async (t) => {
  const f = await runtimeFixture(t);
  f.store.database.exec("DELETE FROM source_files");
  const ledgerFile = path.join(f.root, "state.db");
  const ledger = new DatabaseSync(ledgerFile);
  f.cleanup.push(() => ledger.close());
  ledger.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,cwd TEXT,started_at REAL,last_activity_at REAL,input_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER)",
  );
  ledger
    .prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("advanced-session", "cli", f.root, (T0 - DAY) / 1000, (T0 + 1000) / 1000, 100, 0, 0, 0, 0);
  let opened = false;
  f.options.clock = () => {
    if (!opened) {
      opened = true;
      return T0;
    }
    return T0 + 2000;
  };
  f.options.sourceHomes = [{ kind: "hermes", id: "fresh-hermes", path: f.root }];
  f.reopen();
  await f.runtime.start();
  const [checkpoint] = Object.values(f.runtime.archive.readCheckpoints());
  assert.equal(checkpoint.enabledAt, T0);
  assert.equal(checkpoint.observedAt, T0 + 2000);
  assert.equal(checkpoint.credited, "0");
  assert.equal(f.runtime.readSnapshot().rows, null);
});

test("a complete pinned source may publish while live advances and the next update catches up", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  f.insert({ timestamp_ms: T0 + 1, total: 10 });
  f.setNow(T0 + 10);
  const prepare = f.runtime.foundation.prepare.bind(f.runtime.foundation);
  let changed = false;
  f.runtime.foundation.prepare = async (options) => {
    const input = await prepare(options);
    if (!changed) {
      changed = true;
      f.insert({ timestamp_ms: T0 + 2, total: 20 });
    }
    return input;
  };
  const snapshot = await f.runtime.update();
  assert.equal(observed(snapshot, "A01"), "10");
  assert.equal(snapshot.progressRevision, 1);
  assert.equal(f.runtime.diagnostics.pendingCatchUp, true);
  assert.equal(observed(await f.runtime.update(), "A01"), "30");
  assert.equal(f.runtime.diagnostics.pendingCatchUp, false);
});

test("a tail whose append proof changes is released and recaptured before publication", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  f.insert({ timestamp_ms: T0 + 1, total: 10 });
  f.setNow(T0 + 10);
  await f.runtime.update();
  f.insert({ timestamp_ms: T0 + 11, total: 20 });
  f.setNow(T0 + 20);
  const prepare = f.runtime.foundation.prepare.bind(f.runtime.foundation);
  let changed = false;
  f.runtime.foundation.prepare = async (options) => {
    const input = await prepare(options);
    if (!changed) {
      changed = true;
      f.store.database.exec("UPDATE events SET total=15 WHERE id=1");
    }
    return input;
  };
  assert.equal(observed(await f.runtime.update(), "A01"), "35");
  assert.equal(f.runtime.diagnostics.captureRetries, 1);
});

test("bucket projection preserves all S08-C values for mixed intervals, identities, calendars and cumulative segments", async (t) => {
  const f = await runtimeFixture(t);
  const profile = await f.runtime.start();
  const facts = [];
  for (let i = 0; i < 500; i++) {
    const start = T0 + (i % 90) * DAY + (i % 20) * 1000;
    const end = start + [0, 10, 2 * DAY, 35 * DAY][i % 4];
    facts.push({
      factKey: `fixture-${i}`,
      revision: `r-${i}`,
      occurredAt: end,
      precision: end === start ? "instant" : "interval",
      coverage: { start, end },
      totalTokens: String((i + 1) * 100_000_000),
      modelId: i % 9 ? `model-${i % 3}` : null,
      providerId: i % 11 ? `provider-${i % 2}` : null,
      harnessId: `harness-${i % 2}`,
      repositoryKey: i % 13 ? `repo-${i % 4}` : null,
      sessionKey: `session-${i % 20}`,
      freeClass: i % 3 ? "unknown" : "free",
      freeEvidenceKey: i % 3 ? null : "finite-fixture",
    });
  }
  const input = { profile, facts, cutoff: T0 + 150 * DAY, operations: [], inputKey: "mixed-fixture" };
  const aggregates = new AchievementAggregates("UTC");
  for (let i = 0; i < facts.length; i += 17) aggregates.append(facts.slice(i, i + 17));
  assert.deepEqual(aggregates.evaluate(input, []), evaluateAchievements(input));
});

test("failed publication preserves the previous complete result and recovers by rebuilding, without duplicate awards", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  f.setNow(T0 + 10);
  const before = await f.runtime.update();
  f.insert({ timestamp_ms: T0 + 11, total: 50_000_000_000 });
  f.setNow(T0 + 20);
  const commit = f.runtime.archive.commitBatch;
  f.runtime.archive.commitBatch = () => {
    throw new Error("injected publication failure");
  };
  await assert.rejects(f.runtime.update(), /injected/);
  assert.deepEqual(f.runtime.readSnapshot(), before);
  f.runtime.archive.commitBatch = commit;
  const recovered = await f.runtime.update();
  assert.equal(observed(recovered, "A01"), "50000000000");
  assert.equal(recovered.awards.filter(({ id }) => id === "A01").length, 1);
  assert.deepEqual(await f.runtime.update(), recovered);
});

test("performance fixture reports actual first/unchanged/append/revision/reopen work in isolated SQLite", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  seedRuntimePerformance(f, 5000, T0 + 1000);
  f.setNow(T0 + 10000);
  const measurements = [];
  const sample = async (label) => {
    const result = await f.runtime.update();
    measurements.push({ label, ...f.runtime.diagnostics });
    return result;
  };
  assert.equal(observed(await sample("first"), "A01"), "50000000");
  await sample("unchanged");
  seedRuntimePerformance(f, 10, T0 + 11000);
  f.setNow(T0 + 12000);
  assert.equal(observed(await sample("append"), "A01"), "50100000");
  f.store.database.exec("UPDATE events SET total=total+1 WHERE id=1");
  assert.equal(observed(await sample("revision"), "A01"), "50100001");
  await f.reopen().start();
  assert.equal(observed(await sample("reopen"), "A01"), "50100001");
  assert.deepEqual(
    measurements.map(({ processedRows }) => processedRows),
    [5000, 0, 10, 5010, 5010],
  );
  assert.ok(measurements[2].evaluatedBuckets < 100);
  for (const measurement of measurements) t.diagnostic(JSON.stringify(measurement));
});
