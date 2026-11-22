import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { comparisonRowName } from "../public/dashboard-render.js";
import { summarizePeriodComparison } from "../public/period-comparison.js";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { normalizeDirectoryPath } from "../src/repository-identity.js";
import { UsageStore as LiteStore } from "../src/usage-store-lite.js";
import { UsageStore as WaifuStore } from "../src/usage-store.js";

const filters = { preset: "all", calendarZone: "utc", now: new Date("2026-07-12T12:00:00Z") };
const gitKey = (directory) => `git:${normalizeDirectoryPath(directory)}`;

function seedOldIndex(store, homes, main, worktree, clone) {
  const addSource = store.database.prepare("INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?)");
  for (const [id, home] of Object.entries(homes)) {
    addSource.run(path.join(home, "rollout.jsonl"), "extra", id, id, home, 1, 1, "now");
  }
  const insert = store.database.prepare(`INSERT INTO events(
    source_path,timestamp_ms,session_id,home_id,home_label,channel,project,cwd,
    repository_key,repository_path,repository_kind,model,hour_key,day_key,week_key,month_key,
    total,input,cached,output,reasoning,detail_mask
  ) VALUES(?,?,?,?,?,'CLI',?,?,?,?,?,'test-model',?,?,?,?,?,?,?,?,?,15)`);
  for (const [day, week, homeId, session, cwd, kind, units] of [
    ["2026-06-30", "2026-06-29", "a", "shared", worktree, "git", 1],
    ["2026-07-02", "2026-06-29", "a", "shared", worktree, "directory", 2],
    ["2026-07-10", "2026-07-06", "b", "shared", main, "git", 4],
    ["2026-07-12", "2026-07-06", "a", "new", worktree, "git", 8],
    ["2026-07-12", "2026-07-06", "a", "clone", clone, "git", 16],
  ]) {
    insert.run(
      path.join(homes[homeId], "rollout.jsonl"),
      Date.parse(`${day}T02:00:00Z`),
      session,
      homeId,
      homeId,
      cwd,
      cwd,
      `${kind}:${normalizeDirectoryPath(cwd)}`,
      cwd,
      kind,
      `${day} 02`,
      day,
      week,
      day.slice(0, 7),
      units * 10,
      units * 7,
      units * 2,
      units * 3,
      units,
    );
  }
}

for (const [edition, Store, archiveJune] of [
  ["Waifu", WaifuStore, true],
  ["Lite", LiteStore, false],
]) {
  test(`${edition} attributes legacy Git and directory facts from an archived PR worktree to its main repository`, async (t) => {
    const root = mkdtempSync(path.join(realpathSync(tmpdir()), "usage-worktree-comparison-"));
    const options = { databaseFile: path.join(root, "usage.sqlite"), homeDir: root, env: {} };
    const homes = { a: path.join(root, ".codex"), b: path.join(root, "second-home") };
    const main = path.join(root, "projects", "codex-usage");
    const clone = path.join(root, "clones", "codex-usage");
    const worktree = path.join(homes.a, "worktrees", "author's-pr", "codex-usage");
    let store = new Store(options);
    t.after(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(homes.a);
    mkdirSync(homes.b);
    mkdirSync(path.join(main, ".git"), { recursive: true });
    mkdirSync(path.join(clone, ".git"), { recursive: true });
    await store.open();
    seedOldIndex(store, homes, main, worktree, clone);
    if (archiveJune) {
      const segment = path.join(root, "june.sqlite");
      await createHistoryArchiveCandidate(store.database, segment, {
        startMs: Date.parse("2026-06-01T00:00:00Z"),
        endMs: Date.parse("2026-07-01T00:00:00Z"),
      });
      await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, segment));
      assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 4);
    }
    store.close();

    const state = new DatabaseSync(path.join(homes.a, "state_5.sqlite"));
    try {
      state.exec("CREATE TABLE thread_attachments (attachment_type TEXT, payload TEXT)");
      state
        .prepare("INSERT INTO thread_attachments VALUES (?, ?)")
        .run(
          "archived_worktree",
          JSON.stringify({ worktree: { hostId: "local", root: worktree, sourceGitRoot: main } }),
        );
    } finally {
      state.close();
    }

    store = new Store(options);
    const { periodComparison, summary } = await store.dashboardHistory(filters);
    const report = await store.publishedHistoryUsageReport();
    assert.deepEqual(summarizePeriodComparison(report.events, filters).repositories, periodComparison.repositories);
    const [repository, independent] = [main, clone].map((cwd) =>
      periodComparison.repositories.find((row) => row.key === gitKey(cwd)),
    );
    assert.equal(periodComparison.repositories.length, 2);
    assert.equal(repository.name, main);
    assert.equal(independent.name, clone);
    assert.equal(comparisonRowName(repository.name, "repository"), "codex-usage");
    assert.equal(repository.kind, "git");
    assert.equal(repository.pathCount, 2);
    for (const [period, units] of Object.entries({ today: 8, week: 12, month: 14, all: 15 })) {
      const { total, input, cached, uncachedInput, output, reasoning } = repository.periods[period];
      assert.deepEqual(
        [total, input, cached, uncachedInput, output, reasoning],
        [10 * units, 7 * units, 2 * units, 5 * units, 3 * units, units],
        period,
      );
      assert.equal(independent.periods[period].total, 160);
      assert.equal(periodComparison.totals[period].total, total + 160);
    }
    assert.equal(summary.totals.total, 310);
    assert.equal(summary.repositories.length, 2);
    const detail = summary.repositories.find((row) => row.key === gitKey(main));
    assert.equal(detail.name, main);
    assert.equal(detail.pathCount, 2);
    assert.equal(detail.count, 4);
    assert.equal(detail.total.total, 150);
    assert.equal(detail.sessions, 3);
    assert.deepEqual([...detail.sessionIds].sort(), ["new", "shared", "shared"]);
  });
}
