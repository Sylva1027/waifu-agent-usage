import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AchievementRuntime } from "../../src/achievement-runtime.js";
import { UsageStore } from "../../src/usage-store.js";

export const T0 = Date.parse("2026-11-01T00:00:00Z");
export const DAY = 86_400_000;

export async function runtimeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "achievement-runtime-"));
  const store = new UsageStore({
    homeDir: root,
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
    importStoreFile: path.join(root, "imports.json"),
    databaseFile: path.join(root, "usage.sqlite"),
  });
  await store.open();
  let now = T0;
  const options = {
    usageStore: store,
    databaseFile: path.join(root, "achievements.sqlite"),
    clock: () => now,
    timeZone: "UTC",
  };
  let runtime = new AchievementRuntime(options);
  const cleanup = [];
  t.after(async () => {
    runtime.close();
    for (const close of cleanup.reverse()) await close();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const sourcePath = path.join(root, "source.jsonl");
  await writeFile(sourcePath, "\n");
  store.database
    .prepare("INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?)")
    .run(sourcePath, "codex", "home", "fixture", root, 1, 0, new Date(T0).toISOString());
  const insert = (extra = {}) => {
    const event = {
      source_path: sourcePath,
      timestamp_ms: now,
      session_id: "session",
      home_id: "home",
      home_label: "fixture",
      channel: "Codex",
      project: root,
      model: "gpt-6-sol",
      hour_key: "h",
      day_key: "d",
      week_key: "w",
      month_key: "m",
      total: 100,
      input: 80,
      cached: 0,
      output: 20,
      reasoning: 0,
      ...extra,
    };
    const columns = Object.keys(event);
    return store.database
      .prepare(`INSERT INTO events (${columns}) VALUES (${columns.map(() => "?")})`)
      .run(...Object.values(event)).lastInsertRowid;
  };
  return {
    root,
    store,
    options,
    sourcePath,
    insert,
    cleanup,
    get runtime() {
      return runtime;
    },
    setNow(value) {
      now = value;
    },
    reopen() {
      runtime.close();
      runtime = new AchievementRuntime(options);
      return runtime;
    },
  };
}

export const observed = (snapshot, id) => snapshot.rows.find((row) => row.id === id).observedValue;

/** Many rows in a few genuine identity/day buckets, with a real SQLite transaction. */
export function seedRuntimePerformance(f, count, at, tokenTotal = 10_000) {
  f.store.database.exec("BEGIN");
  try {
    for (let i = 0; i < count; i++)
      f.insert({
        timestamp_ms: at + i,
        model: ["gpt-6-sol", "claude-sonnet-4", "hy4free"][i % 3],
        session_id: `session-${i % 20}`,
        total: tokenTotal,
        input: tokenTotal - 20,
      });
    f.store.database.exec("COMMIT");
  } catch (error) {
    f.store.database.exec("ROLLBACK");
    throw error;
  }
}
