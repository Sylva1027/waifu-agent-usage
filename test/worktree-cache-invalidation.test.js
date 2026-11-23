import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { normalizeDirectoryPath } from "../src/repository-identity.js";
import { readUsageSourceInputs } from "../src/usage-source-inputs.js";
import { UsageStore } from "../src/usage-store.js";
import { codexTokenLine } from "../test-support/codex-log-fixture.mjs";

test("a worktree attachment refreshes cached comparisons without a new usage event", async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "worktree-cache-"));
  const codex = path.join(homeDir, ".codex");
  const main = path.join(homeDir, "main", "app");
  const tree = path.join(homeDir, "old-pr", "app");
  const sessions = path.join(codex, "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(path.join(main, ".git"), { recursive: true });
  const timestamp = "2026-09-01T09:00:00.000Z";
  for (const [id, cwd] of [
    ["main", main],
    ["old-pr", path.join(tree, "src")],
  ]) {
    await writeFile(
      path.join(sessions, `rollout-${id}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { id, cwd, source: "cli" } }),
        codexTokenLine(timestamp, 50, 50),
        "",
      ].join("\n"),
    );
  }
  const state = new DatabaseSync(path.join(codex, "state_5.sqlite"));
  state.exec("CREATE TABLE thread_attachments(attachment_type TEXT, payload TEXT)");
  const insert = state.prepare("INSERT INTO thread_attachments VALUES (?,?)");
  const options = { homeDir, databaseFile: path.join(homeDir, "usage.sqlite"), env: {} };
  const store = new UsageStore(options);
  t.after(async () => {
    store.close();
    state.close();
    await rm(homeDir, { recursive: true, force: true });
  });
  await store.sync();
  const filters = { preset: "all", calendarZone: "utc", now: new Date(timestamp) };
  const initial = await store.dashboardHistory(filters);
  assert.equal(initial.periodComparison.repositories.length, 2);
  const inputs = () => readUsageSourceInputs(options, store.homes, "same-usage");
  const before = await inputs();
  insert.run("browser_preview", "{}");
  assert.deepEqual(await inputs(), before);
  insert.run("archived_worktree", JSON.stringify({ worktree: { hostId: "local", root: tree, sourceGitRoot: main } }));
  const after = await inputs();
  for (const key of ["inputs", "auxiliary", "routingFingerprint"]) assert.notEqual(before[key], after[key]);
  const revision = store.storeRevision;
  const frozen = store.acquirePublishedHotReader();
  try {
    await store.sync();
    assert.equal(new Set(frozen.publishedUsageEvents().map((event) => event.repositoryKey)).size, 2);
  } finally {
    frozen.close();
  }
  assert.ok(store.storeRevision > revision);
  const { periodComparison, summary } = await store.dashboardHistory(filters);
  assert.equal(periodComparison.repositories.length, 1);
  assert.equal(periodComparison.repositories[0].key, `git:${normalizeDirectoryPath(main)}`);
  assert.equal(periodComparison.repositories[0].periods.all.total, initial.periodComparison.totals.all.total);
  assert.equal(summary.repositories.length, 1);
  assert.equal(store.database.prepare("SELECT count(*) n FROM events").get().n, 2);
});
