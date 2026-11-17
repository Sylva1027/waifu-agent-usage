import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { AchievementStore } from "../src/achievement-store.js";
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } from "../src/achievement-catalog.js";
import { withAchievementBackupLock } from "../src/achievement-backup.js";
import { readAchievementFacts } from "../src/achievement-facts.js";
import { createHistoryBackup, restoreHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";
import {
  createHistoryArchiveCandidate,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
  restoreHistoryArchiveBundle,
  verifyPublishedHistoryArchiveBundle,
} from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const T0 = Date.parse("2026-11-16T23:30:00Z");
const CATALOG = ACHIEVEMENT_CATALOG;
const writeJson = (file, data) => writeFileSync(file, JSON.stringify(data));

async function fixture(t, { cold = false } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "s08d-achievement-backup-"));
  const usage = new UsageStore({
    homeDir: root,
    env: {},
    importDirs: [],
    databaseFile: path.join(root, "usage.sqlite"),
  });
  const achievementDatabaseFile = path.join(root, "archive.sqlite");
  const archive = new AchievementStore({
    databaseFile: achievementDatabaseFile,
    catalog: CATALOG,
    clock: () => T0 + 100,
  });
  t.after(async () => {
    archive.close();
    usage.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await usage.open();
  const source = path.join(root, "events.jsonl");
  usage.database
    .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(source, "codex", "home", "Home", root, 1, 1, new Date(T0).toISOString());
  const insert = usage.database.prepare(
    `INSERT INTO events (source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model, hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning) VALUES (?, ?, 'session', 'home', 'Home', 'main', 'project', 'gpt-6-sol', 'hour', 'day', 'week', 'month', 20, 18, 0, 2, 0)`,
  );
  insert.run(source, T0 - 1000);
  insert.run(source, T0 + 10);
  archive.open({
    enabledAt: T0,
    timeZone: "Asia/Shanghai",
    rulesVersion: ACHIEVEMENT_RULES_VERSION,
    catalogHash: createHash("sha256").update(JSON.stringify(CATALOG)).digest("hex"),
    profileId: "same-profile",
  });
  archive.commitBatch({
    inputKey: "completed-input",
    evaluatedThrough: T0 + 50,
    rows: CATALOG.map((row) => ({
      id: row.id,
      observedValue: row.id === "A01" ? "20" : "0",
      nextTarget: row.thresholds[row.id === "A01" ? 1 : 0],
    })),
    awards: [{ id: "A01", tier: "bronze" }],
    sourceCheckpoints: [{ kind: "hermes", key: "session", value: { baseline: "5" } }],
  });
  archive.recordOperation({ kind: "share", key: "receipt", occurredAt: T0 + 100, payload: { snapshot: "content" } });
  archive.putEvidence({ kind: "free", key: "policy", value: { free: true } });
  archive.markSeen(1);
  if (cold) {
    const candidate = path.join(root, "cold.sqlite");
    await createHistoryArchiveCandidate(usage.database, candidate, { startMs: T0 - 2000, endMs: T0 });
    await usage.registerHistoryArchiveCandidate(candidate);
  }
  return { root, usage, archive, achievementDatabaseFile };
}

function assertProfile(file, original) {
  const restored = new AchievementStore({ databaseFile: file, catalog: CATALOG });
  try {
    restored.open();
    assert.deepEqual(restored.readSnapshot(), original.readSnapshot());
    assert.deepEqual(restored.readOperations(), original.readOperations());
    assert.deepEqual(restored.readEvidence("free"), original.readEvidence("free"));
    assert.deepEqual(restored.readCheckpoints(), original.readCheckpoints());
    assert.equal(
      restored.readOperations().some((row) => row.kind === "restore"),
      false,
    );
  } finally {
    restored.close();
  }
}

test("single v2 preserves the full WAL profile; ordinary restore only carries usage and v1 stays supported", async (t) => {
  const f = await fixture(t);
  const wal = new DatabaseSync(f.achievementDatabaseFile);
  wal.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  f.archive.recordOperation({
    kind: "skin",
    key: "wal-only",
    occurredAt: T0 + 101,
    payload: { characterId: "character" },
  });
  const file = path.join(f.root, "package.sqlite");
  let manifest;
  try {
    manifest = await createHistoryBackup(f.usage.database, file, {
      achievementDatabaseFile: f.achievementDatabaseFile,
    });
  } finally {
    wal.close();
  }
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.achievements.inputKey, "completed-input");
  assert.equal(manifest.achievements.enabledAt, new Date(T0).toISOString());
  assert.equal((await verifyHistoryBackup(file)).ok, true);
  const restoredFile = path.join(f.root, "restored.sqlite");
  const achievementFile = path.join(f.root, "restored-achievements.sqlite");
  const result = await restoreHistoryBackup(file, restoredFile, undefined, {
    achievementDatabaseFile: achievementFile,
  });
  assert.equal(result.profile.profileId, "same-profile");
  assert.equal(result.achievementDatabaseFile, achievementFile);
  assertProfile(achievementFile, f.archive);
  await verifyHistoryBackup(restoredFile);
  const ordinary = path.join(f.root, "ordinary.sqlite");
  await restoreHistoryBackup(file, ordinary);
  const ordinaryManifest = (await verifyHistoryBackup(ordinary)).manifest;
  assert.equal(ordinaryManifest.formatVersion, 1);
  assert.equal(Object.hasOwn(ordinaryManifest, "achievements"), false);
  assert.equal(existsSync(`${ordinary}.achievements.sqlite`), false);
  assert.equal(f.archive.readProfile().enabledAt, new Date(T0).toISOString());
  const legacy = path.join(f.root, "legacy.sqlite");
  assert.equal((await createHistoryBackup(f.usage.database, legacy)).formatVersion, 1);
  await restoreHistoryBackup(legacy, path.join(f.root, "legacy-restored.sqlite"));
  await assert.rejects(
    restoreHistoryBackup(legacy, path.join(f.root, "bad-full.sqlite"), undefined, {
      achievementDatabaseFile: path.join(f.root, "bad-full-achievements.sqlite"),
    }),
    { code: "HISTORY_BACKUP_NO_ACHIEVEMENTS" },
  );
});

test("single v2 rejects missing/corrupt sidecars, forged metadata, external paths and SQLite journals", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "package.sqlite");
  const manifest = await createHistoryBackup(f.usage.database, file, {
    achievementDatabaseFile: f.achievementDatabaseFile,
  });
  const manifestFile = path.join(f.root, "package.manifest.json");
  const sidecar = path.join(f.root, manifest.achievements.filename);
  const bytes = readFileSync(sidecar);
  await fs.rm(sidecar);
  await assert.rejects(verifyHistoryBackup(file));
  writeFileSync(sidecar, "broken");
  await assert.rejects(verifyHistoryBackup(file), /digest mismatch/);
  writeFileSync(sidecar, bytes);
  for (const change of [
    { profileId: "forged" },
    { inputKey: "forged" },
    { schemaVersion: 999 },
    { filename: "../archive.sqlite" },
    { filename: "C:\\external.sqlite" },
    { filename: "sub/archive.sqlite" },
    { filename: "archive.sqlite:stream" },
  ]) {
    writeJson(manifestFile, { ...manifest, achievements: { ...manifest.achievements, ...change } });
    await assert.rejects(verifyHistoryBackup(file));
  }
  writeJson(manifestFile, manifest);
  writeFileSync(`${sidecar}-wal`, "journal");
  await assert.rejects(verifyHistoryBackup(file), /journal/);
  await fs.rm(`${sidecar}-wal`);
  assert.equal((await verifyHistoryBackup(file)).ok, true);
});

test("a checksum-correct sidecar with an incomplete rule directory is rejected before restore publication", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "incomplete.sqlite");
  const manifest = await createHistoryBackup(f.usage.database, file, {
    achievementDatabaseFile: f.achievementDatabaseFile,
  });
  const sidecar = path.join(f.root, manifest.achievements.filename);
  const corrupt = new DatabaseSync(sidecar);
  try {
    corrupt.exec("DELETE FROM achievement_progress WHERE id='A01'");
  } finally {
    corrupt.close();
  }
  manifest.achievements.bytes = statSync(sidecar).size;
  manifest.achievements.sha256 = createHash("sha256").update(readFileSync(sidecar)).digest("hex");
  writeJson(path.join(f.root, "incomplete.manifest.json"), manifest);
  await assert.rejects(verifyHistoryBackup(file), /42/);
  const target = path.join(f.root, "must-not-publish.sqlite");
  const achievementFile = path.join(f.root, "must-not-publish-achievements.sqlite");
  await assert.rejects(
    restoreHistoryBackup(file, target, undefined, { achievementDatabaseFile: achievementFile }),
    /42/,
  );
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(achievementFile), false);
});

test("single full backup and restore preserve foreign files on publication failures", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "package.sqlite");
  const options = { achievementDatabaseFile: f.achievementDatabaseFile };
  const foreignSidecar = `${file}.achievements.sqlite`;
  writeFileSync(foreignSidecar, "keep");
  await assert.rejects(createHistoryBackup(f.usage.database, file, options));
  assert.equal(readFileSync(foreignSidecar, "utf8"), "keep");
  assert.equal(existsSync(file), false);
  await fs.rm(foreignSidecar);
  await createHistoryBackup(f.usage.database, file, options);
  const target = path.join(f.root, "restored.sqlite");
  const archiveTarget = path.join(f.root, "restored-achievements.sqlite");
  writeFileSync(archiveTarget, "keep-profile");
  await assert.rejects(restoreHistoryBackup(file, target, undefined, { achievementDatabaseFile: archiveTarget }));
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(archiveTarget, "utf8"), "keep-profile");
  await fs.rm(archiveTarget);
  const targetManifest = path.join(f.root, "restored.manifest.json");
  writeFileSync(targetManifest, "keep-manifest");
  await assert.rejects(restoreHistoryBackup(file, target, undefined, { achievementDatabaseFile: archiveTarget }));
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(archiveTarget), false);
  assert.equal(readFileSync(targetManifest, "utf8"), "keep-manifest");
  await fs.rm(targetManifest);
  for (const journal of [`${target}-wal`, `${archiveTarget}-journal`]) {
    writeFileSync(journal, "keep-journal");
    await assert.rejects(restoreHistoryBackup(file, target, undefined, { achievementDatabaseFile: archiveTarget }), {
      code: "HISTORY_BACKUP_DESTINATION_EXISTS",
    });
    assert.equal(readFileSync(journal, "utf8"), "keep-journal");
    assert.equal(existsSync(target), false);
    await fs.rm(journal);
  }
  const link = fs.link;
  fs.link = async (source, destination) => {
    if (destination === targetManifest) throw new Error("injected manifest publication failure");
    return link(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      restoreHistoryBackup(file, target, undefined, { achievementDatabaseFile: archiveTarget }),
      /injected manifest publication failure/,
    );
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(archiveTarget), false);
    assert.equal(existsSync(targetManifest), false);
  } finally {
    fs.link = link;
    syncBuiltinESMExports();
  }
  assert.equal(
    readdirSync(f.root).some((name) => name.includes("history-backup-tmp") || name.includes("restoring-")),
    false,
  );
});

test("cold v2 bundle validates, restores the same profile and keeps ordinary imports isolated", async (t) => {
  const f = await fixture(t, { cold: true });
  const bundle = path.join(f.root, "bundle");
  await assert.rejects(
    createHistoryBackup(f.usage.database, path.join(f.root, "single.sqlite"), {
      achievementDatabaseFile: f.achievementDatabaseFile,
    }),
    { code: "HISTORY_BACKUP_ARCHIVES_UNSUPPORTED" },
  );
  const published = await publishHistoryArchiveBundle(f.usage.database, bundle, {
    achievementDatabaseFile: f.achievementDatabaseFile,
  });
  assert.equal(published.manifest.formatVersion, 2);
  assert.equal(published.manifest.segments.length, 1);
  assert.equal((await verifyPublishedHistoryArchiveBundle(bundle)).ok, true);
  const ordinaryDir = path.join(f.root, "ordinary-import");
  const ordinary = await publishHistoryArchiveImport(bundle, ordinaryDir);
  assert.equal(Object.hasOwn(ordinary, "achievementDatabaseFile"), false);
  assert.equal(existsSync(path.join(ordinaryDir, "achievements.sqlite")), false);
  const fullDir = path.join(f.root, "full-restore");
  const archiveFile = path.join(fullDir, "achievements.sqlite");
  const restored = await restoreHistoryArchiveBundle(bundle, fullDir, { achievementDatabaseFile: archiveFile });
  assertProfile(archiveFile, f.archive);
  const runtime = new DatabaseSync(restored.runtimeFile, { readOnly: true });
  try {
    assert.equal(runtime.prepare("SELECT COUNT(*) n FROM events").get().n, 2);
    const facts = readAchievementFacts(runtime, {
      enabledAt: T0,
      cutoff: T0 + 50,
      stamp: { version: "restored" },
      identity: () => ({
        modelId: "model",
        providerId: "provider",
        harnessId: "codex",
        sessionKey: "session",
        repositoryKey: null,
      }),
      classifyFree: () => ({ freeClass: "unknown", freeEvidenceKey: null }),
    });
    assert.equal(facts.excluded.beforeEnabledAt, 1);
    assert.equal(facts.facts.length, 1);
    assert.equal(facts.facts[0].totalTokens, "20");
    const coldFile = runtime.prepare("SELECT database_path FROM archive_segments").get().database_path;
    assert.equal(String(coldFile).startsWith(fullDir), true);
    const cold = new DatabaseSync(coldFile, { readOnly: true });
    try {
      assert.equal(cold.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
    } finally {
      cold.close();
    }
  } finally {
    runtime.close();
  }
  await assert.rejects(restoreHistoryArchiveBundle(bundle, fullDir, { achievementDatabaseFile: archiveFile }));
  assertProfile(archiveFile, f.archive);
  const v1 = path.join(f.root, "legacy-bundle");
  assert.equal((await publishHistoryArchiveBundle(f.usage.database, v1)).manifest.formatVersion, 1);
  const legacyDir = path.join(f.root, "legacy-full");
  await assert.rejects(
    restoreHistoryArchiveBundle(v1, legacyDir, {
      achievementDatabaseFile: path.join(legacyDir, "achievements.sqlite"),
    }),
    /v2 bundle/,
  );
  assert.equal(existsSync(legacyDir), false);
});

test("cold v2 bundle sidecar loss, corruption and path escape fail closed before restore", async (t) => {
  const f = await fixture(t, { cold: true });
  const bundle = path.join(f.root, "bundle");
  const published = await publishHistoryArchiveBundle(f.usage.database, bundle, {
    achievementDatabaseFile: f.achievementDatabaseFile,
  });
  const sidecar = path.join(bundle, "achievements.sqlite");
  const bytes = readFileSync(sidecar);
  await fs.rm(sidecar);
  await assert.rejects(verifyPublishedHistoryArchiveBundle(bundle));
  writeFileSync(sidecar, "broken");
  await assert.rejects(verifyPublishedHistoryArchiveBundle(bundle), /digest/);
  writeFileSync(sidecar, bytes);
  const manifest = {
    ...published.manifest,
    achievements: { ...published.manifest.achievements, filename: "../archive.sqlite" },
  };
  writeJson(published.manifestFile, manifest);
  writeJson(published.markerFile, {
    ...published.marker,
    bundleManifestSha256: createHash("sha256").update(readFileSync(published.manifestFile)).digest("hex"),
  });
  await assert.rejects(verifyPublishedHistoryArchiveBundle(bundle), /adjacent filename/);
  const destination = path.join(f.root, "failed");
  await assert.rejects(
    restoreHistoryArchiveBundle(bundle, destination, {
      achievementDatabaseFile: path.join(destination, "achievements.sqlite"),
    }),
  );
  assert.equal(existsSync(destination), false);
});

test("full bundle restore marker failure removes only its own prepared output", async (t) => {
  const f = await fixture(t, { cold: true });
  const bundle = path.join(f.root, "bundle");
  await publishHistoryArchiveBundle(f.usage.database, bundle, { achievementDatabaseFile: f.achievementDatabaseFile });
  const destination = path.join(f.root, "failed-restore");
  const write = fs.writeFile;
  fs.writeFile = async (file, ...args) => {
    if (file === path.join(destination, "import.complete.json")) throw new Error("injected marker failure");
    return write(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      restoreHistoryArchiveBundle(bundle, destination, {
        achievementDatabaseFile: path.join(destination, "achievements.sqlite"),
      }),
      /injected marker failure/,
    );
    assert.equal(existsSync(destination), false);
    assert.equal((await verifyPublishedHistoryArchiveBundle(bundle)).ok, true);
  } finally {
    fs.writeFile = write;
    syncBuiltinESMExports();
  }
});

test("process interruption during sidecar preparation never publishes a completed backup", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "interrupted.sqlite");
  const source = `import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    import {DatabaseSync} from 'node:sqlite';
    import {createHistoryBackup} from ${JSON.stringify(pathToFileURL(path.resolve("src/history-backup.js")).href)};
    const original=fs.link;
    fs.link=async (from,to)=>{if(to.includes('.achievements.sqlite.history-backup-tmp-'))process.exit(37); return original(from,to)};
    syncBuiltinESMExports();
    const db=new DatabaseSync(${JSON.stringify(f.usage.databaseFile)},{readOnly:true});
    await createHistoryBackup(db,${JSON.stringify(file)},{achievementDatabaseFile:${JSON.stringify(f.achievementDatabaseFile)}});`;
  assert.throws(
    () => execFileSync(process.execPath, ["--input-type=module", "-e", source], { stdio: "pipe" }),
    (error) => error.status === 37,
  );
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(path.join(f.root, "interrupted.manifest.json")), false);
  assert.equal(f.archive.readProfile().profileId, "same-profile");
});

test("a process lost before the final restore manifest never publishes a completed profile or alters its source", async (t) => {
  const f = await fixture(t);
  const sourceFile = path.join(f.root, "complete.sqlite");
  await createHistoryBackup(f.usage.database, sourceFile, { achievementDatabaseFile: f.achievementDatabaseFile });
  const before = f.archive.readSnapshot();
  const destination = path.join(f.root, "interrupted-restore.sqlite");
  const achievementFile = path.join(f.root, "interrupted-restore-achievements.sqlite");
  const manifestFile = path.join(f.root, "interrupted-restore.manifest.json");
  const child = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    import {restoreHistoryBackup} from ${JSON.stringify(pathToFileURL(path.resolve("src/history-backup.js")).href)};
    const original=fs.link; fs.link=async(from,to)=>{if(to===${JSON.stringify(manifestFile)})process.exit(38);return original(from,to)};
    syncBuiltinESMExports(); await restoreHistoryBackup(${JSON.stringify(sourceFile)},${JSON.stringify(destination)},undefined,
      {achievementDatabaseFile:${JSON.stringify(achievementFile)}});`;
  assert.throws(
    () => execFileSync(process.execPath, ["--input-type=module", "-e", child], { stdio: "pipe" }),
    (error) => error.status === 38,
  );
  assert.equal(existsSync(destination), true);
  assert.equal(existsSync(achievementFile), true);
  assert.equal(existsSync(manifestFile), false);
  await assert.rejects(verifyHistoryBackup(destination));
  assert.deepEqual(f.archive.readSnapshot(), before);
  const safeDestination = path.join(f.root, "retry.sqlite");
  const safeAchievement = path.join(f.root, "retry-achievements.sqlite");
  await restoreHistoryBackup(sourceFile, safeDestination, undefined, { achievementDatabaseFile: safeAchievement });
  assertProfile(safeAchievement, f.archive);
});

test("bundle profile targets cannot collide with runtime SQLite journals", async (t) => {
  const f = await fixture(t, { cold: true });
  const source = path.join(f.root, "bundle-journals");
  await publishHistoryArchiveBundle(f.usage.database, source, { achievementDatabaseFile: f.achievementDatabaseFile });
  for (const filename of ["runtime.sqlite-wal", "runtime.sqlite-shm", "runtime.sqlite-journal", "RUNTIME.SQLITE-WAL"]) {
    const target = path.join(f.root, `bad-${filename}`);
    await assert.rejects(
      restoreHistoryArchiveBundle(source, target, {
        achievementDatabaseFile: path.join(target, filename),
      }),
      /separate adjacent/,
    );
    assert.equal(existsSync(target), false);
  }
});

test("standard v1 backup and bundle work without any achievement modules in the installed package", async (t) => {
  const f = await fixture(t);
  const standard = path.join(f.root, "standard");
  await fs.mkdir(path.join(standard, "src"), { recursive: true });
  await fs.mkdir(path.join(standard, "public"));
  for (const file of [
    "history-backup.js",
    "history-archive.js",
    "history-compact.js",
    "pricing-catalog-format.js",
    "service-tier-evidence-format.js",
    "pricing.js",
    "service-tier-evidence.js",
  ])
    await fs.copyFile(path.resolve("src", file), path.join(standard, "src", file));
  await fs.copyFile(path.resolve("public/pricing-models.js"), path.join(standard, "public/pricing-models.js"));
  await fs.copyFile(path.resolve("public/model-identity.js"), path.join(standard, "public/model-identity.js"));
  await fs.copyFile(path.resolve("package.json"), path.join(standard, "package.json"));
  const source = `import assert from 'node:assert/strict';
    import {DatabaseSync} from 'node:sqlite';
    import {createHistoryBackup,verifyHistoryBackup,restoreHistoryBackup} from ${JSON.stringify(pathToFileURL(path.join(standard, "src/history-backup.js")).href)};
    import {publishHistoryArchiveBundle,verifyPublishedHistoryArchiveBundle,restoreHistoryArchiveBundle} from ${JSON.stringify(pathToFileURL(path.join(standard, "src/history-archive.js")).href)};
    const source = new DatabaseSync(${JSON.stringify(f.usage.databaseFile)},{readOnly:true});
    const file = ${JSON.stringify(path.join(standard, "backup.sqlite"))};
    assert.equal((await createHistoryBackup(source,file)).formatVersion,1);
    assert.equal((await verifyHistoryBackup(file)).ok,true);
    await restoreHistoryBackup(file,${JSON.stringify(path.join(standard, "restored.sqlite"))});
    const bundle = ${JSON.stringify(path.join(standard, "bundle"))};
    assert.equal((await publishHistoryArchiveBundle(source,bundle)).manifest.formatVersion,1);
    assert.equal((await verifyPublishedHistoryArchiveBundle(bundle)).ok,true);
    await restoreHistoryArchiveBundle(bundle,${JSON.stringify(path.join(standard, "import"))});
    source.close();`;
  execFileSync(process.execPath, ["--input-type=module", "-e", source], { stdio: "pipe" });
  assert.equal(existsSync(path.join(standard, "src/achievement-backup.js")), false);
});

for (const mode of ["DELETE", "WAL"]) {
  test(`profile writer barrier permits separate read-only SQLite backups in ${mode} mode and releases on failure`, async (t) => {
    const f = await fixture(t);
    const writer = new DatabaseSync(f.achievementDatabaseFile);
    try {
      writer.exec(`PRAGMA journal_mode = ${mode}; PRAGMA busy_timeout = 0`);
      const write = () =>
        writer
          .prepare("INSERT INTO achievement_operations VALUES ('share', 'concurrent', ?, '{}')")
          .run(new Date(T0 + 200).toISOString());
      const file = path.join(f.root, "locked-backup.sqlite");
      const returned = await withAchievementBackupLock(f.achievementDatabaseFile, async () => {
        assert.throws(write, /locked/);
        const manifest = await createHistoryBackup(f.usage.database, file, {
          achievementDatabaseFile: f.achievementDatabaseFile,
        });
        assert.equal(manifest.achievements.inputKey, "completed-input");
        assertProfile(path.join(f.root, manifest.achievements.filename), f.archive);
        assert.throws(write, /locked/);
        return "completed";
      });
      assert.equal(returned, "completed");
      const failure = new Error("backup interrupted");
      await assert.rejects(
        withAchievementBackupLock(f.achievementDatabaseFile, () => {
          assert.throws(write, /locked/);
          throw failure;
        }),
        (error) => error === failure,
      );
      write();
      assert.equal(
        f.archive.readOperations().some((row) => row.key === "concurrent"),
        true,
      );
      const missing = path.join(f.root, "missing.sqlite");
      await assert.rejects(withAchievementBackupLock(missing, () => assert.fail("must not run")));
      assert.equal(existsSync(missing), false);
    } finally {
      writer.close();
    }
  });
}
