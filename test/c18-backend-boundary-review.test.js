import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";

test("Lite ignores existing active achievement files through HTTP and worker operations; file and SQLite probes have positive controls", async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const active = [
    `${fixture.options.databaseFile}.achievements.sqlite`,
    path.join(fixture.root, "achievements.sqlite"),
    path.join(fixture.root, ".codex-usage", "achievements.sqlite"),
  ];
  const sentinel = "existing active achievement profile must remain untouched";
  for (const file of active) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, sentinel);
  }
  const trace = path.join(fixture.root, "active-achievement-access.jsonl");
  const hook = path.join(fixture.root, "active-achievement-probe.mjs");
  await writeFile(
    hook,
    `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import sqlite from 'node:sqlite';
    import path from 'node:path';
    import {fileURLToPath} from 'node:url';
    import {registerHooks,syncBuiltinESMExports} from 'node:module';
    const append=fs.appendFileSync;
    const canonical=value=>path.toNamespacedPath(path.resolve(value instanceof URL?fileURLToPath(value):String(value))).toLowerCase();
    const protectedFiles=new Set(${JSON.stringify(active)}.map(canonical));
    const check=(operation,args)=>{
      for(const value of args) {
        if(!(typeof value==='string'||value instanceof URL||Buffer.isBuffer(value)))continue;
        if(protectedFiles.has(canonical(value))){
          append(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,phase:process.env.C18_PROBE_PHASE||'scenario',operation})+'\\n');
          throw Object.assign(new Error('C18_ACTIVE_ACHIEVEMENT_ACCESS: '+operation),{code:'C18_ACTIVE_ACHIEVEMENT_ACCESS'});
        }
      }
    };
    for(const name of ['open','readFile','stat','lstat','access','writeFile','appendFile','unlink','rm','rename','copyFile','link','chmod','watch']){
      if(typeof fs[name]==='function'){
        const original=fs[name];fs[name]=function(...args){check('fs.'+name,args.slice(0,2));return original.apply(this,args)};
      }
      if(typeof fs[name+'Sync']==='function'){
        const original=fs[name+'Sync'];fs[name+'Sync']=function(...args){check('fs.'+name+'Sync',args.slice(0,2));return original.apply(this,args)};
      }
      if(typeof fsp[name]==='function'){
        const original=fsp[name];fsp[name]=function(...args){check('fsp.'+name,args.slice(0,2));return original.apply(this,args)};
      }
    }
    const exists=fs.existsSync;
    fs.existsSync=function(...args){check('fs.existsSync',args);return exists.apply(this,args)};
    sqlite.DatabaseSync=new Proxy(sqlite.DatabaseSync,{
      construct(target,args,newTarget){check('sqlite.DatabaseSync',args.slice(0,1));return Reflect.construct(target,args,newTarget)},
    });
    // Node does not synchronize node:sqlite's named exports with its mutable default.
    globalThis[Symbol.for('c18-probed-sqlite')]=sqlite;
    registerHooks({
      resolve(specifier,context,next){return specifier==='node:sqlite'?{url:'c18:sqlite',shortCircuit:true}:next(specifier,context)},
      load(url,context,next){return url==='c18:sqlite'?{format:'module',shortCircuit:true,
        source:"const sqlite=globalThis[Symbol.for('c18-probed-sqlite')];export const {DatabaseSync,StatementSync,backup,constants}=sqlite;export default sqlite;"}:next(url,context)},
    });
    syncBuiltinESMExports();
  `,
  );
  const probe = createLiteBoundaryProbe(fixture.root, {
    forbiddenModules: [
      "src/pricing.js",
      "src/service-tier-evidence.js",
      "src/usage-record-store.js",
      "src/achievement-store.js",
      "src/achievement-foundation.js",
      "src/achievement-runtime.js",
      "src/achievement-operations.js",
      "src/achievement-backup.js",
      "src/waifu/server-features.js",
    ],
  });
  const env = {
    ...probe.env,
    NODE_OPTIONS: `${probe.env.NODE_OPTIONS} --import=${pathToFileURL(hook).href}`,
  };
  const url = (file) => new URL(`../${file}`, import.meta.url).href;
  const scenario = `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import {createUsageServer} from ${JSON.stringify(url("src/server-lite.js"))};
    import {createUsageExecutor} from ${JSON.stringify(url("src/usage-executor-lite.js"))};
    import {listenOnFetchPort} from ${JSON.stringify(url("test-support/fetch-port.mjs"))};
    const options={...${JSON.stringify(fixture.options)},achievementDatabaseFile:${JSON.stringify(active[0])},
      achievement:{edition:'waifu',databaseFile:${JSON.stringify(active[0])},timeZone:'UTC'}};
    const server=createUsageServer(options);
    let client;
    try {
      await listenOnFetchPort(server);const base='http://127.0.0.1:'+server.address().port;
      const get=async route=>{const r=await fetch(base+route);const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data};
      const live=await get('/api/usage?view=dashboard');assert.equal(live.summary.totals.total,310);
      assert.equal('costEstimate' in live.summary,false);
      await get('/api/usage?detail=full');
      const frozen=await get('/api/usage?view=dashboard&freeze=1');assert.ok(frozen.snapshotId);
      await get('/api/usage?view=dashboard&snapshot='+frozen.snapshotId);
      await get('/api/status?since='+live.fingerprint);
      client=createUsageExecutor(options);
      await client.open();await client.metadata(${JSON.stringify(fixture.filters.now)});
      const manifest=await client.backupHistory(path.join(${JSON.stringify(fixture.root)},'new-backup.sqlite'));
      assert.equal(manifest.formatVersion,3);assert.equal(manifest.achievements,null);assert.equal(manifest.pricing,null);
    } finally {await client?.close();await server.close()}
    console.log('no active achievement access');
  `;
  const run = promisify(execFile);
  // A file entry lets the executor inherit Node options without re-running the caller's program.
  const scenarioFile = path.join(fixture.root, "active-achievement-scenario.mjs");
  await writeFile(scenarioFile, scenario);
  const { stdout } = await run(process.execPath, [scenarioFile], { env, windowsHide: true });
  assert.equal(stdout.trim(), "no active achievement access");
  const cliEnv = {
    ...env,
    HOME: fixture.root,
    USERPROFILE: fixture.root,
    APPDATA: path.join(fixture.root, "AppData/Roaming"),
    LOCALAPPDATA: path.join(fixture.root, "AppData/Local"),
  };
  for (const key of Object.keys(cliEnv))
    if (
      /^(?:CODEX_HOME|CODEX_USAGE_(?:HOMES|IMPORT_DIRS|.*_HOMES)|HERMES_HOME|HERMES_DATA_DIR_SUFFIX|CLAUDE_CONFIG_DIR|XDG_DATA_HOME)$/.test(
        key,
      )
    )
      delete cliEnv[key];
  const cli = fileURLToPath(new URL("../src/cli-lite.js", import.meta.url));
  const cliSummary = await run(process.execPath, [cli, "summary", "--json", "--home-dir", fixture.root], {
    env: cliEnv,
    windowsHide: true,
  });
  assert.equal(Object.hasOwn(JSON.parse(cliSummary.stdout).summary, "costEstimate"), false);
  const cliBackup = path.join(fixture.root, "cli-backup.sqlite");
  await run(
    process.execPath,
    [cli, "history", "backup", fixture.options.databaseFile, cliBackup, "--home-dir", fixture.root],
    {
      env: cliEnv,
      windowsHide: true,
    },
  );
  const cliManifest = JSON.parse(await readFile(path.join(fixture.root, "cli-backup.manifest.json"), "utf8"));
  assert.equal(cliManifest.pricing, null);
  assert.equal(cliManifest.achievements, null);
  const readTrace = async () =>
    readFile(trace, "utf8").then(
      (text) => text.trim().split("\n").map(JSON.parse),
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
  assert.deepEqual(await readTrace(), [], "even swallowed attempts to inspect an active profile must be recorded");
  for (const operation of [
    `import {readFileSync} from 'node:fs';readFileSync(${JSON.stringify(active[0])})`,
    `import {open} from 'node:fs/promises';await open(${JSON.stringify(active[0])},'r')`,
    `import {DatabaseSync} from 'node:sqlite';new DatabaseSync(${JSON.stringify(active[0])},{readOnly:true})`,
  ]) {
    await assert.rejects(
      run(process.execPath, ["--input-type=module", "-e", operation], {
        env: { ...env, C18_PROBE_PHASE: "positive" },
        windowsHide: true,
      }),
      (error) => error.stderr.includes("C18_ACTIVE_ACHIEVEMENT_ACCESS"),
      operation,
    );
  }
  const attempts = await readTrace();
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((row) => row.phase === "positive"));
  assert.equal(probe.read().filter((row) => row.forbidden).length, 0);
  for (const file of active) assert.equal(await readFile(file, "utf8"), sentinel);
});

test("a no-price bundle imported by Waifu fixes its chosen catalog before live and frozen HTTP queries", async (t) => {
  const fixture = createLiteEditionFixture();
  const { UsageStore } = await import("../src/usage-store-lite.js");
  const { publishHistoryArchiveBundle, publishHistoryArchiveImport } = await import("../src/history-archive.js");
  const { createHistoryArchiveImportServer } = await import("../src/server.js");
  const { getPricingCatalog, setPricingCatalog } = await import("../src/pricing.js");
  const { listenOnFetchPort } = await import("../test-support/fetch-port.mjs");
  const original = getPricingCatalog();
  const donor = new UsageStore(fixture.options);
  let server;
  t.after(async () => {
    await server?.close();
    donor.close();
    setPricingCatalog(original);
    fixture.close();
  });
  await donor.sync();
  const bundle = path.join(fixture.root, "no-price-bundle");
  const published = await publishHistoryArchiveBundle(donor.database, bundle, {
    pricingCatalog: null,
    serviceTierSnapshot: null,
  });
  assert.equal(published.manifest.formatVersion, 3);
  const mainManifest = JSON.parse(await readFile(path.join(bundle, published.manifest.main.manifestFile), "utf8"));
  assert.equal(mainManifest.pricing, null);
  const directory = path.join(fixture.root, "no-price-import");
  await publishHistoryArchiveImport(bundle, directory);
  const pricingFile = path.join(fixture.root, "import-pricing.json");
  await writeFile(pricingFile, JSON.stringify({ ...original, checkedAt: "2026-11-16", usdToCnyRate: 7 }));
  let externalRefreshes = 0;
  server = await createHistoryArchiveImportServer(directory, {
    homeDir: fixture.root,
    pricingFile,
    env: {},
    automaticDiscoveryEnabled: false,
    pricingFetcher: async () => {
      externalRefreshes++;
      throw new Error("unexpected imported pricing refresh");
    },
  });
  const chosen = getPricingCatalog();
  await listenOnFetchPort(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (route) => {
    const response = await fetch(base + route);
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const initial = await get("/api/usage?preset=all&view=dashboard");
  assert.equal(initial.summary.totals.total, 310);
  assert.ok(initial.summary.costEstimate.totalUsd > 0);
  assert.equal(initial.pricingCatalog.version, chosen.version);
  const frozen = await get("/api/usage?preset=all&view=dashboard&freeze=1");
  assert.ok(frozen.snapshotId);
  const changed = structuredClone(chosen);
  changed.checkedAt = "2026-11-17";
  changed.usdToCnyRate = 21;
  for (const model of Object.values(changed.models))
    for (const rates of [model.short, model.long, model.fast?.short, model.fast?.long].filter(Boolean))
      for (const field of ["input", "cachedInput", "cacheWrite", "output"]) rates[field] *= 3;
  const liveCatalog = setPricingCatalog(changed);
  assert.notEqual(liveCatalog.version, chosen.version);
  await writeFile(pricingFile, JSON.stringify(changed));
  for (const route of [
    "/api/usage?preset=all&view=dashboard",
    `/api/usage?preset=all&view=dashboard&snapshot=${frozen.snapshotId}`,
  ]) {
    const data = await get(route);
    assert.equal(data.pricingCatalog.version, chosen.version);
    assert.deepEqual(data.summary.costEstimate, initial.summary.costEstimate);
  }
  assert.equal((await get("/api/pricing")).version, chosen.version);
  const refresh = await fetch(`${base}/api/pricing/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(refresh.status, 405);
  assert.equal((await refresh.json()).code, "IMPORT_PRICING_READ_ONLY");
  assert.equal(externalRefreshes, 0);
  await assert.rejects(access(path.join(directory, "runtime.sqlite.achievements.sqlite")), { code: "ENOENT" });
});

test("closing a published reader retains the source projection, quote inputs and borrowed period cache", async (t) => {
  const fixture = createLiteEditionFixture();
  const { UsageStore } = await import("../src/usage-store.js");
  const owner = new UsageStore(fixture.options);
  let reader;
  t.after(() => {
    reader?.close();
    owner.close();
    fixture.close();
  });
  await owner.sync();
  await owner.dashboardHistory(fixture.filters, { includeDetails: true });
  const slot = owner.summaryProjectionCache;
  const inputs = slot?.quoteInputs;
  assert.ok(inputs?.complete);
  assert.equal(inputs.active, true);
  const length = inputs.length;
  reader = owner.acquirePublishedHotReader();
  assert.notEqual(reader.summaryProjectionCache, slot);
  assert.notEqual(reader.summaryProjectionCache.projection, slot.projection);
  assert.notEqual(reader.summaryProjectionCache.projection.timeline[0], slot.projection.timeline[0]);
  assert.equal(reader.summaryProjectionCache.quoteInputs, null);
  assert.notEqual(reader.eventCostMemo, owner.eventCostMemo);
  const shared = new Map();
  reader.borrowPeriodComparisonCache(shared);
  const database = reader.database;
  await reader.dashboardHistory(fixture.filters, { includeDetails: true });
  assert.ok(shared.size > 0);
  const cachedPeriods = [...shared];
  database.exec("ROLLBACK");
  reader.close();
  reader.close();
  assert.equal(database.isOpen, false);
  assert.deepEqual([...shared], cachedPeriods);
  assert.equal(owner.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 4);
  assert.equal(owner.summaryProjectionCache, slot);
  assert.equal(owner.summaryProjectionCache.quoteInputs, inputs);
  assert.equal(inputs.active, true);
  assert.equal(inputs.length, length);
  owner.close();
  assert.equal(inputs.active, false, "only the source owner releases its quote inputs");
});
