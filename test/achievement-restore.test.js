import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } from "../src/achievement-catalog.js";
import { evaluateAchievements } from "../src/achievement-evaluator.js";
import { runAchievementRestore } from "../src/achievement-restore.js";
import { AchievementStore } from "../src/achievement-store.js";
import { createHistoryBackup, restoreHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";
import { UsageStore } from "../src/usage-store.js";

const exec = promisify(execFile);
const T0 = Date.parse("2026-11-01T00:00:00Z");
const hash = (text) => createHash("sha256").update(text).digest("hex");
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "achievement-restore-"));
  const directory = path.join(home, ".codex-usage");
  await mkdir(directory);
  const databaseFile = path.join(directory, "usage-index.sqlite");
  const archiveFile = path.join(directory, "achievements.sqlite");
  const usage = new UsageStore({ homeDir: home, databaseFile, env: {}, automaticDiscoveryEnabled: false });
  await usage.open();
  const archive = new AchievementStore({
    databaseFile: archiveFile,
    catalog: ACHIEVEMENT_CATALOG,
    clock: () => T0 + 1000,
  });
  const profile = archive.open({
    enabledAt: T0,
    timeZone: "Asia/Shanghai",
    rulesVersion: ACHIEVEMENT_RULES_VERSION,
    catalogHash: hash(JSON.stringify(ACHIEVEMENT_CATALOG)),
  });
  archive.commitBatch(
    evaluateAchievements({ profile, cutoff: T0 + 1000, inputKey: "initial", facts: [], operations: [] }),
  );
  const original = archive.readSnapshot();
  archive.close();
  t.after(async () => {
    archive.close();
    usage.close();
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith("achievement-restore-"));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const packageFile = path.join(home, "backup.sqlite");
  const manifest = await createHistoryBackup(usage.database, packageFile, { achievementDatabaseFile: archiveFile });
  const packageDigest = hash(JSON.stringify(manifest));
  const target = path.join(home, "restored.sqlite");
  const restore = () => restoreHistoryBackup(packageFile, target);
  const verifyCompleted = async () => {
    const verified = await verifyHistoryBackup(target);
    assert.equal(verified.manifest.database.sha256, manifest.database.sha256);
  };
  const inspect = () => {
    archive.open();
    const value = { snapshot: archive.readSnapshot(), operations: archive.readOperations() };
    archive.close();
    return value;
  };
  return {
    home,
    usage,
    archiveFile,
    packageFile,
    target,
    manifest,
    original,
    inspect,
    run: (extra) => runAchievementRestore({ archiveFile, packageDigest, target, restore, verifyCompleted, ...extra }),
  };
}

test("verified restore records only in the initiating existing profile and retries without restoring again", async (t) => {
  const f = await fixture(t);
  const first = await f.run();
  assert.equal(first.replayed, false);
  assert.ok(existsSync(f.target));
  assert.equal(f.inspect().operations.filter((op) => op.kind === "restore").length, 1);
  const second = await f.run({ restore: () => assert.fail("must replay the success receipt") });
  assert.equal(second.replayed, true);
  assert.equal(f.inspect().operations.filter((op) => op.kind === "restore").length, 1);
  assert.equal(f.inspect().snapshot.profileId, f.original.profileId);
  assert.equal(existsSync(`${f.target}.achievements.sqlite`), false);
});

test("interruption after package publication resumes through the saved intent and verifies the target", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      restore: async () => {
        await restoreHistoryBackup(f.packageFile, f.target);
        throw new Error("interrupted after publication");
      },
    }),
    /interrupted/,
  );
  assert.ok(existsSync(f.target));
  assert.equal(f.inspect().operations.length, 0);
  let verified = 0;
  const recovered = await f.run({
    restore: () => assert.fail("published destination must not be overwritten"),
    verifyCompleted: async () => {
      await verifyHistoryBackup(f.target);
      verified++;
    },
  });
  assert.equal(recovered.replayed, true);
  assert.equal(verified, 1);
  assert.equal(f.inspect().operations.length, 1);
});

test("an existing unrelated target or failed restore cannot manufacture a successful operation", async (t) => {
  const f = await fixture(t);
  await writeFile(f.target, "user data");
  await assert.rejects(f.run(), { code: "EEXIST" });
  assert.equal(await readFile(f.target, "utf8"), "user data");
  await rm(f.target);
  await assert.rejects(
    f.run({
      restore: async () => {
        throw new Error("restore failed");
      },
    }),
    /restore failed/,
  );
  assert.equal(f.inspect().operations.length, 0);
});

test("a prior signed receipt cannot claim a corrupted destination is a valid restore", async (t) => {
  const f = await fixture(t);
  await f.run();
  await writeFile(f.target, "corrupted target");
  await assert.rejects(f.run());
  assert.equal(await readFile(f.target, "utf8"), "corrupted target");
  assert.equal(f.inspect().operations.length, 1);
});

test("missing profile stays absent and a completed receipt still permits a fresh copy to a removed target", async (t) => {
  const f = await fixture(t);
  const absent = path.join(f.home, "no-profile.sqlite");
  const otherTarget = path.join(f.home, "other.sqlite");
  await f.run({
    archiveFile: absent,
    target: otherTarget,
    restore: () => restoreHistoryBackup(f.packageFile, otherTarget),
  });
  assert.equal(existsSync(absent), false);
  await f.run();
  await rm(f.target);
  await assert.rejects(f.run(), { code: "HISTORY_BACKUP_DESTINATION_EXISTS" });
  await rm(path.join(path.dirname(f.target), "restored.manifest.json"));
  const copied = await f.run();
  assert.equal(copied.replayed, false);
  assert.ok(existsSync(f.target));
  assert.equal(f.inspect().operations.length, 1);
});

test("actual CLI backup and complete/usage-only restore preserve v2 metadata and source ownership", async (t) => {
  const f = await fixture(t);
  f.usage.close();
  const cli = (args) =>
    exec(process.execPath, [path.resolve("src/cli.js"), "history", ...args, "--home-dir", f.home], {
      env: { ...process.env },
      timeout: 30000,
    });
  const exported = path.join(f.home, "cli-backup.sqlite");
  await cli(["backup", path.join(f.home, ".codex-usage", "usage-index.sqlite"), exported]);
  const verified = await verifyHistoryBackup(exported);
  assert.equal(verified.manifest.formatVersion, 2);
  assert.equal(verified.manifest.achievements.profileId, f.original.profileId);
  const full = path.join(f.home, "full.sqlite");
  await cli(["restore", exported, full, "--with-achievements"]);
  assert.ok(existsSync(`${full}.achievements.sqlite`));
  const fullArchive = new AchievementStore({
    databaseFile: `${full}.achievements.sqlite`,
    catalog: ACHIEVEMENT_CATALOG,
  });
  try {
    fullArchive.open();
    assert.equal(fullArchive.readProfile().profileId, f.original.profileId);
    assert.equal(fullArchive.readOperations().length, 0);
  } finally {
    fullArchive.close();
  }
  const ordinary = path.join(f.home, "ordinary.sqlite");
  await cli(["restore", exported, ordinary]);
  assert.equal(existsSync(`${ordinary}.achievements.sqlite`), false);
  await assert.rejects(cli(["restore", exported, ordinary, "--with-achievements"]));
  assert.equal(existsSync(`${ordinary}.achievements.sqlite`), false);
  await cli(["restore", exported, ordinary]);
  assert.equal(f.inspect().operations.filter((op) => op.kind === "restore").length, 2);
  const bundle = path.join(f.home, "bundle");
  await cli(["export", path.join(f.home, ".codex-usage", "usage-index.sqlite"), bundle]);
  const bundleTarget = path.join(f.home, "full-bundle");
  await cli(["restore", bundle, bundleTarget, "--with-achievements"]);
  assert.ok(existsSync(path.join(bundleTarget, "runtime.sqlite.achievements.sqlite")));
  assert.equal(f.inspect().operations.filter((op) => op.kind === "restore").length, 3);
  await rm(path.join(bundleTarget, "runtime.sqlite.achievements.sqlite"));
  await assert.rejects(cli(["restore", bundle, bundleTarget, "--with-achievements"]));
});
