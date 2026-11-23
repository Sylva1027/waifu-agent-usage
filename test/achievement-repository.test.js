import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCommonRepositoryResolver, createRepositoryResolver } from "../src/repository-identity.js";

test("usage groups a linked worktree under its main checkout, while achievements retain their checkout aliases", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "achievement-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = path.join(root, "projects", "codex-usage"),
    worktree = path.join(root, "worktrees", "branch", "codex-usage"),
    clone = path.join(root, "clone", "codex-usage");
  const gitDirectory = path.join(main, ".git", "worktrees", "branch");
  await mkdir(gitDirectory, { recursive: true });
  await mkdir(path.join(worktree, "src"), { recursive: true });
  await mkdir(path.join(clone, ".git"), { recursive: true });
  await writeFile(path.join(worktree, ".git"), `gitdir: ${path.relative(worktree, gitDirectory)}\n`);
  await writeFile(path.join(gitDirectory, "commondir"), "../..\n");
  const resolve = createRepositoryResolver(),
    common = createCommonRepositoryResolver();
  const a = await common(main),
    b = await common(worktree),
    c = await common(clone);
  assert.notEqual(a.key, b.key);
  const mainRepository = await resolve(main);
  assert.deepEqual(mainRepository, { key: a.key, path: a.path, kind: "git" });
  assert.deepEqual(await resolve(worktree), mainRepository);
  assert.deepEqual(await resolve(path.join(worktree, "src")), mainRepository);
  assert.notEqual((await resolve(clone)).key, mainRepository.key);
  assert.equal(a.commonKey, b.commonKey);
  assert.notEqual(a.commonKey, c.commonKey);
  assert.ok(a.evidence.commonDirectory);
  assert.equal((await common(path.join(root, "missing"))).commonKey, null);
});

test("submodule Git pointers and nonstandard common directories keep their checkout paths", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "submodule-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const submodule = path.join(root, "lib");
  const linked = path.join(root, "linked");
  const commonDirectory = path.join(root, ".git", "modules", "lib");
  const gitDirectory = path.join(commonDirectory, "worktrees", "linked");
  await mkdir(submodule);
  await mkdir(linked);
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(path.join(submodule, ".git"), `gitdir: ${commonDirectory}\n`);
  await writeFile(path.join(linked, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(path.join(gitDirectory, "commondir"), "../..\n");
  const resolve = createRepositoryResolver();
  const common = createCommonRepositoryResolver();
  const moduleEvidence = await common(submodule);
  const linkedEvidence = await common(linked);
  assert.ok(moduleEvidence.commonKey);
  assert.equal(linkedEvidence.commonKey, moduleEvidence.commonKey);
  assert.equal((await resolve(submodule)).path, moduleEvidence.path);
  assert.equal((await resolve(linked)).path, linkedEvidence.path);
  assert.notEqual((await resolve(root)).key, (await resolve(submodule)).key);
});
