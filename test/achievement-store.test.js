import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { AchievementStore } from "../src/achievement-store.js";

const CATALOG = [
  { id: "A01", tiers: ["bronze", "silver", "gold"] },
  { id: "A44", tiers: ["stone"] },
];
const T0 = Date.parse("2026-11-16T23:30:00Z");
const EARNED = T0 + 100_000;
const OPTIONS = {
  enabledAt: T0,
  timeZone: "Asia/Shanghai",
  rulesVersion: "R7-production-1",
  catalogHash: "catalog-test-hash",
  profileId: "isolated-profile",
};
const ROWS = [
  { id: "A01", observedValue: "50000000000", nextTarget: "200000000000" },
  { id: "A44", observedValue: "0", nextTarget: "10" },
];
const CHECKPOINT = { kind: "hermes", key: "home/session/model", value: { baseline: "120", revision: "v1" } };

function interruptedChild(databaseFile, action) {
  const moduleUrl = pathToFileURL(path.resolve("src/achievement-store.js")).href;
  const source = `import {AchievementStore} from ${JSON.stringify(moduleUrl)};
    const store=new AchievementStore({databaseFile:${JSON.stringify(databaseFile)},catalog:${JSON.stringify(CATALOG)},
      fault:stage=>{if(stage===${JSON.stringify(action.stage)})process.exit(37)}});
    store.open(${JSON.stringify(OPTIONS)});
    ${action.commit ? `store.commitBatch(${JSON.stringify(action.commit)});` : ""}`;
  assert.throws(
    () => execFileSync(process.execPath, ["--input-type=module", "-e", source], { stdio: "pipe" }),
    (error) => error.status === 37,
  );
}

test("an older preparation cannot overwrite concurrently committed cumulative evidence", (t) => {
  const f = fixture(t);
  f.store.open(OPTIONS);
  const before = f.store.readCheckpoints();
  const other = f.create();
  other.open();
  other.saveCheckpoints([CHECKPOINT]);
  assert.throws(
    () => f.store.saveCheckpoints([{ ...CHECKPOINT, value: { baseline: "1" } }], { expected: before }),
    /Stale achievement source checkpoints/,
  );
  assert.deepEqual(f.store.readCheckpoints()[CHECKPOINT.key], CHECKPOINT.value);
});

test("interrupted initial schema is never published and the next explicit initialization recovers", (t) => {
  const f = fixture(t);
  interruptedChild(f.databaseFile, { stage: "afterSchema" });
  assert.equal(existsSync(f.databaseFile), false);
  const profile = f.store.open(OPTIONS);
  assert.equal(profile.profileId, OPTIONS.profileId);
  assert.equal(f.store.readSnapshot().state, "preparing");
});

test("process termination during a batch recovers the last committed progress and awards", (t) => {
  const f = fixture(t);
  f.store.open(OPTIONS);
  f.store.commitBatch({
    inputKey: "committed",
    evaluatedThrough: EARNED,
    rows: ROWS,
    awards: [{ id: "A01", tier: "bronze" }],
  });
  const before = f.store.readSnapshot();
  interruptedChild(f.databaseFile, {
    stage: "afterProgress",
    commit: {
      inputKey: "interrupted",
      expectedProgressRevision: 1,
      evaluatedThrough: EARNED + 1,
      rows: ROWS,
      awards: [{ id: "A01", tier: "silver" }],
    },
  });
  const recovered = f.create();
  recovered.open();
  assert.deepEqual(recovered.readSnapshot(), before);
});

function fixture(t, extra = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "achievement-store-"));
  const databaseFile = path.join(directory, "achievements.sqlite");
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = (options = {}) => {
    const store = new AchievementStore({ databaseFile, catalog: CATALOG, clock: () => EARNED, ...extra, ...options });
    stores.push(store);
    return store;
  };
  return { databaseFile, directory, create, store: create() };
}

function batch(overrides = {}) {
  return { inputKey: "input-1", evaluatedThrough: T0 + 1_000, rows: ROWS, ...overrides };
}

function inspect(databaseFile, action) {
  const database = new DatabaseSync(databaseFile);
  try {
    return action(database);
  } finally {
    database.close();
  }
}

test("constructing and reading never creates a file or implicitly initializes a profile", (t) => {
  const { store, directory } = fixture(t);
  assert.equal(store.readProfile(), null);
  assert.equal(store.readSnapshot(), null);
  assert.deepEqual(store.readCheckpoints(), {});
  assert.deepEqual(store.readEvidence("free"), []);
  assert.deepEqual(store.readOperations(), []);
  assert.throws(() => store.commitBatch(batch()), /not open/);
  assert.throws(() => store.saveCheckpoints([CHECKPOINT]), /not open/);
  assert.throws(() => store.recordOperation({}), /not open/);
  assert.throws(() => store.open(), /timeZone/);
  assert.deepEqual(readdirSync(directory), []);
});

test("only explicit :memory: is supported and a supplied catalog defines completeness", () => {
  assert.throws(() => new AchievementStore({ catalog: CATALOG }), /databaseFile/);
  for (const databaseFile of ["", " ", ":memory: ", ":temporary:"])
    assert.throws(() => new AchievementStore({ databaseFile, catalog: CATALOG }));
  for (const catalog of [[], [...CATALOG, CATALOG[0]], [{ id: "A01", tiers: ["gold"] }]])
    assert.throws(() => new AchievementStore({ databaseFile: ":memory:", catalog }));
  const store = new AchievementStore({ databaseFile: ":memory:", catalog: CATALOG });
  try {
    assert.equal(store.open(OPTIONS).schemaVersion, 2);
    assert.equal(store.readSnapshot().state, "preparing");
    assert.equal(store.readSnapshot().rows, null);
    assert.equal(store.commitBatch(batch()).rows.length, 2);
  } finally {
    store.close();
  }
});

test("invalid initialization does not touch a file, including local and unavailable calendars", (t) => {
  const { store, databaseFile } = fixture(t);
  for (const options of [
    { ...OPTIONS, enabledAt: "2026-11-16" },
    { ...OPTIONS, timeZone: "local" },
    { ...OPTIONS, timeZone: "unknown/calendar" },
    { ...OPTIONS, profileId: "" },
    { ...OPTIONS, rulesVersion: "" },
    { ...OPTIONS, catalogHash: "" },
  ])
    assert.throws(() => store.open(options));
  assert.throws(() => readFileSync(databaseFile), { code: "ENOENT" });
  assert.equal(store.open({ ...OPTIONS, timeZone: "UTC" }).timeZone, "UTC");
});

test("all six tables are STRICT and schema version is durable", (t) => {
  const { store, databaseFile } = fixture(t);
  store.open(OPTIONS);
  inspect(databaseFile, (db) => {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    const tables = db.prepare("SELECT name, strict FROM pragma_table_list WHERE name LIKE 'achievement_%'").all();
    assert.equal(tables.length, 6);
    assert.ok(tables.every((table) => table.strict === 1));
  });
});

test("batch awards share one service time, retain precision and publish notification with progress", (t) => {
  let calls = 0;
  const { store, databaseFile } = fixture(t, { clock: () => EARNED + calls++ });
  store.open(OPTIONS);
  const snapshot = store.commitBatch(
    batch({
      awards: [
        { id: "A01", tier: "bronze", qualifiedAt: "2026-11-17", precision: "day" },
        { id: "A01", tier: "silver", qualifiedAt: T0 + 1, precision: "instant" },
        { id: "A01", tier: "gold", precision: "interval" },
        { id: "A44", tier: "stone" },
      ],
      sourceCheckpoints: [CHECKPOINT],
    }),
  );
  assert.equal(calls, 1);
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.progressRevision, 1);
  assert.equal(snapshot.awardRevision, 1);
  assert.equal(snapshot.seenAwardRevision, 0);
  assert.equal(snapshot.evaluatedThrough, new Date(T0 + 1_000).toISOString());
  assert.equal(snapshot.rows[0].highestEarned, "gold");
  assert.equal(snapshot.rows[1].highestEarned, "stone");
  assert.equal(snapshot.rows[0].updatedAt, new Date(EARNED).toISOString());
  assert.deepEqual(new Set(snapshot.awards.map((award) => award.earnedAt)), new Set([new Date(EARNED).toISOString()]));
  assert.equal(snapshot.awards.find((award) => award.tier === "bronze").qualifiedAt, "2026-11-17");
  assert.equal(snapshot.awards.find((award) => award.tier === "silver").qualifiedAt, new Date(T0 + 1).toISOString());
  assert.deepEqual(store.readCheckpoints(), { [CHECKPOINT.key]: CHECKPOINT.value });
  inspect(databaseFile, (db) => {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM achievement_awards WHERE awardRevision = 1").get().n, 4);
  });
});

test("same input replay is idempotent and progress-only changes keep all award dates and revisions", (t) => {
  const { store } = fixture(t);
  store.open(OPTIONS);
  const first = store.commitBatch(batch({ awards: [{ id: "A01", tier: "bronze" }] }));
  assert.deepEqual(
    store.commitBatch(
      batch({
        rows: ROWS.map((row) => ({ ...row, observedValue: "1" })),
        awards: [{ id: "A01", tier: "gold" }],
        expectedProgressRevision: 0,
        sourceCheckpoints: [CHECKPOINT],
      }),
    ),
    first,
  );
  assert.deepEqual(store.readCheckpoints(), {});
  const second = store.commitBatch(
    batch({
      inputKey: "input-2",
      expectedProgressRevision: 1,
      rows: ROWS.map((row) => ({ ...row, observedValue: "0" })),
      awards: [{ id: "A01", tier: "bronze", qualifiedAt: T0 + 1, precision: "instant" }],
    }),
  );
  assert.equal(second.progressRevision, 2);
  assert.equal(second.awardRevision, 1);
  assert.equal(second.rows[0].highestEarned, "bronze");
  assert.equal(second.rows[0].observedValue, "0");
  assert.deepEqual(second.awards, first.awards);
});

test("a new tier increments notification once and duplicate tiers within a batch never duplicate awards", (t) => {
  let now = EARNED;
  const { store } = fixture(t, { clock: () => now });
  store.open(OPTIONS);
  store.commitBatch(batch({ awards: [{ id: "A01", tier: "bronze" }] }));
  now += 1_000;
  const silver = { id: "A01", tier: "silver" };
  const snapshot = store.commitBatch(
    batch({ inputKey: "input-2", expectedProgressRevision: 1, awards: [silver, silver] }),
  );
  assert.equal(snapshot.awards.length, 2);
  assert.equal(snapshot.awardRevision, 2);
  assert.equal(snapshot.rows[0].earnedAt.bronze, new Date(EARNED).toISOString());
  assert.equal(snapshot.rows[0].earnedAt.silver, new Date(now).toISOString());
  assert.equal(snapshot.rows[0].earnedAt.gold, null);
  assert.equal(snapshot.rows[0].updatedAt, new Date(now).toISOString());
  assert.equal(snapshot.rows[1].updatedAt, null);
  assert.equal(snapshot.rows[1].highestEarned, null);
});

test("stale and missing expected revisions cannot replace a newer completed input across connections", (t) => {
  const { store, create } = fixture(t);
  store.open(OPTIONS);
  const peer = create();
  peer.open();
  store.commitBatch(batch());
  assert.throws(() => peer.commitBatch(batch({ inputKey: "input-2" })), /Stale progress revision/);
  assert.throws(() => peer.commitBatch(batch({ inputKey: "input-2", expectedProgressRevision: 0 })), /Stale/);
  peer.commitBatch(batch({ inputKey: "input-2", expectedProgressRevision: 1 }));
  assert.throws(() => store.commitBatch(batch({ expectedProgressRevision: 1 })), /Stale/);
  assert.equal(store.readSnapshot().inputKey, "input-2");
});

test("42-row directory publication is complete, exact, and excludes sample fields", (t) => {
  const catalog = Array.from({ length: 42 }, (_, i) => ({ id: `A${i + 1}`, tiers: ["stone"] }));
  const { store, databaseFile } = fixture(t, { catalog });
  store.open(OPTIONS);
  const rows = catalog.map(({ id }) => ({
    id,
    observedValue: "90071992547409931234567890",
    nextTarget: null,
    sample: "never persist",
  }));
  assert.throws(() => store.commitBatch(batch({ rows: rows.slice(1) })), /42/);
  assert.equal(store.readSnapshot().rows, null);
  const snapshot = store.commitBatch(batch({ rows }));
  assert.equal(snapshot.rows.length, 42);
  assert.equal(snapshot.rows[0].observedValue, "90071992547409931234567890");
  assert.equal(snapshot.rows[0].sample, undefined);
  assert.equal(readFileSync(databaseFile).includes(Buffer.from("never persist")), false);
});

test("invalid rows, IDs, tiers, numbers, precision and structures fail without changing state", (t) => {
  const { store } = fixture(t);
  store.open(OPTIONS);
  const before = store.readSnapshot();
  const invalid = [
    { rows: [] },
    { rows: null },
    { rows: [ROWS[0], ROWS[0]] },
    { rows: [{ ...ROWS[0], id: "unknown" }, ROWS[1]] },
    ...[1, -1, "-1", "01", "1.5", "1e9", "NaN", "", " 1", null].map((observedValue) => ({
      rows: [{ ...ROWS[0], observedValue }, ROWS[1]],
    })),
    { rows: [{ ...ROWS[0], nextTarget: undefined }, ROWS[1]] },
    { rows: [{ ...ROWS[0], nextTarget: "1.1" }, ROWS[1]] },
    { awards: [{ id: "unknown", tier: "stone" }] },
    { awards: [{ id: "A01", tier: "stone" }] },
    { awards: [{ id: "A44", tier: "gold" }] },
    { awards: [{ id: "A01", tier: "bronze", precision: "guess" }] },
    { awards: [{ id: "A01", tier: "bronze", qualifiedAt: "2026-02-30", precision: "day" }] },
    { awards: [{ id: "A01", tier: "bronze", qualifiedAt: "2026-11-17" }] },
    { awards: null },
    { inputKey: "" },
    { evaluatedThrough: "2026-11-17" },
    { expectedProgressRevision: -1 },
    { expectedProgressRevision: "0" },
    { sourceCheckpoints: [CHECKPOINT, CHECKPOINT] },
    { sourceCheckpoints: [{ ...CHECKPOINT, value: NaN }] },
  ];
  for (const change of invalid) {
    assert.throws(() => store.commitBatch(batch(change)), JSON.stringify(change));
    assert.deepEqual(store.readSnapshot(), before);
    assert.deepEqual(store.readCheckpoints(), {});
  }
});

for (const stage of ["afterProgress", "afterAwards", "afterCheckpoints", "beforeCommit"]) {
  test(`fault at ${stage} rolls back rows, awards, notification and checkpoints together`, (t) => {
    let active = false;
    const { store, create } = fixture(t, {
      fault: (point) => {
        if (active && stage === point) throw new Error(`fault:${stage}`);
      },
    });
    store.open(OPTIONS);
    store.commitBatch(batch({ sourceCheckpoints: [CHECKPOINT] }));
    const before = store.readSnapshot();
    active = true;
    const next = batch({
      inputKey: "input-2",
      expectedProgressRevision: 1,
      rows: ROWS.map((row) => ({ ...row, observedValue: "999" })),
      awards: [{ id: "A01", tier: "bronze" }],
      sourceCheckpoints: [{ ...CHECKPOINT, value: { baseline: "999" } }],
    });
    assert.throws(() => store.commitBatch(next), /fault:/);
    assert.deepEqual(store.readSnapshot(), before);
    assert.deepEqual(store.readCheckpoints(), { [CHECKPOINT.key]: CHECKPOINT.value });
    store.close();
    const reopened = create();
    reopened.open();
    assert.deepEqual(reopened.readSnapshot(), before);
    active = false;
    assert.equal(reopened.commitBatch(next).awardRevision, 1);
  });
}

test("foundation saves T0 checkpoints atomically without publishing zero progress or changing versions", (t) => {
  let fail = false;
  const { store, create } = fixture(t, {
    fault: (stage) => {
      if (fail && stage === "afterCheckpoints") throw new Error("checkpoint fault");
    },
  });
  store.open(OPTIONS);
  const before = store.readSnapshot();
  store.saveCheckpoints([CHECKPOINT]);
  assert.deepEqual(store.readSnapshot(), before);
  assert.deepEqual(store.readCheckpoints(), { [CHECKPOINT.key]: CHECKPOINT.value });
  fail = true;
  assert.throws(
    () =>
      store.saveCheckpoints([
        { ...CHECKPOINT, value: { baseline: "999" } },
        { kind: "hermes", key: "second", value: { baseline: "3" } },
      ]),
    /checkpoint fault/,
  );
  assert.deepEqual(store.readCheckpoints(), { [CHECKPOINT.key]: CHECKPOINT.value });
  assert.throws(() => store.saveCheckpoints([CHECKPOINT, { ...CHECKPOINT, kind: "other" }]), /Duplicate/);
  store.close();
  const reopened = create();
  reopened.open();
  assert.deepEqual(reopened.readCheckpoints(), { [CHECKPOINT.key]: CHECKPOINT.value });
  assert.deepEqual(reopened.readSnapshot(), before);
  fail = false;
  reopened.saveCheckpoints([{ ...CHECKPOINT, value: { baseline: "130" } }]);
  assert.deepEqual(reopened.readCheckpoints(), { [CHECKPOINT.key]: { baseline: "130" } });
  assert.deepEqual(reopened.readSnapshot(), before);
});

test("operations deduplicate stable credentials by kind and key and preserve the original payload", (t) => {
  const { store, create, databaseFile } = fixture(t);
  store.open(OPTIONS);
  const operation = { kind: "share", key: "stable-snapshot", occurredAt: T0 + 10, payload: { digest: "content" } };
  assert.equal(store.recordOperation(operation), true);
  assert.equal(store.recordOperation({ ...operation, occurredAt: T0 + 20, payload: { digest: "changed" } }), false);
  assert.equal(store.recordOperation({ ...operation, kind: "restore" }), true);
  const expected = [
    { ...operation, occurredAt: new Date(operation.occurredAt).toISOString() },
    { ...operation, kind: "restore", occurredAt: new Date(operation.occurredAt).toISOString() },
  ];
  assert.deepEqual(store.readOperations(), expected);
  assert.equal(store.readProfile().progressRevision, 0);
  store.close();
  const reopened = create();
  reopened.open();
  assert.equal(reopened.recordOperation(operation), false);
  assert.deepEqual(reopened.readOperations(), expected);
  inspect(databaseFile, (db) => {
    const row = db.prepare("SELECT * FROM achievement_operations WHERE kind = 'share'").get();
    assert.equal(row.occurredAt, new Date(T0 + 10).toISOString());
    assert.deepEqual(JSON.parse(row.payload), operation.payload);
  });
});

test("evidence is immutable JSON, returns one fixed shape and persists free and repository identities", (t) => {
  const { store, create } = fixture(t);
  store.open(OPTIONS);
  const free = {
    kind: "free",
    key: "policy/model/v1",
    value: { freeClass: "free", validFrom: T0, source: "policy-v1" },
  };
  const repository = { kind: "repository", key: "old/path", value: { commonDirectory: "git-common-identity" } };
  assert.equal(store.putEvidence(free), true);
  assert.equal(store.putEvidence({ ...free, value: { source: "policy-v1", validFrom: T0, freeClass: "free" } }), false);
  assert.throws(() => store.putEvidence({ ...free, value: { freeClass: "paid" } }), /Immutable/);
  store.putEvidence(repository);
  assert.deepEqual(store.readEvidence("free"), [free]);
  const returned = store.readEvidence("free");
  returned[0].value.freeClass = "paid";
  assert.deepEqual(store.readEvidence("free"), [free]);
  store.close();
  const reopened = create();
  reopened.open();
  assert.deepEqual(reopened.readEvidence("free"), [free]);
  assert.deepEqual(reopened.readEvidence("repository"), [repository]);
});

test("markSeen is monotonic, rejects future revisions and preserves notifications received during display", (t) => {
  const { store } = fixture(t);
  store.open(OPTIONS);
  store.commitBatch(batch({ awards: [{ id: "A01", tier: "bronze" }] }));
  const shown = store.readSnapshot().awardRevision;
  store.commitBatch(
    batch({ inputKey: "input-2", expectedProgressRevision: 1, awards: [{ id: "A01", tier: "silver" }] }),
  );
  assert.equal(store.markSeen(shown), 1);
  assert.equal(store.markSeen(0), 1);
  assert.equal(store.markSeen(1), 1);
  assert.equal(store.readProfile().awardRevision, 2);
  for (const invalid of [3, -1, 0.5, "2", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => store.markSeen(invalid));
  assert.equal(store.readProfile().seenAwardRevision, 1);
  assert.equal(store.markSeen(2), 2);
});

test("failed independent writes leave operations, evidence, seen and derived cache unchanged", (t) => {
  let fail = false;
  const { store } = fixture(t, {
    fault: (stage) => {
      if (fail && stage === "beforeCommit") throw new Error("write fault");
    },
  });
  store.open(OPTIONS);
  store.commitBatch(batch({ awards: [{ id: "A44", tier: "stone" }] }));
  const before = store.readSnapshot();
  fail = true;
  assert.throws(
    () => store.recordOperation({ kind: "restore", key: "key", occurredAt: T0, payload: {} }),
    /write fault/,
  );
  assert.throws(() => store.putEvidence({ kind: "free", key: "key", value: {} }), /write fault/);
  assert.throws(() => store.markSeen(1), /write fault/);
  assert.throws(() => store.clearProgress(), /write fault/);
  assert.deepEqual(store.readOperations(), []);
  assert.deepEqual(store.readEvidence("free"), []);
  assert.deepEqual(store.readSnapshot(), before);
});

test("an invalid clock aborts the entire award transaction", (t) => {
  const { store } = fixture(t, { clock: () => NaN });
  store.open(OPTIONS);
  const before = store.readSnapshot();
  assert.throws(() => store.commitBatch(batch({ awards: [{ id: "A44", tier: "stone" }] })), /clock/);
  assert.deepEqual(store.readSnapshot(), before);
});

test("clearing derived progress retains T0, awards, seen, operations and evidence through reopen", (t) => {
  const { store, create, databaseFile } = fixture(t);
  const operation = { kind: "skin", key: "skin-1", occurredAt: T0 + 10, payload: { characterId: "skin-1" } };
  const evidence = { kind: "free", key: "v1", value: { freeClass: "free" } };
  store.open(OPTIONS);
  store.recordOperation(operation);
  store.putEvidence(evidence);
  store.commitBatch(batch({ awards: [{ id: "A44", tier: "stone" }], sourceCheckpoints: [CHECKPOINT] }));
  store.markSeen(1);
  const before = store.readSnapshot();
  store.clearProgress();
  const cleared = store.readSnapshot();
  assert.equal(cleared.rows, null);
  assert.equal(cleared.state, "preparing");
  assert.equal(cleared.progressRevision, 2);
  assert.deepEqual(cleared.awards, before.awards);
  assert.equal(cleared.awardRevision, 1);
  assert.equal(cleared.seenAwardRevision, 1);
  store.close();
  const reopened = create();
  reopened.open({ ...OPTIONS, enabledAt: T0 + 999_999, timeZone: "UTC", profileId: "different" });
  assert.deepEqual(reopened.readSnapshot(), cleared);
  assert.equal(reopened.readProfile().enabledAt, new Date(T0).toISOString());
  assert.equal(reopened.readProfile().timeZone, "Asia/Shanghai");
  assert.deepEqual(reopened.readEvidence("free"), [evidence]);
  assert.deepEqual(reopened.readCheckpoints(), { [CHECKPOINT.key]: CHECKPOINT.value });
  assert.equal(reopened.recordOperation(operation), false);
  assert.throws(() => reopened.commitBatch(batch({ expectedProgressRevision: 1 })), /Stale/);
  const rebuilt = reopened.commitBatch(batch({ expectedProgressRevision: 2 }));
  assert.equal(rebuilt.rows[1].highestEarned, "stone");
  assert.deepEqual(rebuilt.awards, before.awards);
  reopened.close();
  reopened.close();
  // Windows rejects removal if close left a native SQLite handle open.
  rmSync(databaseFile);
});

test("explicit v1 to v2 migration preserves the profile, dates, evidence and counters", (t) => {
  const { store, create, databaseFile } = fixture(t);
  store.open(OPTIONS);
  store.commitBatch(batch({ awards: [{ id: "A01", tier: "bronze" }] }));
  store.putEvidence({ kind: "repository", key: "root", value: { commonDirectory: "common" } });
  store.markSeen(1);
  const before = store.readSnapshot();
  store.close();
  inspect(databaseFile, (db) => db.exec("DROP TABLE achievement_source_checkpoints; PRAGMA user_version = 1"));
  const upgraded = create();
  assert.equal(upgraded.open().schemaVersion, 2);
  assert.deepEqual(upgraded.readSnapshot(), before);
  assert.deepEqual(upgraded.readCheckpoints(), {});
  assert.deepEqual(upgraded.readEvidence("repository"), [
    { kind: "repository", key: "root", value: { commonDirectory: "common" } },
  ]);
});

test("migration failure rolls back user_version and schema, releases connection and can be retried", (t) => {
  const { store, create, databaseFile } = fixture(t);
  store.open(OPTIONS);
  store.close();
  inspect(databaseFile, (db) => db.exec("DROP TABLE achievement_source_checkpoints; PRAGMA user_version = 1"));
  const failing = create({
    fault: (stage) => {
      if (stage === "afterSchema") throw new Error("migration fault");
    },
  });
  assert.throws(() => failing.open(), /migration fault/);
  assert.equal(failing.readProfile(), null);
  inspect(databaseFile, (db) => {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'achievement_source_checkpoints'").get().n,
      0,
    );
  });
  const retry = create();
  assert.equal(retry.open().profileId, OPTIONS.profileId);
});

for (const type of [
  "future",
  "corrupt bytes",
  "missing table",
  "missing profile",
  "unversioned",
  "incomplete progress",
]) {
  test(`${type} database is rejected without resetting or writing its bytes`, (t) => {
    const { store, create, databaseFile } = fixture(t);
    store.open(OPTIONS);
    store.close();
    if (type === "corrupt bytes") writeFileSync(databaseFile, "not a sqlite database");
    else
      inspect(databaseFile, (db) => {
        if (type === "future") db.exec("PRAGMA user_version = 99");
        if (type === "missing table") db.exec("DROP TABLE achievement_awards");
        if (type === "missing profile") db.exec("DELETE FROM achievement_profile");
        if (type === "unversioned") db.exec("PRAGMA user_version = 0");
        if (type === "incomplete progress")
          db.exec("UPDATE achievement_profile SET inputKey = 'broken', evaluatedThrough = '2026-11-17T00:00:00Z'");
      });
    const before = readFileSync(databaseFile);
    const rejected = create();
    assert.throws(() => rejected.open(OPTIONS));
    assert.equal(rejected.readProfile(), null);
    assert.deepEqual(readFileSync(databaseFile), before);
  });
}
