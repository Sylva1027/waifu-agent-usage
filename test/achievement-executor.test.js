import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { verifyHistoryBackup } from "../src/history-backup.js";
import { UsageStore } from "../src/usage-store.js";
import { createUsageExecutor } from "../src/usage-executor.js";

async function fixture(t) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "achievement-executor-"));
  const databaseFile = path.join(homeDir, "usage-index.sqlite");
  const options = {
    homeDir,
    databaseFile,
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
    importStoreFile: path.join(homeDir, "imports.json"),
  };
  const store = new UsageStore(options);
  await store.open();
  const source = path.join(homeDir, "source.jsonl");
  await writeFile(source, "\n");
  store.database
    .prepare("INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?)")
    .run(source, "codex", "home", "isolated", homeDir, 1, 0, "fixture");
  store.close();
  const executor = createUsageExecutor(options, { idleTimeoutMs: 10000 });
  t.after(async () => {
    await executor.close();
    store.close();
    assert.equal(path.dirname(homeDir), path.resolve(tmpdir()));
    assert.ok(path.basename(homeDir).startsWith("achievement-executor-"));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const insert = (at, total = 10_000_000_000) => {
    const db = new DatabaseSync(databaseFile);
    try {
      db.prepare(`INSERT INTO events(source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning)
        VALUES(?,?,'session','home','isolated','Codex','repo','gpt-6-sol','h','d','w','m',?,?,0,0,0)`).run(
        source,
        at,
        total,
        total,
      );
    } finally {
      db.close();
    }
  };
  return { homeDir, databaseFile, executor, insert };
}

test("published achievement snapshot survives worker death and restart without relying on the usage cache", async (t) => {
  const f = await fixture(t);
  const profile = await f.executor.achievementStart({ edition: "waifu", timeZone: "UTC" });
  f.insert(Date.parse(profile.enabledAt));
  const first = await f.executor.achievementUpdate();
  assert.equal(first.rows.find((row) => row.id === "A32").highestEarned, "stone");
  assert.equal(f.executor.state.achievements, undefined);
  await f.executor.crashWorkerForTest();
  assert.equal(f.executor.alive, false);
  assert.equal(f.executor.achievementSnapshot().profileId, first.profileId);
  assert.deepEqual(f.executor.achievementSnapshot().rows, first.rows);
  await f.executor.open();
  const recovered = await f.executor.achievementUpdate();
  assert.equal(recovered.profileId, first.profileId);
  assert.equal(recovered.enabledAt, first.enabledAt);
  assert.deepEqual(recovered.awards, first.awards);
});

test("executor serializes full v2 single/cold bundle backups and keeps operations separate from backup publication", async (t) => {
  const f = await fixture(t);
  const profile = await f.executor.achievementStart({ edition: "waifu", timeZone: "UTC" });
  const at = Date.parse(profile.enabledAt);
  f.insert(at);
  await f.executor.achievementUpdate();
  const backup = path.join(f.homeDir, "snapshot.sqlite");
  const [manifest, operation] = await Promise.all([
    f.executor.backupHistory(backup),
    f.executor.achievementOperation({ kind: "skin", characterId: "chatgpt" }),
  ]);
  assert.equal(manifest.formatVersion, 2);
  const verified = await verifyHistoryBackup(backup);
  assert.equal(verified.manifest.achievements.profileId, profile.profileId);
  const archived = new DatabaseSync(path.join(f.homeDir, verified.manifest.achievements.filename), { readOnly: true });
  try {
    assert.equal(archived.prepare("SELECT COUNT(*) n FROM achievement_operations").get().n, 0);
  } finally {
    archived.close();
  }
  assert.equal(operation.recorded, true);
  const db = new DatabaseSync(f.databaseFile);
  const candidate = path.join(f.homeDir, "cold.sqlite");
  let plan;
  try {
    await createHistoryArchiveCandidate(db, candidate, { startMs: at - 1, endMs: at + 1 });
    plan = await prepareHistoryArchiveCommit(db, candidate);
  } finally {
    db.close();
  }
  await f.executor.commitHistoryArchiveEvents(plan);
  await f.executor.achievementUpdate();
  const bundle = await f.executor.backupHistoryBundle(path.join(f.homeDir, "cold-bundle"));
  assert.equal(bundle.manifest.formatVersion, 2);
  assert.ok(bundle.manifest.segments.length > 0);
  assert.equal(bundle.manifest.achievements.profileId, profile.profileId);
});

test("frozen executor rejects initialization and does not retain rejected settings after a restart", async (t) => {
  const f = await fixture(t);
  await f.executor.open({ frozen: { checkedAt: new Date().toISOString() } });
  await assert.rejects(f.executor.achievementStart({ edition: "waifu", timeZone: "UTC" }), {
    code: "ACHIEVEMENT_CONTEXT_REQUIRED",
  });
  assert.equal(existsSync(path.join(f.homeDir, "achievements.sqlite")), false);
  await f.executor.crashWorkerForTest();
  await f.executor.open({ frozen: { checkedAt: new Date().toISOString() } });
  assert.equal(existsSync(path.join(f.homeDir, "achievements.sqlite")), false);
});
