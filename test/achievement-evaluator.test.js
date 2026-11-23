import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } from "../src/achievement-catalog.js";
import { commitAchievementEvaluation, evaluateAchievements } from "../src/achievement-evaluator.js";
import { AchievementFoundation } from "../src/achievement-foundation.js";
import { AchievementStore } from "../src/achievement-store.js";
import { UsageStore } from "../src/usage-store.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const DAY = 86_400_000;
const catalogHash = createHash("sha256").update(JSON.stringify(ACHIEVEMENT_CATALOG)).digest("hex");
const profile = {
  profileId: "isolated",
  enabledAt: new Date(T0).toISOString(),
  timeZone: "UTC",
  rulesVersion: ACHIEVEMENT_RULES_VERSION,
  catalogHash,
  progressRevision: 0,
};
function fact(key = "a", total = "1000000000000", extra = {}) {
  return {
    factKey: key,
    revision: "v1",
    totalTokens: total,
    occurredAt: T0 + 1000,
    precision: "instant",
    coverage: { start: T0 + 1000, end: T0 + 1000 },
    modelId: "gpt-6-sol",
    providerId: "openai",
    harnessId: "Codex",
    repositoryKey: "git-common:repo",
    sessionKey: '["home","session"]',
    freeClass: "unknown",
    freeEvidenceKey: null,
    ...extra,
  };
}
const input = (facts = [], extra = {}) => ({
  profile,
  cutoff: T0 + DAY,
  inputKey: "input-1",
  facts,
  operations: [],
  ...extra,
});
const row = (result, id) => result.rows.find((item) => item.id === id);
function archive(t, options = {}) {
  const store = new AchievementStore({
    databaseFile: ":memory:",
    catalog: ACHIEVEMENT_CATALOG,
    clock: () => T0 + DAY + 1000,
    ...options,
  });
  store.open(profile);
  t.after(() => store.close());
  return store;
}

test("empty R7 evaluation contains exactly all 42 IDs and no awards", () => {
  const result = evaluateAchievements(input());
  assert.equal(result.rows.length, 42);
  assert.equal(new Set(result.rows.map((item) => item.id)).size, 42);
  assert.ok(result.rows.every((item) => item.observedValue === "0"));
  assert.deepEqual(result.awards, []);
});

test("T0/cutoff, exact integers, canonical replay and legal duplicate multiplicities", () => {
  const f = fact("first", "9007199254740993");
  const before = fact("before", "10000000000000", { occurredAt: T0 - 1, coverage: { start: T0 - 1, end: T0 - 1 } });
  const after = fact("cutoff", "10000000000000", {
    occurredAt: T0 + DAY,
    coverage: { start: T0 + DAY, end: T0 + DAY },
  });
  const zero = fact("zero", "0");
  const result = evaluateAchievements(input([f, f, before, after, zero, { ...f, factKey: "legitimate-second" }]));
  assert.equal(row(result, "A01").observedValue, "18014398509481986");
  assert.equal(row(result, "A31").observedValue, "2");
  assert.throws(() => evaluateAchievements(input([f, { ...f, revision: "v2" }])), /Conflicting/);
  assert.throws(() => evaluateAchievements(input([f, { ...f, totalTokens: "1" }])), /Conflicting/);
});

test("invalid input never produces a partial zero publication", (t) => {
  const store = archive(t);
  const first = commitAchievementEvaluation(store, input([fact()]));
  for (const change of [
    { facts: [fact("bad", "0.5")] },
    { facts: [fact("bad", "-1")] },
    { facts: [fact("bad", "1", { precision: "guessed" })] },
    { facts: [fact("bad", "1", { freeClass: "free" })] },
    { facts: [fact("bad", "1", { modelId: undefined })] },
    { facts: [fact("bad", "1", { coverage: { start: T0 + 2000, end: T0 + 1000 } })] },
    { operations: [{ kind: "share", key: "bad", occurredAt: "2026-01-02" }] },
    { profile: { ...profile, rulesVersion: "draft" } },
    { profile: { ...profile, catalogHash: "different-catalog" } },
    { cutoff: "2026-01-02T00:00:00Z" },
    { facts: [fact("bad", "1", { occurredAt: new Date(T0 + 1000).toISOString() })] },
  ])
    assert.throws(() => commitAchievementEvaluation(store, input([], { inputKey: "bad", ...change })));
  assert.deepEqual(store.readSnapshot(), first);
});

test("only post-T0 successful operation receipts count and crossing aggregates are never prorated", () => {
  const operations = [T0 - 1, T0, T0 + 1000, T0 + DAY].map((time, i) => ({
    kind: "share",
    key: `snapshot-${i}`,
    occurredAt: new Date(time).toISOString(),
    payload: {},
  }));
  operations.push({ ...operations[1] });
  const result = evaluateAchievements(
    input(
      [
        fact("crossing", "10000000000", {
          precision: "interval",
          coverage: { start: T0 - 1000, end: T0 + 1000 },
        }),
      ],
      { operations },
    ),
  );
  assert.equal(row(result, "A01").observedValue, "0");
  assert.equal(row(result, "A43").observedValue, "2");
});

test("a historical usage start applies to cumulative and calendar metrics while operations start at activation", () => {
  const historicalAt = T0 - DAY;
  const operations = [historicalAt, T0].map((occurredAt, index) => ({
    kind: "share",
    key: `snapshot-${index}`,
    occurredAt,
    payload: {},
  }));
  const result = evaluateAchievements(
    input(
      [
        fact("historical", "10000000", {
          occurredAt: historicalAt,
          coverage: { start: historicalAt, end: historicalAt },
        }),
      ],
      { usageStart: 0, operations },
    ),
  );
  assert.equal(row(result, "A01").observedValue, "10000000");
  assert.equal(row(result, "A13").observedValue, "1");
  assert.equal(row(result, "A43").observedValue, "1");
});

test("cross-level dates are assigned once; progress-only updates and later gold preserve prior dates", (t) => {
  let clock = T0 + DAY;
  const store = archive(t, { clock: () => clock });
  const first = commitAchievementEvaluation(store, input([fact()]));
  assert.equal(row(first, "A01").highestEarned, "silver");
  assert.equal(row(first, "A01").earnedAt.bronze, row(first, "A01").earnedAt.silver);
  assert.equal(row(first, "A01").earnedAt.gold, null);
  assert.equal(row(first, "A01").nextTarget, "5000000000000");
  clock += DAY;
  assert.deepEqual(commitAchievementEvaluation(store, input([fact()])), first);
  const progressed = commitAchievementEvaluation(
    store,
    input([fact("a", "2000000000000")], {
      profile: first,
      inputKey: "input-2",
    }),
  );
  assert.deepEqual(row(progressed, "A01").earnedAt, row(first, "A01").earnedAt);
  const gold = commitAchievementEvaluation(
    store,
    input([fact("a", "5000000000000")], {
      profile: progressed,
      inputKey: "input-3",
    }),
  );
  assert.equal(row(gold, "A01").highestEarned, "gold");
  assert.equal(row(gold, "A01").earnedAt.bronze, row(first, "A01").earnedAt.bronze);
  assert.equal(row(gold, "A01").earnedAt.gold, new Date(clock).toISOString());
  assert.equal(row(gold, "A01").nextTarget, null);
});

test("current progress may decrease while awards and their meta dependencies remain durable", (t) => {
  const store = archive(t);
  const first = commitAchievementEvaluation(store, input([fact()]));
  const lowered = commitAchievementEvaluation(store, input([], { inputKey: "input-2", profile: first }));
  assert.equal(row(lowered, "A01").observedValue, "0");
  assert.equal(row(lowered, "A01").highestEarned, "silver");
  assert.equal(row(lowered, "A01").nextTarget, "5000000000000");
  assert.equal(row(lowered, "A74").observedValue, row(first, "A74").observedValue);
  assert.deepEqual(lowered.awards, first.awards);
  store.clearProgress();
  const rebuilt = commitAchievementEvaluation(store, input([], { profile: store.readProfile(), inputKey: "input-2" }));
  assert.deepEqual(rebuilt.rows, lowered.rows);
  assert.deepEqual(rebuilt.awards, lowered.awards);
});

test("the last new gold closes all grand slams and the journey within the same atomic batch", (t) => {
  const store = archive(t);
  const initial = evaluateAchievements(input());
  const existing = ACHIEVEMENT_CATALOG.filter(
    (item) => item.id !== "A01" && !["A73", "A74", "A75", "A76"].includes(item.id),
  ).flatMap((item) => item.tiers.map((tier) => ({ id: item.id, tier })));
  const seeded = store.commitBatch({ ...initial, inputKey: "old-awards", awards: existing });
  const completed = commitAchievementEvaluation(
    store,
    input([fact("a", "5000000000000")], {
      profile: seeded,
      inputKey: "last-gold",
    }),
  );
  for (const id of ["A73", "A74", "A75"]) {
    assert.equal(row(completed, id).observedValue, "27");
    assert.equal(row(completed, id).highestEarned, "stone");
  }
  assert.equal(row(completed, "A76").observedValue, "11");
  assert.equal(row(completed, "A76").highestEarned, "stone");
  const newly = completed.awards.filter((item) => item.inputKey === "last-gold");
  assert.equal(new Set(newly.map((item) => item.earnedAt)).size, 1);
  assert.equal(completed.awardRevision, seeded.awardRevision + 1);
});

test("stale prepared input and another profile cannot overwrite a newer complete result", (t) => {
  const store = archive(t);
  const stale = input([fact()], { inputKey: "old" });
  const first = commitAchievementEvaluation(store, input([fact()]));
  assert.throws(() => commitAchievementEvaluation(store, stale), /Stale/);
  assert.throws(
    () => commitAchievementEvaluation(store, input([], { profile: { ...first, profileId: "other" } })),
    /different profile/,
  );
  assert.deepEqual(store.readSnapshot(), first);
});

test("all newly reached tiers and meta awards roll back when atomic publication fails", (t) => {
  let fail = false;
  const store = archive(t, {
    fault: (stage) => {
      if (fail && stage === "afterAwards") throw new Error("injected");
    },
  });
  const before = store.readSnapshot();
  fail = true;
  assert.throws(() => commitAchievementEvaluation(store, input([fact()])), /injected/);
  assert.deepEqual(store.readSnapshot(), before);
  fail = false;
  assert.equal(commitAchievementEvaluation(store, input([fact()])).state, "ready");
});

test("successive complete versions, late correction and full reconstruction match independent totals", () => {
  const first = fact("one", "50000000000");
  const second = fact("two", "150000000000");
  const a = evaluateAchievements(input([first]));
  assert.equal(row(a, "A01").observedValue, "50000000000");
  const b = evaluateAchievements(input([first, second]), a.awards);
  assert.equal(row(b, "A01").observedValue, "200000000000");
  const reconstructed = evaluateAchievements(input([second, first, first]));
  assert.deepEqual(b.rows, reconstructed.rows);
  const corrected = evaluateAchievements(
    input([{ ...first, totalTokens: "40000000000", revision: "v2" }, second]),
    b.awards,
  );
  assert.equal(row(corrected, "A01").observedValue, "190000000000");
  assert.equal(row(corrected, "A01").nextTarget, "5000000000000");
});

test("real S08-B SQLite facts carry canonical aliases, sources, homes and review into the evaluator", async (t) => {
  const usage = new UsageStore({ databaseFile: ":memory:" });
  await usage.open();
  t.after(() => usage.close());
  for (const home of ["home-a", "home-b"])
    usage.database
      .prepare("INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?)")
      .run(`/${home}`, "codex", home, home, `/${home}`, 0, 0, "fixture");
  const insert = (home, model, total) => {
    const values = {
      source_path: `/${home}`,
      timestamp_ms: T0 + 1000,
      session_id: "same",
      home_id: home,
      home_label: home,
      channel: "Codex",
      project: "/repo",
      model,
      hour_key: "raw",
      day_key: "raw",
      week_key: "raw",
      month_key: "raw",
      total,
      input: total,
      cached: 0,
      output: 0,
      reasoning: 0,
    };
    const keys = Object.keys(values);
    usage.database
      .prepare(`INSERT INTO events (${keys.join(",")}) VALUES (${keys.map(() => "?")})`)
      .run(...Object.values(values));
  };
  insert("home-a", "gpt-6-sol", 100_000_000);
  insert("home-a", "openai/gpt-6-sol", 100_000_000);
  insert("home-b", "gpt-6-astra", 100_000_000);
  insert("home-b", "codex-auto-review", 10_000_000_000);
  const foundation = new AchievementFoundation({ usageStore: usage, databaseFile: ":memory:", clock: () => T0 + DAY });
  t.after(() => foundation.close());
  const prepared = await foundation.prepare({
    enabledAt: T0,
    timeZone: "UTC",
    cutoff: T0 + DAY,
  });
  const result = commitAchievementEvaluation(foundation.archive, prepared);
  assert.equal(row(result, "A01").observedValue, "10300000000");
  assert.equal(row(result, "A06").observedValue, "0");
  assert.equal(row(result, "A07").observedValue, "3");
  assert.equal(row(result, "A33").observedValue, "2");
  assert.notEqual(prepared.facts[0].sessionKey, null);
  assert.equal(result.profileId, prepared.profile.profileId);
  assert.deepEqual(commitAchievementEvaluation(foundation.archive, prepared), result);
});
