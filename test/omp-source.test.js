import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  classifyOmpDirectory,
  discoverOmpHomes,
  ompFileIsArchived,
  ompSessionFiles,
  ompWatchRoots,
} from "../src/omp-source.js";
import { createSourceImports, scanImportSources } from "../src/source-imports.js";
import { classifyImportDirectory, discoverUsageSources } from "../src/usage-sources.js";
import { createUsageServer } from "../src/server-lite.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";

const header = JSON.stringify({
  type: "session",
  version: 3,
  id: "s",
  cwd: "/work",
  timestamp: "2026-01-01T00:00:00Z",
});
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "omp-imports-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function log(file, contents = header) {
    await mkdir(path.dirname(file), { recursive: true });
    const text = `${contents}\n`;
    await writeFile(file, file.endsWith(".gz") ? gzipSync(text) : text);
    return file;
  }
  const agent = path.join(root, ".omp", "agent");
  const active = path.join(agent, "sessions");
  const archive = path.join(agent, "archive", "sessions");
  return {
    root,
    agent,
    active,
    archive,
    log,
    options: { homeDir: root, env: {}, importStoreFile: path.join(root, "imports.json") },
  };
}

test("OMP grants merge only selected active, archive or project directories and survive restart", async (t) => {
  const { root, agent, active, archive, log, options } = await fixture(t);
  const project = path.join(active, "work");
  const main = await log(path.join(project, "main.jsonl"));
  const child = await log(path.join(project, "main", "task", "__advisor.jsonl"));
  const other = await log(path.join(active, "other", "other.jsonl"));
  const archived = await log(path.join(archive, "old", "m.jsonl.gz"));
  const archivedChild = await log(path.join(archive, "old", "m", "task.jsonl"));
  await log(path.join(archive, ".omp-gc-compress-stage", "temp.jsonl"));
  const manager = createSourceImports(options, async () => []);
  assert.deepEqual(await manager.list(), []);
  const candidate = (await manager.discover()).candidates.find((s) => s.kind === "omp");
  assert.deepEqual(candidate.selectionPaths, [agent]);
  assert.equal(candidate.confirmed, false);
  assert.deepEqual(await discoverUsageSources({ ...options, confirmedSources: [] }), []);
  const narrow = (await manager.add([project])).selected[0];
  assert.equal(narrow.id, candidate.id);
  assert.deepEqual(narrow.approvedScanRoots, [project]);
  assert.deepEqual(await ompSessionFiles(narrow), [main, child].sort());
  assert.equal((await manager.discover()).candidates.find((s) => s.id === narrow.id).confirmed, false);
  const expanded = (await manager.add([archive])).imports;
  assert.equal(expanded.length, 1);
  assert.deepEqual(expanded[0].approvedScanRoots, [archive, project].sort());
  const afterRestart = createSourceImports(options, async () => []);
  assert.deepEqual(await afterRestart.list(), expanded);
  assert.deepEqual((await afterRestart.remove(archive))[0].approvedScanRoots, [project]);
  const wide = (await afterRestart.add([path.join(root, ".omp"), active])).imports[0];
  assert.deepEqual(wide.approvedScanRoots, [active, archive].sort());
  assert.deepEqual(await ompSessionFiles(wide), [main, child, other, archived, archivedChild].sort());
  assert.equal(ompFileIsArchived(archivedChild, wide), true);
  assert.equal(ompFileIsArchived(child, wide), false);
  assert.equal((await afterRestart.discover()).candidates.find((s) => s.id === narrow.id).confirmed, true);
  assert.equal(JSON.parse(await readFile(options.importStoreFile, "utf8")).imports.length, 1);
});

test("Pi-compatible custom logs require attribution; an explicit OMP source can be confirmed without modifying the logs", async (t) => {
  const { root, log, options } = await fixture(t);
  const custom = path.join(root, "custom-transcripts");
  const file = await log(path.join(custom, "raw.jsonl"));
  const env = { PI_CODING_AGENT_SESSION_DIR: custom };
  const manager = createSourceImports({ ...options, env }, async () => []);
  assert.deepEqual(await manager.list(), []);
  assert.deepEqual(await discoverOmpHomes({ ...options, env }), []);
  const candidate = (await manager.discover()).candidates.find((home) => home.path === custom);
  assert.equal(candidate.needsOmpConfirmation, true);
  await assert.rejects(manager.add([custom]), { code: "OMP_SOURCE_AMBIGUOUS" });
  const typed = (await manager.add([custom], { ompPaths: [custom] })).selected[0];
  assert.deepEqual(typed.approvedScanRoots, [custom]);
  assert.deepEqual(await ompSessionFiles(typed), [file]);
  assert.deepEqual((await manager.add([custom])).imports, [typed]);
  const configured = { ...options, env: { CODEX_USAGE_OMP_HOMES: custom } };
  assert.equal((await discoverOmpHomes({ ...configured, onlyConfiguredSources: true }))[0].id, typed.id);
  assert.equal((await classifyImportDirectory(custom, { ...options, ompExplicit: true })).type, "omp-home");
  assert.equal(await readFile(file, "utf8"), `${header}\n`);
  const empty = path.join(root, "empty");
  await mkdir(empty);
  await assert.rejects(manager.add([empty], { ompPaths: [empty] }), { code: "INVALID_IMPORT_DIRECTORY" });
  assert.deepEqual(
    (await manager.list()).map((h) => h.id),
    [typed.id],
  );
  const mixed = path.join(root, "mixed");
  for (let i = 0; i < 8; i++) await log(path.join(mixed, `noise-${i}.jsonl`), "{}");
  await log(path.join(mixed, "z.jsonl"));
  assert.equal(await classifyOmpDirectory(mixed, options), null);
  assert.equal((await manager.add([mixed], { ompPaths: [mixed] })).selected[0].path, mixed);
});

test("OMP recognizes its fixed title slot and side usage, handles flattened XDG profiles, and honors discovery opt-out", async (t) => {
  const { root, agent, log, options } = await fixture(t);
  const xdg = path.join(root, "share");
  const xdgProfile = path.join(xdg, "omp", "profiles", "work");
  const profile = path.join(root, ".omp", "profiles", "lab", "agent");
  for (const dir of [agent, xdgProfile, profile]) await log(path.join(dir, "sessions", "p", "s.jsonl"));
  const env = { XDG_DATA_HOME: xdg, OMP_PROFILE: "work" };
  assert.deepEqual(
    (await discoverOmpHomes({ ...options, platform: "linux", env })).map((x) => x.path).sort(),
    [agent, xdgProfile, profile].sort(),
  );
  assert.deepEqual(await discoverOmpHomes({ ...options, env: { ...env, CODEX_USAGE_OMP: "0" } }), []);
  assert.equal((await classifyOmpDirectory(agent, { ...options, env: { CODEX_USAGE_OMP: "0" } })).path, agent);
  const other = path.join(root, "copy");
  await log(
    path.join(other, "archive", "sessions", "repo", "a.jsonl.gz"),
    `${header}\n${JSON.stringify({ type: "model_usage", id: "e" })}`,
  );
  assert.equal((await classifyImportDirectory(other, options)).type, "omp-home");
  const codex = path.join(root, "custom-codex");
  await log(
    path.join(codex, "sessions", "file.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: "codex" } }),
  );
  assert.equal((await classifyImportDirectory(codex, options)).type, "codex-home");
  assert.equal(
    (await scanImportSources({ ...options, env: { ...env, CODEX_USAGE_OMP: "0" } })).candidates.some(
      (c) => c.kind === "omp",
    ),
    false,
  );
});

test("OMP confirmation repairs a misclassified Codex grant and a restored index does not grant access", async (t) => {
  const { active, agent, options, log } = await fixture(t);
  await log(path.join(active, "p", "s.jsonl"));
  await writeFile(
    options.importStoreFile,
    JSON.stringify({
      version: 2,
      imports: [{ path: agent, kind: "extra", label: "Imported agent", id: "old-codex", imported: true }],
    }),
  );
  const manager = createSourceImports(options, async () => []);
  assert.equal((await manager.discover()).candidates.find((h) => h.kind === "omp").confirmed, false);
  const entries = (await manager.add([active])).imports;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "omp");
  assert.deepEqual(entries[0].approvedScanRoots, [active]);
  await rm(options.importStoreFile);
  const restored = createSourceImports(options, async () =>
    entries.map(({ approvedScanRoots: _roots, ...home }) => home),
  );
  assert.deepEqual(await restored.list(), []);
});

test("widening portable OMP grants preserves physical ownership on overlap and after restart", async (t) => {
  const { root, options, log } = await fixture(t);
  const backup = path.join(root, "backup");
  const active = path.join(backup, "sessions");
  const projects = ["p", "q", "later"].map((name) => path.join(active, name));
  const files = [];
  for (const dir of projects) files.push(await log(path.join(dir, "main.jsonl"), `${header}\n{"type":"model_usage"}`));
  const manager = createSourceImports(options, async () => []);
  const [first, second] = (await manager.add(projects.slice(0, 2))).imports;
  assert.notEqual(first.id, second.id);
  const extended = (await manager.add([backup])).imports;
  assert.deepEqual(
    extended.map((h) => h.id),
    [first.id, second.id],
  );
  assert.equal(extended[0].path, projects[0]);
  assert.equal(extended[0].agentPath, backup);
  assert.deepEqual(await ompSessionFiles(extended[0]), [files[0], files[2]].sort());
  assert.deepEqual(await ompSessionFiles(extended[1]), [files[1]]);
  assert.deepEqual(await ompWatchRoots(extended[0]), [{ path: active, recursive: false }]);
  assert.deepEqual(await createSourceImports(options, async () => []).list(), extended);
  assert.deepEqual(
    (await manager.add([projects[1]])).selected.map((home) => home.id),
    [second.id],
  );
  const remaining = await manager.remove(projects[1]);
  assert.deepEqual(await ompSessionFiles(remaining[0]), [files[0], files[2]].sort());
  assert.equal((await manager.add([projects[1]])).selected[0].id, second.id);
  const cli = await discoverUsageSources({
    ...options,
    importDirs: [projects[0], backup],
    onlyConfiguredSources: true,
  });
  assert.deepEqual((await Promise.all(cli.map(ompSessionFiles))).flat().sort(), files.sort());
});

test("Lite source dialog confirms the chosen Pi-compatible directory as OMP on explicit retry", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) return t.skip("No local browser runtime");
  const { root, options, log } = await fixture(t);
  const custom = path.join(root, "portable");
  await log(path.join(custom, "session.jsonl"));
  const server = createUsageServer({
    ...options,
    databaseFile: path.join(root, "facts.sqlite"),
    automaticDiscoveryEnabled: false,
  });
  let browser;
  try {
    await listenOnFetchPort(server);
    browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem("codexUsageLocale", "en-US"));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator("#addImportButton").click();
    await page.locator("#importPath").fill(custom);
    const response = () =>
      page.waitForResponse(
        (res) => new URL(res.url()).pathname === "/api/imports" && res.request().method() === "POST",
      );
    const [notice] = await Promise.all([response(), page.locator("#submitImportButton").click()]);
    assert.equal(notice.status(), 400);
    assert.equal((await notice.json()).code, "OMP_SOURCE_AMBIGUOUS");
    assert.deepEqual(JSON.parse(await readFile(options.importStoreFile, "utf8")).imports, []);
    const confirm = page.getByRole("button", { name: "Import as Oh My Pi", exact: true });
    const [accepted] = await Promise.all([response(), confirm.click()]);
    assert.equal(accepted.status(), 200);
    assert.deepEqual(accepted.request().postDataJSON(), { paths: [custom], ompPaths: [custom] });
    assert.deepEqual(JSON.parse(await readFile(options.importStoreFile, "utf8")).imports[0].approvedScanRoots, [
      custom,
    ]);
    await page.waitForFunction(() =>
      document.querySelector("#importMessage").textContent.includes("no usage records yet"),
    );
  } finally {
    await browser?.close();
    await server.close();
  }
});
