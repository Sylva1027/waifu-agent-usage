import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readAchievementFacts } from "../src/achievement-facts.js";
import { UsageStore } from "../src/usage-store.js";

const T0 = Date.parse("2026-11-15T00:00:00Z");
const DAY = 86_400_000;
const stamp = { facts: 1, identityVersion: "identity-v1", freePolicyVersion: "free-v1" };
const identity = (event) => ({
  modelId: event.model === "alias" ? "model" : event.model,
  providerId: "provider",
  harnessId: event.sourceKind,
  sessionKey: JSON.stringify([event.homeId, event.sessionId]),
  repositoryKey: event.repositoryKey,
});
const classifyFree = () => ({ freeClass: "unknown", freeEvidenceKey: null });
const options = (extra = {}) => ({ enabledAt: T0, cutoff: T0 + 4 * DAY, stamp, identity, classifyFree, ...extra });

// Use production DDL and actual inserted rows, without scanning any homes or user logs.
async function fixture(t, kind = "codex") {
  const store = new UsageStore({ databaseFile: ":memory:" });
  await store.open();
  t.after(() => store.close());
  const db = store.database;
  const source = (sourcePath = "/home/a/events", homeId = "home-a", sourceKind = kind) =>
    db
      .prepare(`INSERT INTO source_files(path,kind,home_id,home_label,home_path,size,mtime_ms,indexed_at)
      VALUES(?,?,?,?,?,0,0,'fixture')`)
      .run(sourcePath, sourceKind, homeId, homeId, `/homes/${homeId}`);
  source();
  const insert = (overrides = {}) => {
    const row = {
      source_path: "/home/a/events",
      timestamp_ms: T0 + 1000,
      session_id: "same-session",
      home_id: "home-a",
      home_label: "Home",
      channel: kind,
      project: "/repo",
      model: "alias",
      hour_key: "calendar-hour",
      day_key: "calendar-day",
      week_key: "calendar-week",
      month_key: "calendar-month",
      total: 100,
      input: 75,
      cached: 25,
      output: 25,
      reasoning: 10,
      source_event_id: "",
      ...overrides,
    };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO events(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(
      ...Object.values(row),
    );
    return row;
  };
  return { db, source, insert };
}

function evidence(row, { start = T0 - DAY, observedAt = row.timestamp_ms, ...extra } = {}) {
  return {
    sourceEventId: row.source_event_id,
    homeId: row.home_id,
    sourcePath: row.source_path,
    totalTokens: String(row.total),
    timestampMs: row.timestamp_ms,
    coverage: { start, end: row.timestamp_ms },
    precision: "interval",
    cumulative: true,
    observedAt,
    ...extra,
  };
}

function hermesRead(db, row, proof, previous, extra = {}) {
  return readAchievementFacts(
    db,
    options({
      evidenceBySourceEvent: new Map([[row.source_event_id, proof]]),
      checkpoints: previous ? Object.fromEntries(previous.sourceCheckpoints.map((cp) => [cp.key, cp])) : {},
      ...extra,
    }),
  );
}

test("T0/cutoff are half-open; normalized total is not increased by cache/reasoning", async (t) => {
  const { db, insert } = await fixture(t);
  for (const timestamp_ms of [T0 - 1, T0, T0 + 1, T0 + DAY, T0 + DAY + 1]) insert({ timestamp_ms });
  insert({ timestamp_ms: T0 + 10, total: 0 });
  const result = readAchievementFacts(db, options({ cutoff: T0 + DAY }));
  assert.deepEqual(result.facts.map((f) => f.occurredAt).sort(), [T0, T0 + 1]);
  assert.deepEqual(
    result.facts.map((f) => f.totalTokens),
    ["100", "100"],
  );
  assert.equal(result.excluded.beforeEnabledAt, 1);
  assert.equal(result.excluded.atOrAfterCutoff, 2);
  assert.equal(result.excluded.zeroTokens, 1);
  assert.equal(result.stamp, stamp);
  const fact = result.facts[0];
  assert.equal(fact.modelId, "model");
  assert.equal(fact.rawModel, "alias");
  assert.equal(fact.precision, "instant");
  assert.deepEqual(fact.coverage, { start: fact.occurredAt, end: fact.occurredAt });
});

test("historical usage eligibility uses the usage range without moving the profile activation", async (t) => {
  const { db, insert } = await fixture(t);
  for (const timestamp_ms of [T0 - DAY - 1, T0 - DAY, T0 + 1, T0 + DAY]) insert({ timestamp_ms });
  const result = readAchievementFacts(db, options({ usageStart: T0 - DAY, cutoff: T0 + DAY }));
  assert.deepEqual(result.facts.map(({ occurredAt }) => occurredAt).sort(), [T0 - DAY, T0 + 1]);
  assert.equal(result.excluded.beforeEnabledAt, 1);
  assert.equal(result.excluded.atOrAfterCutoff, 1);
});

test("legitimate identical payloads remain a multiset; physical and pricing changes are immaterial", async (t) => {
  const { db, insert } = await fixture(t);
  insert();
  insert();
  insert({ timestamp_ms: T0 + 5000 });
  const before = readAchievementFacts(db, options());
  assert.equal(new Set(before.facts.map((f) => f.factKey)).size, 3);
  db.exec(`UPDATE events SET id=id+100, day_key='other', hour_key='other', week_key='other',
    month_key='other', price_version='old-price', home_label='renamed';
    UPDATE source_files SET size=99,mtime_ms=999,indexed_at='new',home_label='renamed';
    PRAGMA reverse_unordered_selects=ON`);
  const after = readAchievementFacts(
    db,
    options({
      cutoff: T0 + 5 * DAY,
      stamp: { ...stamp, token: "random-acquisition", asOf: "now", schema: 20, auxiliary: 99 },
    }),
  );
  assert.deepEqual(after.facts, before.facts);
  assert.equal(after.inputKey, before.inputKey);
  db.prepare("DELETE FROM events WHERE id=(SELECT MAX(id) FROM events WHERE timestamp_ms=?)").run(T0 + 1000);
  const removed = readAchievementFacts(db, options());
  assert.equal(removed.facts.length, 2);
  assert.ok(removed.facts.every((f) => before.facts.some((old) => f.factKey === old.factKey)));
  assert.notEqual(removed.inputKey, before.inputKey);
});

test("source event IDs and identical sessions are scoped to existing home/source identity", async (t) => {
  const { db, source, insert } = await fixture(t);
  source("/home/b/events", "home-b");
  insert({ source_event_id: "native-1" });
  insert({ source_path: "/home/b/events", home_id: "home-b", source_event_id: "native-1" });
  const before = readAchievementFacts(db, options());
  assert.equal(new Set(before.facts.map((f) => f.factKey)).size, 2);
  assert.equal(new Set(before.facts.map((f) => f.sessionKey)).size, 2);
  db.exec("UPDATE events SET total=200 WHERE home_id='home-a'");
  const after = readAchievementFacts(db, options());
  assert.deepEqual(
    after.facts.map((f) => f.factKey),
    before.facts.map((f) => f.factKey),
  );
  assert.notEqual(after.inputKey, before.inputKey);
  const changed = after.facts.find((f) => f.homeId === "home-a");
  assert.notEqual(changed.revision, before.facts.find((f) => f.homeId === "home-a").revision);
});

test("content, canonical identity, and free evidence versions invalidate the input", async (t) => {
  const { db, insert } = await fixture(t);
  insert();
  const initial = readAchievementFacts(db, options());
  const free = readAchievementFacts(
    db,
    options({ classifyFree: () => ({ freeClass: "free", freeEvidenceKey: "policy-1" }) }),
  );
  assert.equal(free.facts[0].freeClass, "free");
  assert.equal(free.facts[0].factKey, initial.facts[0].factKey);
  assert.notEqual(free.inputKey, initial.inputKey);
  assert.notEqual(
    readAchievementFacts(db, options({ stamp: { ...stamp, identityVersion: "v2" } })).inputKey,
    initial.inputKey,
  );
  assert.notEqual(
    readAchievementFacts(db, options({ identity: (event) => ({ ...identity(event), modelId: "canonical-v2" }) }))
      .inputKey,
    initial.inputKey,
  );
  assert.notEqual(readAchievementFacts(db, options({ enabledAt: T0 + 1 })).inputKey, initial.inputKey);
});

test("SQLite integers above JS safe range remain exact decimal totals", async (t) => {
  const { db, insert } = await fixture(t);
  insert({ total: 9007199254740993n });
  assert.equal(readAchievementFacts(db, options()).facts[0].totalTokens, "9007199254740993");
  db.exec("UPDATE events SET total=-1");
  assert.throws(() => readAchievementFacts(db, options()), /token total/);
});

test("Hermes last_seen without matching cumulative evidence never becomes an instant", async (t) => {
  const { db, insert } = await fixture(t, "hermes");
  const row = insert({ source_event_id: "hermes:scoped" });
  const missing = readAchievementFacts(db, options());
  assert.equal(missing.facts.length, 0);
  assert.equal(missing.sourceCheckpoints.length, 0);
  assert.equal(missing.excluded.missingEvidence, 1);
  for (const mismatch of [
    { totalTokens: "99" },
    { homeId: "other-home" },
    { sourcePath: "/other" },
    { timestampMs: row.timestamp_ms + 1 },
    { sourceEventId: "other" },
  ]) {
    const invalid = hermesRead(db, row, evidence(row, mismatch));
    assert.equal(invalid.facts.length, 0);
    assert.equal(invalid.sourceCheckpoints.length, 0);
    assert.equal(invalid.excluded.invalidEvidence, 1);
  }
});

test("late cumulative discovery establishes a non-awarding watermark, then credits only proven differences", async (t) => {
  const { db, insert } = await fixture(t, "hermes");
  const row = insert({ source_event_id: "hermes:scoped", timestamp_ms: T0 + 1000 });
  const initial = hermesRead(db, row, evidence(row, { observedAt: T0 + 2000 }));
  assert.equal(initial.facts.length, 0);
  assert.equal(initial.sourceCheckpoints[0].credited, "0");
  assert.equal(initial.excluded.baseline, 1);
  row.total = 150;
  row.timestamp_ms = T0 + 4000;
  db.prepare("UPDATE events SET total=?,timestamp_ms=?").run(row.total, row.timestamp_ms);
  const next = hermesRead(db, row, evidence(row, { observedAt: T0 + 5000 }), initial);
  assert.equal(next.facts[0].totalTokens, "50");
  assert.equal(next.facts[0].precision, "interval");
  assert.deepEqual(next.facts[0].coverage, { start: T0 + 2000, end: T0 + 4000 });
  const cp = next.sourceCheckpoints[0];
  assert.equal(cp.total, "150");
  assert.equal(cp.credited, "50");
  assert.equal(cp.cutoff, T0 + 4 * DAY);
  const replay = hermesRead(db, row, evidence(row, { observedAt: T0 + 6000 }), next);
  assert.deepEqual(replay.facts, next.facts);
  assert.equal(replay.inputKey, next.inputKey);
});

test("historical Hermes credit retains the earlier ledger interval when the ledger advances before evaluation", async (t) => {
  const { db, insert } = await fixture(t, "hermes");
  const row = insert({ source_event_id: "hermes:scoped", timestamp_ms: T0 - 1000 });
  const start = T0 - DAY;
  const historicalEnd = row.timestamp_ms;
  const baseline = hermesRead(db, row, evidence(row, { start, observedAt: T0 }));
  assert.equal(baseline.sourceCheckpoints[0].credited, "0");

  row.total = 150;
  row.timestamp_ms = T0 + 1000;
  db.prepare("UPDATE events SET total=?,timestamp_ms=?").run(row.total, row.timestamp_ms);
  const history = { usageStart: 0 };
  const upgraded = hermesRead(db, row, evidence(row, { start }), baseline, history);
  assert.equal(upgraded.sourceCheckpoints[0].enabledAt, T0);
  assert.equal(upgraded.sourceCheckpoints[0].credited, "150");
  assert.deepEqual(upgraded.facts.map(({ totalTokens, coverage }) => [totalTokens, coverage]).sort(), [
    ["100", { start, end: historicalEnd }],
    ["50", { start: T0, end: row.timestamp_ms }],
  ]);
  const archivedReplay = hermesRead(db, row, undefined, upgraded, history);
  assert.deepEqual(archivedReplay.facts, upgraded.facts);
  assert.equal(archivedReplay.inputKey, upgraded.inputKey);
});

test("historical Hermes archive replay adds only the uncredited balance with known coverage", async (t) => {
  const { db, insert } = await fixture(t, "hermes");
  for (const [sourceEventId, start] of [
    ["hermes:covered", T0 - DAY],
    ["hermes:unknown", null],
  ]) {
    const row = insert({ source_event_id: sourceEventId });
    const baseline = hermesRead(db, row, evidence(row, { start, observedAt: T0 + 2000 }));
    row.total = 150;
    row.timestamp_ms = T0 + 4000;
    db.prepare("UPDATE events SET total=?,timestamp_ms=? WHERE source_event_id=?").run(
      row.total,
      row.timestamp_ms,
      sourceEventId,
    );
    const legacy = hermesRead(db, row, evidence(row, { start }), baseline);
    assert.equal(legacy.facts.length, 1);
    const [delta] = legacy.facts;
    const history = { usageStart: 0 };
    const upgraded = hermesRead(db, row, undefined, legacy, history);
    assert.deepEqual(
      upgraded.facts.find(({ factKey }) => factKey === delta.factKey),
      delta,
    );
    assert.equal(upgraded.sourceCheckpoints[0].credited, start === null ? "50" : "150");
    assert.equal(upgraded.facts.length, start === null ? 1 : 2);
    if (start !== null)
      assert.deepEqual(upgraded.facts.find(({ totalTokens }) => totalTokens === "100").coverage, {
        start,
        end: row.timestamp_ms,
      });
    assert.deepEqual(hermesRead(db, row, undefined, upgraded, history).facts, upgraded.facts);
  }
});

test("fully post-T0 cumulative coverage is counted and saved segments survive prepare/restart", async (t) => {
  const { db, insert } = await fixture(t, "hermes");
  const row = insert({ source_event_id: "hermes:scoped", timestamp_ms: T0 + 1000 });
  let result = hermesRead(db, row, evidence(row, { start: T0 }));
  const first = result.facts[0];
  assert.equal(first.totalTokens, "100");
  for (const [delta, timestampMs] of [
    [25, T0 + DAY + 1000],
    [30, T0 + 2 * DAY + 1000],
  ]) {
    row.total += delta;
    row.timestamp_ms = timestampMs;
    db.prepare("UPDATE events SET total=?,timestamp_ms=?").run(row.total, row.timestamp_ms);
    result = hermesRead(db, row, evidence(row, { start: T0 }), result);
  }
  assert.equal(result.facts.length, 3);
  assert.equal(result.sourceCheckpoints[0].credited, "155");
  assert.deepEqual(
    result.facts.find((f) => f.factKey === first.factKey),
    first,
  );
  assert.equal(
    result.facts.reduce((sum, f) => sum + BigInt(f.totalTokens), 0n),
    155n,
  );
  const crossDay = result.facts.find((f) => f.totalTokens === "25");
  assert.deepEqual(crossDay.coverage, { start: T0 + 1000, end: T0 + DAY + 1000 });
  const persisted = JSON.parse(JSON.stringify(result));
  const replay = hermesRead(db, row, evidence(row, { start: T0 }), persisted);
  assert.deepEqual(replay.facts, result.facts);
  assert.equal(replay.inputKey, result.inputKey);
  const archivedReplay = hermesRead(db, row, undefined, persisted);
  assert.deepEqual(archivedReplay.facts, result.facts);
  assert.equal(archivedReplay.inputKey, result.inputKey);
});

test("a pre-T0 watermark cannot prove the portion crossing T0", async (t) => {
  const { db, insert } = await fixture(t, "hermes");
  const row = insert({ source_event_id: "hermes:scoped", timestamp_ms: T0 - 1000 });
  const before = hermesRead(db, row, evidence(row));
  assert.equal(before.facts.length, 0);
  row.total = 200;
  row.timestamp_ms = T0 + 1000;
  db.prepare("UPDATE events SET total=?,timestamp_ms=?").run(row.total, row.timestamp_ms);
  const crossing = hermesRead(db, row, evidence(row), before);
  assert.equal(crossing.facts.length, 0);
  assert.equal(crossing.excluded.unprovenCoverage, 1);
  row.total = 220;
  row.timestamp_ms = T0 + 2000;
  db.prepare("UPDATE events SET total=?,timestamp_ms=?").run(row.total, row.timestamp_ms);
  assert.equal(hermesRead(db, row, evidence(row), crossing).facts[0].totalTokens, "20");
});

test("reset and same-time revisions rebase without manufacturing positive increments", async (t) => {
  const { db, insert } = await fixture(t, "hermes");
  const row = insert({ source_event_id: "hermes:scoped" });
  let current = hermesRead(db, row, evidence(row, { start: T0 }));
  for (const [total, timestampMs] of [
    [20, T0 + 2000],
    [50, T0 + 2000],
    [90, T0 + 1500],
  ]) {
    row.total = total;
    row.timestamp_ms = timestampMs;
    db.prepare("UPDATE events SET total=?,timestamp_ms=?").run(total, timestampMs);
    current = hermesRead(db, row, evidence(row), current);
    assert.equal(current.facts.length, 0);
    assert.equal(current.excluded.resetOrRevision, 1);
    assert.equal(current.sourceCheckpoints[0].credited, "0");
  }
  row.total = 100;
  row.timestamp_ms = T0 + 3000;
  db.prepare("UPDATE events SET total=?,timestamp_ms=?").run(row.total, row.timestamp_ms);
  assert.equal(hermesRead(db, row, evidence(row), current).facts[0].totalTokens, "10");
});

test("unknown coverage, cutoff and wrong checkpoints do not inflate cumulative credit", async (t) => {
  const { db, insert } = await fixture(t, "hermes");
  const row = insert({ source_event_id: "hermes:scoped" });
  const baseline = hermesRead(db, row, evidence(row, { start: null }));
  assert.equal(baseline.facts.length, 0);
  assert.equal(baseline.sourceCheckpoints[0].credited, "0");
  const boundary = hermesRead(db, row, evidence(row, { start: T0 }), null, { cutoff: row.timestamp_ms });
  assert.equal(boundary.facts.length, 0);
  assert.equal(boundary.sourceCheckpoints.length, 0);
  baseline.sourceCheckpoints[0].homeId = "other";
  assert.throws(() => hermesRead(db, row, evidence(row), baseline), /checkpoint source\/profile mismatch/);
});

test("changed cumulative coverage is a revision, not a new positive usage delta", async (t) => {
  const { db, insert } = await fixture(t, "hermes");
  const row = insert({ source_event_id: "hermes:scoped" });
  const initial = hermesRead(db, row, evidence(row, { start: T0 }));
  row.total = 200;
  row.timestamp_ms = T0 + 2000;
  db.prepare("UPDATE events SET total=?,timestamp_ms=?").run(row.total, row.timestamp_ms);
  const revised = hermesRead(db, row, evidence(row, { start: T0 + 500 }), initial);
  assert.equal(revised.facts.length, 1);
  assert.equal(revised.facts[0].totalTokens, "200");
  assert.equal(revised.excluded.resetOrRevision, 1);
  assert.equal(revised.sourceCheckpoints[0].credited, "200");
  const damaged = JSON.parse(JSON.stringify(initial));
  damaged.sourceCheckpoints[0].segments[0].totalTokens = "999";
  assert.throws(() => hermesRead(db, row, evidence(row), damaged), /credited\/segments mismatch/);
});

test("mismatched source metadata and duplicate native identities fail instead of silently merging", async (t) => {
  const { db, insert } = await fixture(t);
  insert({ source_event_id: "native-1" });
  db.exec("UPDATE source_files SET home_id='wrong-home'");
  assert.throws(() => readAchievementFacts(db, options()), /mismatched source identity/);
  db.exec("UPDATE source_files SET home_id='home-a'; DROP TRIGGER events_source_event_id_insert");
  insert({ source_event_id: "native-1" });
  assert.throws(() => readAchievementFacts(db, options()), /Duplicate achievement source event identity/);
});

test("explicit date coverage is preserved and crossing T0 is excluded rather than prorated", async (t) => {
  const { db, insert } = await fixture(t, "project-log");
  const row = insert({ source_event_id: "day-1", timestamp_ms: T0 + DAY - 1 });
  const proof = evidence(row, { start: T0, cumulative: false, precision: "day" });
  const result = hermesRead(db, row, proof);
  assert.equal(result.facts[0].precision, "day");
  assert.deepEqual(result.facts[0].coverage, proof.coverage);
  const crossing = hermesRead(db, row, { ...proof, coverage: { ...proof.coverage, start: T0 - 1 } });
  assert.equal(crossing.facts.length, 0);
  assert.equal(crossing.excluded.unprovenCoverage, 1);
});

test("reader is synchronous, query-only, leaves borrowed connection/transaction intact even on failure", async (t) => {
  const { db, insert } = await fixture(t);
  insert();
  db.exec("PRAGMA query_only=ON; BEGIN");
  const changes = db.prepare("SELECT total_changes() AS n").get().n;
  const result = readAchievementFacts(db, options());
  assert.equal(result instanceof Promise, false);
  assert.equal(db.isTransaction, true);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changes);
  assert.throws(
    () =>
      readAchievementFacts(
        db,
        options({
          identity: () => {
            throw new Error("identity failed");
          },
        }),
      ),
    /identity failed/,
  );
  assert.equal(db.isTransaction, true);
  assert.throws(
    () => readAchievementFacts(db, options({ classifyFree: () => ({ freeClass: "free", freeEvidenceKey: null }) })),
    /free evidence/,
  );
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
});

test("missing required real SQL columns fail explicitly", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE events(id INTEGER PRIMARY KEY)");
  assert.throws(() => readAchievementFacts(db, options()), /requires events\.source_path/);
});
