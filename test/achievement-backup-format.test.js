import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } from "../src/achievement-catalog.js";
import {
  ACHIEVEMENT_FORMAT_CATALOG,
  ACHIEVEMENT_FORMAT_CATALOG_HASH,
  ACHIEVEMENT_FORMAT_RULES_VERSION,
} from "../src/achievement-format-descriptor.js";
import {
  inspectAchievementDatabase,
  validateAchievementBackupRecord,
  verifyAchievementBackup,
} from "../src/achievement-backup-format.js";
import {
  validateAchievementBackupRecord as legacyValidateRecord,
  verifyAchievementBackup as legacyVerify,
} from "../src/achievement-backup.js";
import { AchievementStore } from "../src/achievement-store.js";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";

const T0 = Date.parse("2026-11-16T23:30:00Z");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const OLD_RULES = "R7-production-1";
const OLD_HASH = "75e83543b974ff9245c0222a01ffab5a50e4c9cb6276054a12ed16518ea30b4c";

function fixture(t, { version = 2, state = "ready" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "achievement-backup-format-"));
  const file = path.join(root, "profile.sqlite");
  const store = new AchievementStore({ databaseFile: file, catalog: ACHIEVEMENT_CATALOG, clock: () => T0 + 100 });
  t.after(() => {
    store.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("achievement-backup-format-"));
    rmSync(root, { recursive: true, force: true });
  });
  store.open({
    enabledAt: T0,
    timeZone: "Asia/Shanghai",
    profileId: "format-only-profile",
    rulesVersion: ACHIEVEMENT_RULES_VERSION,
    catalogHash: hash(JSON.stringify(ACHIEVEMENT_CATALOG)),
  });
  if (state !== "preparing") {
    store.commitBatch({
      inputKey: "input-1",
      evaluatedThrough: T0 + 50,
      rows: ACHIEVEMENT_CATALOG.map(({ id }) => ({ id, observedValue: "9007199254740993", nextTarget: "1" })),
      awards: [
        { id: "A01", tier: "bronze", precision: "day", qualifiedAt: "2026-11-17" },
        { id: "A01", tier: "silver", precision: "instant", qualifiedAt: T0 + 5 },
        { id: "A31", tier: "stone", precision: "interval", qualifiedAt: T0 + 10 },
      ],
      sourceCheckpoints: [{ kind: "hermes", key: "home/session", value: { baseline: "123" } }],
    });
    store.markSeen(1);
    if (state === "cleared") store.clearProgress();
  }
  store.recordOperation({ kind: "share", key: "receipt", occurredAt: T0 + 100, payload: { evidence: "original" } });
  store.putEvidence({ kind: "free", key: "policy/model", value: { source: "original" } });
  const original = store.readSnapshot();
  store.close();
  const mutate = (work) => {
    const db = new DatabaseSync(file);
    try {
      work(db);
    } finally {
      db.close();
    }
  };
  if (version === 1) mutate((db) => db.exec("DROP TABLE achievement_source_checkpoints; PRAGMA user_version = 1"));
  const record = () => {
    const bytes = readFileSync(file);
    return {
      filename: path.basename(file),
      bytes: bytes.length,
      sha256: hash(bytes),
      schemaVersion: version,
      profileId: original.profileId,
      enabledAt: original.enabledAt,
      timeZone: original.timeZone,
      inputKey: original.inputKey,
    };
  };
  return { root, file, mutate, record, original };
}

async function failure(work) {
  try {
    await work();
  } catch (error) {
    return { name: error.name, message: error.message, code: error.code };
  }
  assert.fail("invalid input was accepted");
}

test("small format descriptor matches every production ID/tier, rule version and full catalog digest", () => {
  assert.deepEqual(
    ACHIEVEMENT_FORMAT_CATALOG,
    ACHIEVEMENT_CATALOG.map(({ id, tiers }) => ({ id, tiers })),
  );
  assert.equal(ACHIEVEMENT_FORMAT_CATALOG.length, 42);
  assert.equal(
    ACHIEVEMENT_FORMAT_CATALOG.reduce((sum, row) => sum + row.tiers.length, 0),
    96,
  );
  assert.equal(ACHIEVEMENT_FORMAT_RULES_VERSION, ACHIEVEMENT_RULES_VERSION);
  assert.equal(ACHIEVEMENT_FORMAT_CATALOG_HASH, hash(JSON.stringify(ACHIEVEMENT_CATALOG)));
  assert.ok(ACHIEVEMENT_FORMAT_CATALOG.every((row) => Object.keys(row).join(" ") === "id tiers"));
});

for (const version of [1, 2]) {
  test(`skin-retirement upgrade continues to verify the exact old rules pair in schema ${version}`, async (t) => {
    const f = fixture(t, { version });
    f.mutate((db) =>
      db.prepare("UPDATE achievement_profile SET rulesVersion = ?, catalogHash = ?").run(OLD_RULES, OLD_HASH),
    );
    const bytes = readFileSync(f.file);
    const record = f.record();
    assert.deepEqual(await verifyAchievementBackup(f.root, record), await legacyVerify(f.root, record));
    assert.deepEqual(readFileSync(f.file), bytes);
  });

  for (const state of ["preparing", "ready", "cleared"]) {
    test(`schema ${version} ${state} validates without changing identity, dates, evidence, schema or bytes`, async (t) => {
      const f = fixture(t, { version, state });
      const bytes = readFileSync(f.file);
      const files = readdirSync(f.root);
      const record = f.record();
      assert.deepEqual(await verifyAchievementBackup(f.root, record), await legacyVerify(f.root, record));
      const db = new DatabaseSync(f.file, { readOnly: true });
      try {
        db.exec("BEGIN");
        const profile = inspectAchievementDatabase(db);
        assert.deepEqual(profile, AchievementStore.inspect(db, ACHIEVEMENT_CATALOG));
        assert.equal(profile.schemaVersion, version);
        for (const key of [
          "profileId",
          "enabledAt",
          "timeZone",
          "progressRevision",
          "awardRevision",
          "seenAwardRevision",
        ])
          assert.equal(profile[key], f.original[key]);
        assert.equal(db.isOpen, true);
        assert.equal(db.isTransaction, true);
        assert.deepEqual(
          db
            .prepare("SELECT * FROM achievement_awards ORDER BY id, awardRevision, tier")
            .all()
            .map((row) => ({ ...row })),
          f.original.awards,
        );
        assert.equal(db.prepare("SELECT payload FROM achievement_operations").get().payload, '{"evidence":"original"}');
        assert.equal(db.prepare("SELECT value FROM achievement_free_evidence").get().value, '{"source":"original"}');
      } finally {
        db.close();
      }
      assert.deepEqual(readdirSync(f.root), files);
      assert.deepEqual(readFileSync(f.file), bytes);
    });
  }
}

const invalidState = [
  ["unversioned", "PRAGMA user_version = 0", /Unsupported achievement schema/],
  ["future schema", "PRAGMA user_version = 99", /Unsupported achievement schema/],
  ["missing table", "DROP TABLE achievement_awards", /Missing achievement table/],
  ["extra column", "ALTER TABLE achievement_progress ADD COLUMN extra TEXT", /Invalid achievement schema/],
  [
    "non-strict table",
    "ALTER TABLE achievement_free_evidence RENAME TO old; CREATE TABLE achievement_free_evidence (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,key)); DROP TABLE old",
    /Invalid achievement schema/,
  ],
  [
    "wrong primary key",
    "ALTER TABLE achievement_source_checkpoints RENAME TO old; CREATE TABLE achievement_source_checkpoints (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,key)) STRICT; DROP TABLE old",
    /Invalid achievement schema/,
  ],
  ["missing profile", "DELETE FROM achievement_profile", /Invalid achievement profile/],
  ["empty profile identity", "UPDATE achievement_profile SET profileId = ''", /profileId/],
  ["floating T0", "UPDATE achievement_profile SET enabledAt = '2026-11-16T23:30:00'", /UTC offset/],
  ["negative T0", "UPDATE achievement_profile SET enabledAt = '1960-01-01T00:00:00Z'", /UTC timestamp/],
  ["local timezone", "UPDATE achievement_profile SET timeZone = 'local'", /stored timeZone/],
  ["invalid timezone", "UPDATE achievement_profile SET timeZone = 'Invalid/Zone'", /time zone/i],
  ["empty rules", "UPDATE achievement_profile SET rulesVersion = ''", /rulesVersion/],
  ["unsupported rules", "UPDATE achievement_profile SET rulesVersion = 'future'", /rule directory/],
  [
    "mismatched old rule version and current digest",
    `UPDATE achievement_profile SET rulesVersion = '${OLD_RULES}'`,
    /rule directory/,
  ],
  [
    "mismatched current rule version and old digest",
    `UPDATE achievement_profile SET catalogHash = '${OLD_HASH}'`,
    /rule directory/,
  ],
  ["wrong catalog digest", "UPDATE achievement_profile SET catalogHash = 'forged'", /rule directory/],
  ["unsafe revision", "UPDATE achievement_profile SET progressRevision = 9007199254740992", /too large/],
  [
    "negative revision",
    "PRAGMA ignore_check_constraints = ON; UPDATE achievement_profile SET progressRevision = -1",
    /safe integer/,
  ],
  [
    "seen future revision",
    "PRAGMA ignore_check_constraints = ON; UPDATE achievement_profile SET seenAwardRevision = 2",
    /seenAwardRevision/,
  ],
  [
    "foreign key violation",
    "PRAGMA foreign_keys = OFF; CREATE TABLE extra (profile INTEGER REFERENCES achievement_profile(singleton)); INSERT INTO extra VALUES (2)",
    /Corrupt achievement sidecar/,
  ],
  ["empty input key", "UPDATE achievement_profile SET inputKey = ' '", /inputKey/],
  ["incomplete preparing state", "UPDATE achievement_profile SET inputKey = NULL", /Incomplete achievement progress/],
  ["missing evaluated date", "UPDATE achievement_profile SET evaluatedThrough = NULL", /evaluatedThrough/],
  ["missing progress ID", "DELETE FROM achievement_progress WHERE id = 'A01'", /all 42/],
  ["unknown progress ID", "UPDATE achievement_progress SET id = 'unknown' WHERE id = 'A01'", /Unknown or duplicate/],
  ["negative progress", "UPDATE achievement_progress SET observedValue = '-1' WHERE id = 'A01'", /observedValue/],
  ["noncanonical target", "UPDATE achievement_progress SET nextTarget = '01' WHERE id = 'A01'", /nextTarget/],
  ["unknown award ID", "UPDATE achievement_awards SET id = 'unknown' WHERE id = 'A31'", /ID or tier/],
  [
    "wrong award tier",
    "UPDATE achievement_awards SET tier = 'stone' WHERE id = 'A01' AND tier = 'bronze'",
    /ID or tier/,
  ],
  ["floating earned date", "UPDATE achievement_awards SET earnedAt = '2026-11-17T00:00:00'", /UTC offset/],
  [
    "invalid calendar date",
    "UPDATE achievement_awards SET qualifiedAt = '2026-02-30' WHERE precision = 'day'",
    /calendar date/,
  ],
  [
    "floating qualified date",
    "UPDATE achievement_awards SET qualifiedAt = '2026-11-17T00:00:00' WHERE precision = 'instant'",
    /UTC offset/,
  ],
  ["invalid precision", "UPDATE achievement_awards SET precision = 'month'", /award precision/],
  ["zero award revision", "UPDATE achievement_awards SET awardRevision = 0", /Invalid award revision/],
  ["future award revision", "UPDATE achievement_awards SET awardRevision = 2", /Invalid award revision/],
];

for (const [name, sql, message] of invalidState) {
  test(`checksum-correct ${name} fails with the existing error contract and leaves bytes unchanged`, async (t) => {
    const f = fixture(t);
    f.mutate((db) => db.exec(sql));
    const bytes = readFileSync(f.file);
    const files = readdirSync(f.root);
    const record = f.record();
    const actual = await failure(() => verifyAchievementBackup(f.root, record));
    assert.match(actual.message, message);
    assert.deepEqual(actual, await failure(() => legacyVerify(f.root, record)));
    assert.deepEqual(readFileSync(f.file), bytes);
    assert.deepEqual(readdirSync(f.root), files);
  });
}

test("manifest validation retains filename, hash, byte count, profile and fixed calendar errors", async (t) => {
  const f = fixture(t);
  for (const change of [
    ...[
      "../outside.sqlite",
      "C:\\outside.sqlite",
      "sub/file",
      "file:stream",
      ".",
      "..",
      "file.",
      "file ",
      "bad\u0000",
    ].map((filename) => ({ filename })),
    { bytes: 0 },
    { bytes: 1.5 },
    { sha256: "0" },
    { sha256: "A".repeat(64) },
    { schemaVersion: 3 },
    { profileId: " " },
    { enabledAt: "2026-11-17T00:00:00Z" },
    { timeZone: "local" },
    { timeZone: "Invalid/Zone" },
    { inputKey: undefined },
  ]) {
    const record = { ...f.record(), ...change };
    const actual = await failure(() => validateAchievementBackupRecord(record));
    assert.equal(actual.code, "ACHIEVEMENT_BACKUP_INVALID");
    assert.deepEqual(actual, await failure(() => legacyValidateRecord(record)));
  }
  for (const change of [{ profileId: "forged" }, { inputKey: "forged" }, { bytes: 1 }, { sha256: "0".repeat(64) }]) {
    const record = { ...f.record(), ...change };
    assert.deepEqual(
      await failure(() => verifyAchievementBackup(f.root, record)),
      await failure(() => legacyVerify(f.root, record)),
    );
  }
});

test("missing, non-file, corrupt and journal-dependent sidecars fail without creating a profile", async (t) => {
  const f = fixture(t);
  const record = f.record();
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    writeFileSync(`${f.file}${suffix}`, "external journal");
    await assert.rejects(verifyAchievementBackup(f.root, record), { code: "ACHIEVEMENT_BACKUP_INVALID" });
    rmSync(`${f.file}${suffix}`);
  }
  f.mutate((db) => db.exec("PRAGMA journal_mode = WAL"));
  await assert.rejects(verifyAchievementBackup(f.root, f.record()), /standalone SQLite backup/);
  writeFileSync(f.file, "not a SQLite database");
  assert.deepEqual(
    await failure(() => verifyAchievementBackup(f.root, f.record())),
    await failure(() => legacyVerify(f.root, f.record())),
  );
  rmSync(f.file);
  await assert.rejects(verifyAchievementBackup(f.root, record), { code: "ENOENT" });
  assert.equal(existsSync(f.file), false);
  await fs.mkdir(f.file);
  await assert.rejects(verifyAchievementBackup(f.root, record), /adjacent regular file/);
  rmSync(f.file, { recursive: true });
  assert.deepEqual(readdirSync(f.root), []);
});

test("post-inspection digest detects a file changed after the initial hash", async (t) => {
  const f = fixture(t);
  const record = f.record();
  const originalOpen = fs.open;
  let reads = 0;
  fs.open = async (file, ...args) => {
    if (file === f.file && ++reads === 2) {
      const bytes = readFileSync(f.file);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(f.file, bytes);
    }
    return originalOpen(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(verifyAchievementBackup(f.root, record), {
      code: "ACHIEVEMENT_BACKUP_INVALID",
      message: "Achievement sidecar changed during verification",
    });
    assert.equal(reads, 2);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("real read-only verification loads no Store, runtime, evaluator, complete catalog or pricing", async (t) => {
  const f = fixture(t, { version: 1 });
  const bytes = readFileSync(f.file);
  const probe = createLiteBoundaryProbe(f.root, {
    forbiddenModules: [
      "src/achievement-store.js",
      "src/achievement-backup.js",
      "src/achievement-runtime.js",
      "src/achievement-foundation.js",
      "src/achievement-evaluator.js",
      "src/achievement-catalog.js",
      "src/pricing.js",
      "src/usage-store.js",
      "public/pricing-models.js",
    ],
  });
  const entry = new URL("../src/achievement-backup-format.js", import.meta.url).href;
  const source = `const {verifyAchievementBackup}=await import(${JSON.stringify(entry)});
    const result=await verifyAchievementBackup(${JSON.stringify(f.root)},${JSON.stringify(f.record())});
    process.stdout.write(JSON.stringify(result));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    env: probe.env,
    windowsHide: true,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(output).profile.schemaVersion, 1);
  const loads = probe.read().filter((entry) => entry.kind === "load");
  assert.ok(
    loads.some((entry) => entry.url === new URL("../src/achievement-format-descriptor.js", import.meta.url).href),
  );
  assert.equal(
    loads.some((entry) => entry.forbidden),
    false,
  );
  assert.deepEqual(readFileSync(f.file), bytes);
  assert.equal(existsSync(path.join(f.root, "achievements.sqlite")), false);
});
