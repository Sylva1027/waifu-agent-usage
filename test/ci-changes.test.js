import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/ci-changes.mjs", import.meta.url));

test("CI routes pure docs, code, native changes and unavailable bases without hiding new broken links", (t) => {
  const parent = realpathSync(tmpdir());
  const repo = mkdtempSync(path.join(parent, "waifu-ci-scope-"));
  t.after(() => {
    assert.equal(path.dirname(realpathSync(repo)), parent);
    rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const write = (file, text) => {
    const absolute = path.join(repo, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  };
  const commit = () => {
    git("add", "--all");
    git(
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  const check = (base) =>
    spawnSync(process.execPath, [script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, CI_BASE_SHA: base, GITHUB_OUTPUT: "" },
    });

  git("init", "--quiet");
  git("config", "core.autocrlf", "false");
  write("README.md", "Previously broken [link](missing.md).\n");
  write("docs/images/panel screenshot.png", "fixture");
  write("docs/notes(v1).md", "# Version one");
  const base = commit();
  assert.match(check("").stdout, /^docs-only=false\nnative=true/);
  assert.match(check("1".repeat(40)).stdout, /^docs-only=false\nnative=true/);

  write(
    "README.md",
    "Previously broken [link](missing.md).\n![Panel](<docs/images/panel screenshot.png>)\n[Notes](docs/notes(v1).md)\n",
  );
  const docs = commit();
  const docsResult = check(base);
  assert.equal(docsResult.status, 0, docsResult.stderr);
  assert.match(docsResult.stdout, /^docs-only=true\nnative=false/);

  unlinkSync(path.join(repo, "docs/images/panel screenshot.png"));
  commit();
  const removed = check(docs);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /missing path: docs\/images\/panel screenshot\.png/);

  write("README.md", "[New broken link](bad-path.md)\n");
  const badLink = commit();
  const broken = check(docs);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /missing path: bad-path\.md/);

  write("docs/validation/fixture.md", "# Runtime fixture\n");
  const fixture = commit();
  assert.match(check(badLink).stdout, /^docs-only=false\nnative=false/);

  write("src/usage-store.js", "export {};\n");
  commit();
  assert.match(check(fixture).stdout, /^docs-only=false\nnative=true/);
});
