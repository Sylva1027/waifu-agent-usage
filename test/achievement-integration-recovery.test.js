import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { withAchievementBackupLock } from "../src/achievement-backup.js";
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } from "../src/achievement-catalog.js";
import { achievementDatabaseFile } from "../src/achievement-foundation.js";
import { AchievementOperationService } from "../src/achievement-operations.js";
import { AchievementRuntime } from "../src/achievement-runtime.js";
import { AchievementStore } from "../src/achievement-store.js";
import { createHistoryBackup, restoreHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";
import { UsageStore } from "../src/usage-store.js";
import { observed, runtimeFixture, T0 } from "./fixtures/achievement-runtime-fixture.js";

const activeSkins = ["chatgpt", "claude", "glm", "gemini", "deepseek", "kimi", "qwen", "grok"];
const retiredSkins = ["muse", "mimo"];
const storyWithoutSkin = ["A31", "A33", "A36", "A38", "A39", "A43", "A46", "A73", "A74", "A75"];

function seedOldProfile(f, skins, awarded) {
  const archive = new AchievementStore({
    databaseFile: f.options.databaseFile,
    catalog: ACHIEVEMENT_CATALOG,
    clock: () => T0 + 50,
  });
  try {
    archive.open({
      enabledAt: T0,
      timeZone: "Asia/Shanghai",
      rulesVersion: "R7-production-1",
      catalogHash: "75e83543b974ff9245c0222a01ffab5a50e4c9cb6276054a12ed16518ea30b4c",
    });
    for (const characterId of skins)
      archive.recordOperation({ kind: "skin", key: characterId, occurredAt: T0 + 10, payload: { characterId } });
    archive.recordOperation({ kind: "share", key: "historical-share", occurredAt: T0 + 10, payload: {} });
    archive.putEvidence({ kind: "free", key: "historical-price", value: { free: true } });
    archive.commitBatch({
      inputKey: "achievement-history-v1:before-skin-retirement",
      evaluatedThrough: T0 + 50,
      rows: ACHIEVEMENT_CATALOG.map(({ id, thresholds }) => ({
        id,
        observedValue: id === "A44" ? String(skins.length) : "0",
        nextTarget: id === "A44" ? (awarded ? null : "10") : thresholds[0],
      })),
      awards: [...storyWithoutSkin, ...(awarded ? ["A44", "A76"] : [])].map((id) => ({
        id,
        tier: id === "A43" ? "bronze" : "stone",
      })),
      sourceCheckpoints: [
        {
          kind: "hermes-cumulative",
          key: "historical-session",
          value: { total: "100", credited: "50", segments: [] },
        },
      ],
    });
    archive.markSeen(1);
    return {
      snapshot: archive.readSnapshot(),
      operations: archive.readOperations(),
      freeEvidence: archive.readEvidence("free"),
      checkpoints: archive.readCheckpoints(),
    };
  } finally {
    archive.close();
  }
}

async function restoredRuntime(f, databaseFile) {
  const usage = new UsageStore({
    homeDir: f.root,
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
    importStoreFile: path.join(f.root, "restored-imports.json"),
    databaseFile,
  });
  await usage.open();
  const options = {
    usageStore: usage,
    databaseFile: achievementDatabaseFile(databaseFile),
    clock: f.options.clock,
    timeZone: "UTC",
  };
  let runtime = new AchievementRuntime(options);
  f.cleanup.push(() => {
    runtime.close();
    usage.close();
  });
  return {
    usage,
    get runtime() {
      return runtime;
    },
    reopen() {
      runtime.close();
      runtime = new AchievementRuntime({ ...options, timeZone: "Asia/Tokyo" });
      return runtime;
    },
  };
}

function appendRestored(usage, source, at, total) {
  usage.database
    .prepare(`INSERT INTO events(source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
      hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning)
      VALUES(?,?,'session','home','fixture','Codex','restored','gpt-6-sol','h','d','w','m',?,?,0,0,0)`)
    .run(source, at, total, total);
}

test("legacy usage-only restore initializes a new profile and awards restored history", async (t) => {
  const f = await runtimeFixture(t);
  f.insert({ timestamp_ms: T0 - 100, total: 50_000_000_000, input: 50_000_000_000, output: 0 });
  assert.equal(existsSync(f.options.databaseFile), false);
  const legacy = path.join(f.root, "legacy.sqlite");
  assert.equal((await createHistoryBackup(f.store.database, legacy)).formatVersion, 1);
  const destination = path.join(f.root, "legacy-restored.sqlite");
  await restoreHistoryBackup(legacy, destination);
  assert.equal((await verifyHistoryBackup(destination)).manifest.formatVersion, 1);
  assert.equal(existsSync(achievementDatabaseFile(destination)), false);
  const restored = await restoredRuntime(f, destination);
  assert.equal(existsSync(restored.runtime.databaseFile), false, "constructing a reader does not initialize T0");
  const profile = await restored.runtime.start();
  assert.equal(profile.enabledAt, new Date(T0).toISOString());
  assert.equal(profile.state, "preparing");
  f.setNow(T0 + 100);
  const initial = await restored.runtime.update();
  assert.equal(initial.rows.length, 42);
  assert.equal(observed(initial, "A01"), "50000000000");
  const initialRow = initial.rows.find(({ id }) => id === "A01");
  assert.equal(initialRow.highestEarned, "bronze");
  assert.equal(initialRow.earnedAt.bronze, new Date(T0 + 100).toISOString());
  assert.equal(observed(initial, "A46"), "0");
  appendRestored(restored.usage, f.sourcePath, T0 + 101, 50_000_000_000);
  f.setNow(T0 + 200);
  const earned = await restored.runtime.update();
  assert.equal(observed(earned, "A01"), "100000000000");
  assert.equal(earned.rows.find(({ id }) => id === "A01").highestEarned, "bronze");
  assert.equal(earned.rows.find(({ id }) => id === "A01").earnedAt.bronze, initialRow.earnedAt.bronze);
  assert.equal(earned.profileId, profile.profileId);
  assert.equal(existsSync(f.options.databaseFile), false, "restoration does not initialize the source profile");
});

test("upgraded full profile survives backup, cache rebuild and interrupted catch-up without resetting awards or unread", async (t) => {
  const f = await runtimeFixture(t);
  await f.runtime.start();
  f.insert({ timestamp_ms: T0 + 10, total: 50_000_000_000, input: 50_000_000_000, output: 0 });
  f.insert({ timestamp_ms: T0 + 20, model: "hy4free", total: 10_000_000_000, input: 10_000_000_000, output: 0 });
  f.setNow(T0 + 100);
  const first = await f.runtime.update();
  f.runtime.archive.markSeen(first.awardRevision);
  f.setNow(T0 + 120);
  const operations = new AchievementOperationService({ archive: f.runtime.archive, clock: f.options.clock });
  assert.equal(operations.recordBrowserOperation({ kind: "skin", characterId: "chatgpt" }), true);
  f.insert({ timestamp_ms: T0 + 121, total: 200_000_000_000, input: 200_000_000_000, output: 0 });
  f.setNow(T0 + 130);
  const before = await f.runtime.update();
  assert.ok(before.awardRevision > before.seenAwardRevision);
  const savedOperations = f.runtime.archive.readOperations();
  const savedFree = f.runtime.archive.readEvidence("free-policy");
  assert.ok(savedFree.length);
  const archiveFile = f.runtime.databaseFile;
  f.runtime.close();
  let database = new DatabaseSync(archiveFile);
  database.exec("DROP TABLE achievement_source_checkpoints; PRAGMA user_version = 1");
  database.close();
  const interruptedMigration = new AchievementStore({
    databaseFile: archiveFile,
    catalog: ACHIEVEMENT_CATALOG,
    fault: (stage) => {
      if (stage === "afterSchema") throw new Error("S10 interrupted schema migration");
    },
  });
  assert.throws(() => interruptedMigration.open(), /S10 interrupted schema migration/);
  interruptedMigration.close();
  database = new DatabaseSync(archiveFile, { readOnly: true });
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
  database.close();
  const migrated = await f.reopen().start();
  assert.deepEqual(migrated, before);
  assert.equal(migrated.schemaVersion, 2);
  const backup = path.join(f.root, "complete.sqlite");
  const manifest = await withAchievementBackupLock(archiveFile, () =>
    createHistoryBackup(f.store.database, backup, { achievementDatabaseFile: archiveFile }),
  );
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.achievements.profileId, before.profileId);
  f.insert({ timestamp_ms: T0 + 150, total: 5_000_000_000_000, input: 5_000_000_000_000, output: 0 });
  f.setNow(T0 + 200);
  const newerSource = await f.runtime.update();
  assert.equal(newerSource.rows.find(({ id }) => id === "A01").highestEarned, "gold");
  const destination = path.join(f.root, "complete-restored.sqlite");
  const restoredArchive = achievementDatabaseFile(destination);
  await restoreHistoryBackup(backup, destination, undefined, { achievementDatabaseFile: restoredArchive });
  const restored = await restoredRuntime(f, destination);
  assert.deepEqual(await restored.runtime.start(), before, "full restore uses the backup's completed version");
  assert.deepEqual(restored.runtime.archive.readOperations(), savedOperations);
  assert.deepEqual(restored.runtime.archive.readEvidence("free-policy"), savedFree);
  assert.equal(
    restored.runtime.archive.readOperations().some(({ kind }) => kind === "restore"),
    false,
  );
  await restored.usage.rebuildHistoryRollups();
  restored.runtime.archive.clearProgress();
  const cleared = restored.runtime.readSnapshot();
  assert.equal(cleared.state, "preparing");
  assert.equal(cleared.rows, null);
  assert.deepEqual(cleared.awards, before.awards);
  assert.equal(cleared.seenAwardRevision, before.seenAwardRevision);
  f.setNow(T0 + 300);
  await restored.reopen().start();
  const rebuilt = await restored.runtime.update();
  assert.deepEqual(rebuilt.rows, before.rows);
  assert.deepEqual(rebuilt.awards, before.awards);
  assert.equal(rebuilt.profileId, before.profileId);
  assert.equal(rebuilt.enabledAt, before.enabledAt);
  assert.equal(rebuilt.timeZone, before.timeZone, "reopen settings cannot replace the profile's fixed calendar");
  assert.equal(rebuilt.awardRevision, before.awardRevision);
  assert.equal(rebuilt.seenAwardRevision, before.seenAwardRevision);
  appendRestored(restored.usage, f.sourcePath, T0 + 301, 5_000_000_000_000);
  f.setNow(T0 + 400);
  const commit = restored.runtime.archive.commitBatch;
  restored.runtime.archive.commitBatch = () => {
    throw new Error("S10 interrupted restored-profile publication");
  };
  await assert.rejects(restored.runtime.update(), /S10 interrupted restored-profile publication/);
  assert.deepEqual(restored.runtime.readSnapshot(), rebuilt);
  restored.runtime.archive.commitBatch = commit;
  await restored.reopen().start();
  const recovered = await restored.runtime.update();
  const originalRow = before.rows.find(({ id }) => id === "A01");
  const recoveredRow = recovered.rows.find(({ id }) => id === "A01");
  assert.equal(recoveredRow.highestEarned, "gold");
  assert.equal(recoveredRow.earnedAt.bronze, originalRow.earnedAt.bronze);
  assert.equal(recoveredRow.earnedAt.silver, originalRow.earnedAt.silver);
  assert.equal(recoveredRow.earnedAt.gold, new Date(T0 + 400).toISOString());
  assert.equal(recovered.awardRevision, before.awardRevision + 1);
  assert.equal(recovered.seenAwardRevision, before.seenAwardRevision);
  assert.deepEqual(await restored.runtime.update(), recovered, "replaying the completed input is idempotent");
  assert.deepEqual(f.runtime.readSnapshot(), newerSource, "restoring a backup never replaces the live source profile");
});

test("an old backup uses the current eight skins on first live settlement and can be exported again", async (t) => {
  const f = await runtimeFixture(t);
  const before = seedOldProfile(f, [...activeSkins.slice(0, 6), ...retiredSkins], false);
  const backupFile = path.join(f.root, "old-rules.sqlite");
  const manifest = await createHistoryBackup(f.store.database, backupFile, {
    achievementDatabaseFile: f.options.databaseFile,
  });
  const sidecar = path.join(f.root, manifest.achievements.filename);
  const originalBytes = readFileSync(sidecar);
  const destination = path.join(f.root, "old-rules-restored.sqlite");
  const restoredArchive = achievementDatabaseFile(destination);
  const result = await restoreHistoryBackup(backupFile, destination, undefined, {
    achievementDatabaseFile: restoredArchive,
  });
  assert.equal(result.profile.profileId, before.snapshot.profileId);
  assert.deepEqual(readFileSync(restoredArchive), originalBytes);
  const restored = await restoredRuntime(f, destination);
  assert.deepEqual(await restored.runtime.start(), before.snapshot);
  f.setNow(T0 + 100);
  const updated = await restored.runtime.update();
  assert.equal(updated.rulesVersion, ACHIEVEMENT_RULES_VERSION);
  assert.equal(observed(updated, "A44"), "6");
  assert.equal(updated.rows.find(({ id }) => id === "A44").nextTarget, "8");
  assert.equal(observed(updated, "A76"), "10");
  assert.equal(updated.profileId, before.snapshot.profileId);
  assert.equal(updated.enabledAt, before.snapshot.enabledAt);
  assert.equal(updated.timeZone, before.snapshot.timeZone);
  assert.deepEqual(updated.awards, before.snapshot.awards);
  assert.equal(updated.seenAwardRevision, before.snapshot.seenAwardRevision);
  assert.deepEqual(restored.runtime.archive.readOperations(), before.operations);
  assert.deepEqual(restored.runtime.archive.readEvidence("free"), before.freeEvidence);
  assert.deepEqual(restored.runtime.archive.readCheckpoints(), before.checkpoints);
  assert.deepEqual(readFileSync(sidecar), originalBytes, "migration leaves the original backup untouched");
  const newBackup = path.join(f.root, "new-rules.sqlite");
  await createHistoryBackup(restored.usage.database, newBackup, { achievementDatabaseFile: restoredArchive });
  assert.equal((await verifyHistoryBackup(newBackup)).manifest.achievements.inputKey, updated.inputKey);
});

test("all eight active skins qualify after interrupted migration, while old awards keep their original dates", async (t) => {
  for (const awarded of [false, true]) {
    await t.test(awarded ? "awarded under the old rules" : "newly qualified", async (t) => {
      const f = await runtimeFixture(t);
      const before = seedOldProfile(f, awarded ? [...activeSkins, ...retiredSkins] : activeSkins, awarded);
      await f.runtime.start();
      assert.equal(f.runtime.needsHistoryBackfill, false);
      f.setNow(T0 + 100);
      const commit = f.runtime.archive.commitBatch;
      f.runtime.archive.commitBatch = () => {
        throw new Error("interrupted rules publication");
      };
      await assert.rejects(f.runtime.update(), /interrupted rules publication/);
      assert.deepEqual(f.runtime.readSnapshot(), before.snapshot);
      f.runtime.archive.commitBatch = commit;
      await f.reopen().start();
      const updated = await f.runtime.update();
      assert.equal(updated.rulesVersion, ACHIEVEMENT_RULES_VERSION);
      assert.equal(observed(updated, "A44"), "8");
      assert.equal(observed(updated, "A76"), "11");
      for (const id of ["A44", "A76"]) {
        const row = updated.rows.find((item) => item.id === id);
        assert.equal(row.highestEarned, "stone");
        assert.equal(row.earnedAt.stone, new Date(T0 + (awarded ? 50 : 100)).toISOString());
      }
      assert.equal(updated.seenAwardRevision, 1);
      assert.equal(updated.awardRevision, awarded ? 1 : 2);
      assert.deepEqual(await f.runtime.update(), updated);
    });
  }
});
