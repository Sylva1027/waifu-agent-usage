import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readServices, writeServices } from "../src/cli-core.js";
import { discoverUsageSources } from "../src/usage-sources.js";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const LITE = path.join(ROOT, "src/cli-lite.js");
const WAIFU = path.join(ROOT, "src/cli.js");
const FORBIDDEN = [
  "src/pricing.js",
  "src/pricing-auto.js",
  "src/pricing-store.js",
  "src/service-tier-evidence.js",
  "src/usage-core.js",
  "src/usage-store.js",
  "src/server.js",
  "src/usage-executor-waifu.js",
  "src/achievement-store.js",
  "src/achievement-foundation.js",
  "src/achievement-runtime.js",
  "src/achievement-restore.js",
  "src/achievement-backup.js",
  "src/achievement-catalog.js",
  "src/achievement-evaluator.js",
  "src/achievement-operations.js",
  "src/waifu/cli-features.js",
  "public/pricing-models.js",
  "public/waifu-timeline.js",
];

function environment(homeDir, extra = {}) {
  const env = {
    ...process.env,
    ...extra,
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: path.join(homeDir, "AppData/Roaming"),
    LOCALAPPDATA: path.join(homeDir, "AppData/Local"),
    CODEX_USAGE_STATE_FILE: path.join(homeDir, "services.json"),
    CODEX_USAGE_OPEN: "0",
    HOST: "127.0.0.1",
    PORT: "0",
  };
  for (const key of Object.keys(env))
    if (
      /^(?:CODEX_HOME|CODEX_USAGE_(?:HOMES|IMPORT_DIRS|.*_HOMES)|HERMES_HOME|HERMES_DATA_DIR_SUFFIX|CLAUDE_CONFIG_DIR|XDG_DATA_HOME)$/.test(
        key,
      )
    )
      delete env[key];
  return env;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "cli-editions-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const home = path.join(root, "home");
  await mkdir(path.join(home, ".codex/sessions"), { recursive: true });
  await writeFile(
    path.join(home, ".codex/sessions/rollout.jsonl"),
    `${[
      { type: "session_meta", payload: { id: "cli-editions", source: "cli", cwd: root } },
      { type: "turn_context", payload: { model: "gpt-6-sol" } },
      {
        type: "event_msg",
        timestamp: "2026-05-01T02:01:00Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 77,
              input_tokens: 60,
              cached_input_tokens: 10,
              output_tokens: 17,
              reasoning_output_tokens: 3,
            },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
  await mkdir(path.join(home, ".codex-usage"), { recursive: true });
  await writeFile(
    path.join(home, ".codex-usage/imports.json"),
    JSON.stringify({ version: 2, imports: await discoverUsageSources({ homeDir: home, env: {} }) }),
  );
  return { root, home, state: path.join(root, "services.json") };
}

function run(entry, args, homeDir, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: ROOT,
      env: environment(homeDir, extra),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function successful(entry, args, homeDir, extra = {}) {
  const result = await run(entry, args, homeDir, extra);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}

function ready(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`service readiness timed out: ${output}`)), 10_000);
    const collect = (bytes) => {
      output += bytes;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`service exited ${code}: ${output}`));
    });
  });
}

test("Lite help/summary/json and rejection paths ban Waifu modules before any exclusive-state write", async (t) => {
  const f = await fixture(t);
  const probe = createLiteBoundaryProbe(f.root, { forbiddenModules: FORBIDDEN });
  const help = await successful(LITE, ["--help"], f.home, probe.env);
  assert.ok(!help.includes("--with-achievements"));
  const waifuHelp = await successful(WAIFU, ["--help"], f.home);
  assert.ok(waifuHelp.includes("--with-achievements"));
  const positive = await run(WAIFU, ["--help"], f.home, probe.env);
  assert.equal(positive.code, 1, "the forbidden-import positive control must fire");
  assert.match(positive.stderr, /LITE_BOUNDARY_MODULE|Forbidden boundary module/);
  const summary = JSON.parse(await successful(LITE, ["summary", "--json", "--home-dir", f.home], f.home, probe.env));
  assert.equal(summary.summary.totals.total, 77);
  for (const field of ["costEstimate", "rangeMetrics", "records"]) assert.ok(!Object.hasOwn(summary.summary, field));
  const full = JSON.parse(await successful(LITE, ["json", "--home-dir", f.home], f.home, probe.env));
  assert.equal(full.summary.totals.total, 77);
  assert.equal(full.report.events.length, 1);
  assert.match(await successful(LITE, ["summary", "--home-dir", f.home], f.home, probe.env), /Total tokens: 77/);
  const untouched = path.join(f.root, "untouched");
  for (const args of [
    ["history", "restore", "missing", path.join(untouched, "restore.sqlite"), "--with-achievements"],
    ["gateway", "--with-achievements=false"],
    ["run", "--with-achievements"],
  ]) {
    const result = await run(
      LITE,
      [...args, "--home-dir", untouched, "--state-file", path.join(untouched, "services.json"), "--port", "0"],
      f.home,
      probe.env,
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Full achievement restore requires the Waifu edition/);
    assert.equal(existsSync(untouched), false);
  }
  for (const args of [
    ["unknown"],
    ["history", "verify"],
    ["history", "restore"],
    ["history", "archive"],
    ["history", "compact"],
  ]) {
    assert.equal((await run(LITE, args, f.home, probe.env)).code, 1);
  }
  assert.equal(existsSync(path.join(f.home, ".codex-usage/achievements.sqlite")), false);
  const entries = probe.read();
  assert.ok(entries.some((entry) => entry.kind === "load" && entry.url.endsWith("/src/cli-core.js")));
});

test("dashboard/gateway bind edition and real entry; stop/restart preserve foreign live registrations", {
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  const { home: waifuHome } = await fixture(t);
  const { automaticPricingFile } = await import("../src/pricing-store.js");
  const cache = automaticPricingFile({ homeDir: waifuHome });
  await mkdir(path.dirname(cache), { recursive: true });
  const stamp = new Date().toISOString();
  await writeFile(
    cache,
    JSON.stringify({
      priceAttemptedAt: stamp,
      priceUpdatedAt: stamp,
      exchangeRateAttemptedAt: stamp,
      exchangeRateUpdatedAt: stamp,
    }),
  );
  // Share the registry and keep each live edition's SQLite index in its own home.
  const binding = ["--host", "127.0.0.1", "--port", "0", "--state-file", f.state];
  const liteArgs = [...binding, "--home-dir", f.home];
  const foreign = spawn(process.execPath, [WAIFU, "run", ...binding, "--home-dir", waifuHome], {
    cwd: ROOT,
    env: environment(waifuHome),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fakes = [];
  try {
    const foreignUrl = await ready(foreign);
    for (const edition of [undefined, "lite"]) {
      const fake = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
        import {createServer} from 'node:http';
        const server=createServer((request,response)=>{
          if(request.url==='/internal/shutdown') { response.writeHead(202).end(); server.close(()=>process.exit(0)); }
          else response.end('legacy fixture');
        }); server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));`,
        ],
        { cwd: ROOT, env: environment(f.home), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      fakes.push(fake);
      const url = await ready(fake);
      await writeServices(f.state, [
        ...(await readServices(f.state)),
        { pid: fake.pid, url, shutdownToken: "fixture", ...(edition ? { edition, entryFile: WAIFU } : {}) },
      ]);
    }
    const probe = createLiteBoundaryProbe(f.root, { forbiddenModules: FORBIDDEN });
    const output = await successful(LITE, ["dashboard", "--no-open", ...liteArgs], f.home, probe.env);
    const liteUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    assert.notEqual(liteUrl, foreignUrl);
    const registry = await readServices(f.state);
    const actual = registry.find((entry) => entry.url === liteUrl);
    assert.equal(actual.edition, "lite");
    assert.equal(actual.entryFile, realpathSync(LITE));
    assert.equal(actual.argv[0], realpathSync(LITE));
    assert.ok(actual.nodeExecArgv.includes("--max-old-space-size=512"));
    const summaryResponse = await fetch(`${liteUrl}/api/summary?preset=all`);
    const usage = await summaryResponse.json();
    assert.equal(summaryResponse.status, 200, JSON.stringify(usage));
    assert.equal(usage.summary.totals.total, 77);
    assert.ok((await successful(LITE, ["-d", "--no-open", ...liteArgs], f.home, probe.env)).includes(liteUrl));
    await successful(LITE, ["stop", "--state-file", f.state], f.home, probe.env);
    assert.deepEqual(
      (await readServices(f.state)).map((entry) => entry.pid),
      [foreign.pid],
    );
    await successful(LITE, ["stop", "--state-file", f.state], f.home, probe.env);
    assert.deepEqual(
      (await readServices(f.state)).map((entry) => entry.pid),
      [foreign.pid],
      "no matching services must not clear another edition",
    );
    const restarted = await successful(LITE, ["restart", ...liteArgs], f.home, probe.env);
    assert.match(restarted, /Agent Usage Lite gateway restarted/);
    assert.ok((await readServices(f.state)).some((entry) => entry.pid === foreign.pid));
    assert.equal((await fetch(`${foreignUrl}/api/summary?preset=all`)).status, 200);
    await successful(LITE, ["stop", "--state-file", f.state], f.home, probe.env);
    assert.ok(probe.read().some((entry) => entry.kind === "load" && entry.url.endsWith("/src/usage-executor-lite.js")));
  } finally {
    await run(LITE, ["stop", "--state-file", f.state], f.home);
    await run(WAIFU, ["stop", "--state-file", f.state], waifuHome);
    for (const child of [foreign, ...fakes]) if (child.exitCode === null) child.kill();
  }
});

test("Lite history valid branches stay pure, write v3 and preserve legacy v1/v2 verification/import/usage restore", {
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  const { UsageStore } = await import("../src/usage-store-lite.js");
  const { createHistoryBackup, verifyHistoryBackup } = await import("../src/history-backup.js");
  const { createHistoryArchiveCandidate, publishHistoryArchiveBundle, loadHistoryArchiveImport } = await import(
    "../src/history-archive.js"
  );
  const { getPricingCatalog } = await import("../src/pricing.js");
  const { serviceTierEvidenceSnapshot, loadServiceTierEvidence } = await import("../src/service-tier-evidence.js");
  const { AchievementStore } = await import("../src/achievement-store.js");
  const { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } = await import("../src/achievement-catalog.js");
  const sourceFile = path.join(f.home, ".codex-usage/usage-index.sqlite");
  const store = new UsageStore({ homeDir: f.home, env: {}, importDirs: [], databaseFile: sourceFile });
  const legacy = [];
  const candidate = path.join(f.root, "candidate.sqlite");
  try {
    await store.sync();
    const archiveFile = path.join(f.root, "synthetic-legacy-profile.sqlite");
    const archive = new AchievementStore({ databaseFile: archiveFile, catalog: ACHIEVEMENT_CATALOG });
    try {
      archive.open({
        enabledAt: "2026-04-01T00:00:00Z",
        timeZone: "UTC",
        rulesVersion: ACHIEVEMENT_RULES_VERSION,
        catalogHash: createHash("sha256").update(JSON.stringify(ACHIEVEMENT_CATALOG)).digest("hex"),
      });
    } finally {
      archive.close();
    }
    for (const version of [1, 2]) {
      const options = {
        pricingCatalog: getPricingCatalog(),
        serviceTierSnapshot: serviceTierEvidenceSnapshot(loadServiceTierEvidence([])),
        ...(version === 2 ? { achievementDatabaseFile: archiveFile } : {}),
      };
      const file = path.join(f.root, `legacy-v${version}.sqlite`);
      const manifest = await createHistoryBackup(store.database, file, options);
      assert.equal(manifest.formatVersion, version);
      const bundle = path.join(f.root, `legacy-bundle-v${version}`);
      await publishHistoryArchiveBundle(store.database, bundle, options);
      legacy.push({ file, bundle, version });
    }
    await createHistoryArchiveCandidate(store.database, candidate, {
      startMs: Date.parse("2026-05-01T00:00:00Z"),
      endMs: Date.parse("2026-05-02T00:00:00Z"),
      pricingCatalog: null,
      serviceTierSnapshot: null,
    });
  } finally {
    store.close();
  }
  const probe = createLiteBoundaryProbe(f.root, { forbiddenModules: FORBIDDEN });
  const backup = path.join(f.root, "lite-v3.sqlite");
  await successful(LITE, ["history", "backup", sourceFile, backup, "--home-dir", f.home], f.home, probe.env);
  const verified = await verifyHistoryBackup(backup);
  assert.equal(verified.manifest.formatVersion, 3);
  assert.equal(verified.manifest.pricing, null);
  await successful(LITE, ["history", "verify", backup], f.home, probe.env);
  await successful(
    LITE,
    ["history", "restore", backup, path.join(f.root, "lite-restored.sqlite"), "--home-dir", f.home],
    f.home,
    probe.env,
  );
  for (const { file, bundle, version } of legacy) {
    await successful(LITE, ["history", "verify", file], f.home, probe.env);
    const restored = path.join(f.root, `restored-legacy-v${version}.sqlite`);
    await successful(LITE, ["history", "restore", file, restored, "--home-dir", f.home], f.home, probe.env);
    assert.equal(existsSync(`${restored}.achievements.sqlite`), false);
    const imported = path.join(f.root, `imported-legacy-v${version}`);
    await successful(LITE, ["history", "import", bundle, imported], f.home, probe.env);
    const context = await loadHistoryArchiveImport(imported, { serviceTierEvidenceFormat: "snapshot" });
    assert.equal(context.manifest.formatVersion, version);
    assert.equal(context.context.serviceTierEvidence.formatVersion, 1);
    const restoredBundle = path.join(f.root, `restored-legacy-bundle-v${version}`);
    await successful(LITE, ["history", "restore", bundle, restoredBundle, "--home-dir", f.home], f.home, probe.env);
    assert.equal(existsSync(path.join(restoredBundle, "runtime.sqlite.achievements.sqlite")), false);
  }
  await successful(LITE, ["history", "archive", sourceFile, "--dry-run"], f.home, probe.env);
  const committed = await successful(
    LITE,
    [
      "history",
      "archive",
      sourceFile,
      "--commit",
      candidate,
      "--backup",
      path.join(f.root, "before-commit"),
      "--home-dir",
      f.home,
    ],
    f.home,
    probe.env,
  );
  assert.match(committed, /Deleted events: 1/);
  const bundle = path.join(f.root, "lite-bundle-v3");
  await successful(LITE, ["history", "export", sourceFile, bundle, "--home-dir", f.home], f.home, probe.env);
  const manifest = JSON.parse(await readFile(path.join(bundle, "bundle.manifest.json"), "utf8"));
  assert.equal(manifest.formatVersion, 3);
  const imported = path.join(f.root, "lite-imported-v3");
  await successful(LITE, ["history", "import", bundle, imported], f.home, probe.env);
  const loaded = await loadHistoryArchiveImport(imported, { serviceTierEvidenceFormat: "snapshot" });
  assert.equal(loaded.context.pricingCatalog, null);
  assert.equal(loaded.manifest.segments.length, 1);
  await successful(
    LITE,
    ["history", "restore", bundle, path.join(f.root, "lite-restored-bundle"), "--home-dir", f.home],
    f.home,
    probe.env,
  );
  assert.equal(existsSync(path.join(f.home, ".codex-usage/achievements.sqlite")), false);
});

test("Lite CLI archive compaction requires native leases under the module ban", {
  timeout: 60_000,
}, async (t) => {
  const { clean, makeCompactionFixture } = await import("../test-support/history-compaction-fixture.mjs");
  const f = await makeCompactionFixture(t);
  const expected = process.platform === "win32" ? null : clean(await f.read());
  f.store.close();
  const probe = createLiteBoundaryProbe(f.root, { forbiddenModules: FORBIDDEN });
  const args = ["history", "compact", f.file, f.directory];
  if (process.platform !== "win32") {
    const result = await run(LITE, args, f.root, probe.env);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /HISTORY_BACKUP_LEASE_REQUIRED/);
    const store = await f.reopen();
    const registered = store.database.prepare("SELECT database_path FROM archive_segments ORDER BY start_ms").all();
    assert.deepEqual(registered.map((row) => row.database_path), f.packages);
    assert.deepEqual(clean(await f.read()), expected);
    return;
  }
  const compacted = JSON.parse(await successful(LITE, args, f.root, probe.env));
  assert.equal(compacted.switched, 2);
  const replay = JSON.parse(await successful(LITE, args, f.root, probe.env));
  assert.equal(replay.replay, true);
  const rollback = JSON.parse(await successful(LITE, [...args, "--rollback"], f.root, probe.env));
  assert.equal(rollback.rollback, true);
  assert.equal(rollback.switched, 2);
});
