import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readCodexWorktreeRoots } from "../src/codex-worktree-roots.js";
import { normalizeDirectoryPath } from "../src/repository-identity.js";

test("Codex worktree attachments recover deleted checkouts without joining ambiguous or remote paths", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-worktree-roots-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(readCodexWorktreeRoots(home).size, 0);
  const main = path.join(home, "projects", "app");
  const subdir = path.join(main, "src");
  await mkdir(path.join(main, ".git"), { recursive: true });
  await mkdir(subdir);
  const slot = (name) => path.join(home, "worktrees", name, "app");
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE thread_attachments (attachment_type TEXT, payload TEXT)");
    const put = db.prepare("INSERT INTO thread_attachments VALUES (?,?)");
    const add = (root, source, archived = false) => {
      const worktree = { hostId: "local", root, ...source };
      put.run(archived ? "archived_worktree" : "worktree", JSON.stringify(archived ? { worktree } : worktree));
    };
    add(slot("deleted"), { sourceGitRoot: main }, true);
    add(slot("legacy"), { sourceCwd: subdir });
    add(slot("unknown"), { sourceCwd: path.join(home, "missing-project") });
    add(slot("remote"), { sourceGitRoot: main, hostId: "ssh" });
    add(main, { sourceGitRoot: main });
    add(slot("reused"), { sourceGitRoot: main });
    add(slot("reused"), { sourceGitRoot: path.join(home, "other", "app") }, true);
    add(slot("reused"), { sourceGitRoot: main });
    put.run("worktree", "broken JSON");
    put.run("worktree", "null");
    put.run("pull_request", JSON.stringify({ hostId: "local", root: slot("unrelated"), sourceGitRoot: main }));
  } finally {
    db.close();
  }
  assert.deepEqual(
    readCodexWorktreeRoots(home),
    new Map([
      [normalizeDirectoryPath(slot("deleted")), main],
      [normalizeDirectoryPath(slot("legacy")), await realpath(main)],
    ]),
  );
});
