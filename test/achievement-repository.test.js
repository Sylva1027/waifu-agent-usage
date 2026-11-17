import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCommonRepositoryResolver, createRepositoryResolver } from "../src/repository-identity.js";

test("common Git evidence merges worktrees, preserves legacy keys, and keeps clones separate", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "achievement-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = path.join(root, "main"),
    worktree = path.join(root, "branch"),
    clone = path.join(root, "clone");
  await mkdir(path.join(main, ".git", "worktrees", "branch"), { recursive: true });
  await mkdir(worktree);
  await mkdir(path.join(clone, ".git"), { recursive: true });
  await writeFile(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "branch")}\n`);
  await writeFile(path.join(main, ".git", "worktrees", "branch", "commondir"), "../..\n");
  const legacy = createRepositoryResolver(),
    common = createCommonRepositoryResolver();
  const a = await common(main),
    b = await common(worktree),
    c = await common(clone);
  assert.notEqual(a.key, b.key);
  assert.equal(a.key, (await legacy(main)).key);
  assert.equal(b.key, (await legacy(worktree)).key);
  assert.equal(a.commonKey, b.commonKey);
  assert.notEqual(a.commonKey, c.commonKey);
  assert.ok(a.evidence.commonDirectory);
  assert.equal((await common(path.join(root, "missing"))).commonKey, null);
});
