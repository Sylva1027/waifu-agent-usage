import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);
const moduleUrl = (file) => new URL(file, root).href;
// One-time trigger removal and read-only package validators are shared compatibility code.
const allowedFormats = new Set([
  "usage-record-migration.js",
  "achievement-backup-format.js",
  "achievement-format-descriptor.js",
  "pricing-catalog-format.js",
]);
const forbiddenModules = [
  "src/usage-store.js",
  "src/usage-core.js",
  "src/service-tier-evidence.js",
  "public/waifu-timeline.js",
  "public/pricing-models.js",
  "public/range-metrics.js",
  ...readdirSync(new URL("../src/", import.meta.url))
    .filter((file) => /^(pricing(?:-.*)?|achievement-.*|usage-record.*)\.js$/.test(file) && !allowedFormats.has(file))
    .map((file) => `src/${file}`),
  ...readdirSync(new URL("../src/waifu/", import.meta.url))
    .filter((file) => file.endsWith(".js"))
    .map((file) => `src/waifu/${file}`),
];

function noExtensions(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(
      ![
        "pricingCatalog",
        "costEstimate",
        "records",
        "rangeMetrics",
        "serviceTierEvidence",
        "achievements",
        "achievementShareReceipt",
      ].includes(key),
      key,
    );
    noExtensions(item);
  }
}

test("Lite worker runs hot/cold, freeze, history maintenance and recovery with Waifu modules forbidden", {
  timeout: 30_000,
}, async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const hookFile = path.join(fixture.root, "hold-publication.mjs");
  writeFileSync(
    hookFile,
    `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    import {existsSync,writeFileSync} from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    const file=(name)=>${JSON.stringify(fixture.root)}+'/'+name;
    async function hold(name,fields) {
      writeFileSync(file(name+'-entered'),JSON.stringify(fields));
      const deadline=Date.now()+10000;
      while(!existsSync(file(name+'-release'))) {
        assert.ok(Date.now()<deadline,'publication hold timed out: '+name); await delay(5);
      }
    }
    globalThis[Symbol.for('lite-publication-hold')]=hold;
    registerHooks({load(url,context,next) {
      const loaded=next(url,context);
      if(url!==${JSON.stringify(moduleUrl("src/usage-executor-worker.js"))}) return loaded;
      let source=String(loaded.source);
      for(const [anchor,statement] of [
        ['nextStatus = await syncUsageStore(',
         "if (globalThis.liteHoldEnabled) await globalThis[Symbol.for('lite-publication-hold')]('sync',{pinned:Boolean(publishedReader)});"],
        ['dashboard = await reader.dashboardHistory(filters, message.options ?? {});',
         "if (lease && globalThis.liteHoldEnabled) await globalThis[Symbol.for('lite-publication-hold')]('read',{users:lease.users});"],
      ]) {
        assert.equal(source.split(anchor).length,2,'Lite publication anchor moved');
        source=source.replace(anchor,statement+anchor);
      }
      source=source.replace('nextStatus = await syncUsageStore(',
        "globalThis.liteHoldEnabled=false; nextStatus = await syncUsageStore(");
      const prelude="import {existsSync as liteHoldExists} from 'node:fs';";
      source=source.replace('publicationPending = true;',
        "globalThis.liteHoldEnabled=liteHoldExists("+JSON.stringify(file('hold-next'))+"); publicationPending = true;");
      return {...loaded,source:prelude+source};
    }});
  `,
  );
  const probe = createLiteBoundaryProbe(fixture.root, { forbiddenModules });
  const script = path.join(fixture.root, "lite-scenario.mjs");
  writeFileSync(
    script,
    `
    import assert from 'node:assert/strict';
    import {existsSync,writeFileSync,readFileSync,appendFileSync} from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    import {DatabaseSync} from 'node:sqlite';
    import path from 'node:path';
    import {createUsageExecutor} from ${JSON.stringify(moduleUrl("src/usage-executor-lite.js"))};
    import {createHistoryArchiveCandidate,prepareHistoryArchiveCommit} from ${JSON.stringify(moduleUrl("src/history-archive.js"))};
    const options=${JSON.stringify(fixture.options)},filters=${JSON.stringify(fixture.filters)};
    const root=${JSON.stringify(fixture.root)},file=(name)=>path.join(root,name);
    ${noExtensions.toString()}
    async function until(check) {const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'wait timed out');await delay(5);}}
    let lastRequest;
    function executor(options,configuration={}) {
      return createUsageExecutor(options,{...configuration,serialize(type,value) {
        lastRequest=type+':'+options.databaseFile;return value;
      }});
    }
    const client=executor(options,{idleTimeoutMs:40});
    let release=client.retainWorker(),frozenClient,importedClient;
    try {
      assert.equal('achievementStart' in client,false); assert.equal('serviceTierEvidence' in client,false);
      noExtensions(client.state);
      await client.open(); await client.sync({options});
      assert.equal(await client.validateAcquisition(client.status.fingerprint),true);
      const first=await client.dashboard(filters,{includeDetails:false});
      assert.equal(first.summary.totals.total,310); noExtensions(first); noExtensions(client.state);
      assert.equal((await client.summarize(filters)).totals.total,310);
      noExtensions(await client.periodComparison({now:new Date(filters.now)}));
      assert.equal((await client.metadataFor(new Date(filters.now))).eventCount,4);
      assert.equal((await client.publishedUsageEvents()).length,4);
      assert.ok((await client.publishedUsageHomes()).length);
      noExtensions(await client.publishedUsageReport());
      const line={type:'event_msg',timestamp:'2026-11-16T12:05:00Z',payload:{type:'token_count',info:{last_token_usage:{total_tokens:37,input_tokens:37,cached_input_tokens:0,output_tokens:0}}}};
      appendFileSync(${JSON.stringify(fixture.rolloutFiles[0])},JSON.stringify(line)+'\\n');
      writeFileSync(file('hold-next'),'hold');
      const syncing=client.sync({options});
      await until(()=>existsSync(file('sync-entered')));
      assert.equal(JSON.parse(readFileSync(file('sync-entered'))).pinned,true);
      const reading=client.dashboard(filters,{includeDetails:false});
      await until(()=>existsSync(file('read-entered')));
      assert.equal(JSON.parse(readFileSync(file('read-entered'))).users,1);
      writeFileSync(file('sync-release'),'release'); await syncing;
      assert.equal((await client.metadataFor(new Date(filters.now))).eventCount,5);
      writeFileSync(file('read-release'),'release');
      assert.equal((await reading).summary.totals.total,310,'retired reader must complete its original view');
      assert.equal((await client.dashboard(filters,{includeDetails:false})).summary.totals.total,347);
      const snapshotFile=file('frozen.sqlite');
      const frozen=await client.snapshot({databaseFile:snapshotFile,asOf:Date.parse(filters.now)});
      noExtensions(frozen);
      frozenClient=executor({...options,databaseFile:snapshotFile},{idleTimeoutMs:60000});
      await frozenClient.open({frozen});
      assert.equal((await frozenClient.dashboard(filters,{includeDetails:false})).summary.totals.total,347);
      await frozenClient.close();
      await client.rebuildHistoryRollups();
      const single=await client.backupHistory(file('backup.sqlite'));
      assert.equal(single.formatVersion,3); assert.equal(single.pricing,null);
      const directory=file('bundle'); await client.backupHistoryBundle(directory);
      const imported=await client.historyArchiveImport({sourceDirectory:directory,importDirectory:file('imported')});
      importedClient=executor({...options,homeDir:file('import-home'),databaseFile:imported.runtimeFile,importContext:{}},{idleTimeoutMs:60000});
      await importedClient.open({imported:true});
      assert.equal((await importedClient.summarize(filters)).totals.total,347);
      noExtensions(importedClient.state); assert.equal(existsSync(file('import-home/achievements.sqlite')),false);
      await importedClient.close();
      release(); await until(()=>!client.alive);
      noExtensions(client.state); const status=client.status;
      release=client.retainWorker();
      assert.equal((await client.dashboard(filters,{includeDetails:false})).summary.totals.total,347);
      assert.deepEqual(client.status,status); assert.equal(client.restarts,0);
      await client.crashWorkerForTest(); assert.equal(client.status,null); noExtensions(client.state);
      await client.open(); assert.equal(client.restarts,1);
      assert.equal((await client.summarize(filters)).totals.total,347);
      await assert.rejects(client.request('achievementStart',{args:{edition:'waifu'}}),{code:'EXECUTOR_BAD_MESSAGE'});
      const timeout=executor(options,{requestTimeoutMs:1});
      try {await assert.rejects(timeout.open(),{code:'EXECUTOR_TIMEOUT'});} finally {await timeout.close();}
      const db=new DatabaseSync(options.databaseFile);
      let plan;
      try {
        await createHistoryArchiveCandidate(db,file('candidate.sqlite'),{
          startMs:Date.parse('2026-11-16T12:00:00Z'),endMs:Date.parse('2026-11-16T12:00:00Z')+1,pricingCatalog:null,
        });
        plan=await prepareHistoryArchiveCommit(db,file('candidate.sqlite'));
      } finally {db.close();}
      await client.commitHistoryArchiveEvents(plan);
      const inventory=await client.historyArchives();
      assert.equal(inventory.counts.segments,1);
      const id=inventory.segments[0].segmentId;
      assert.equal((await client.historyArchiveDays(id)).days[0].totals.total,120);
      const page=await client.historyArchiveEventPage(id,{startMs:0,endMs:Date.parse(filters.now),limit:10});
      assert.equal(page.events.length,1);
      assert.equal((await client.dashboard(filters,{includeDetails:false})).summary.totals.total,347);
      await client.rebuildHistoryRollups();
      await client.backupHistoryBundle(file('cold-bundle'));
      const coldManifest=JSON.parse(readFileSync(file('cold-bundle/bundle.manifest.json')));
      assert.equal(coldManifest.formatVersion,3); assert.equal(coldManifest.achievements,null);
      assert.equal(JSON.parse(readFileSync(path.join(file('cold-bundle'),coldManifest.main.manifestFile))).pricing,null);
      const cold=await client.snapshot({databaseFile:file('cold-frozen.sqlite'),asOf:Date.parse(filters.now)});
      noExtensions(cold);
      frozenClient=executor({...options,databaseFile:file('cold-frozen.sqlite')},{idleTimeoutMs:60000});
      await frozenClient.open({frozen:cold});
      assert.equal((await frozenClient.summarize(filters)).totals.total,347); await frozenClient.close();
      release(); await client.close(); assert.equal(client.alive,false);
      await assert.rejects(client.open(),{code:'EXECUTOR_UNAVAILABLE'});
      console.log('lite lifecycle passed');
    } catch(error) { console.error('last request:',lastRequest); throw error;
    } finally {release();await frozenClient?.close();await importedClient?.close();await client.close();}
  `,
  );
  const env = { ...probe.env, NODE_OPTIONS: `${probe.env.NODE_OPTIONS} --import=${pathToFileURL(hookFile).href}` };
  let stdout;
  try {
    ({ stdout } = await run(process.execPath, [script], { env, windowsHide: true, timeout: 25000 }));
  } catch (error) {
    t.diagnostic(JSON.stringify(probe.read().filter((event) => event.forbidden)));
    throw error;
  }
  assert.equal(stdout.trim(), "lite lifecycle passed");
  const events = probe.read();
  assert.equal(events.filter((event) => event.forbidden).length, 0);
  assert.ok(
    events.some(
      (event) =>
        event.role === "parent" && event.kind === "load" && event.url === moduleUrl("src/usage-executor-lite.js"),
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.role === "child" && event.kind === "load" && event.url === moduleUrl("src/usage-executor-worker.js"),
    ),
  );
  assert.equal(
    events.some(
      (event) => event.role === "parent" && event.kind === "load" && event.url === moduleUrl("src/usage-store-lite.js"),
    ),
    false,
  );
  for (const file of ["src/usage-executor.js", "src/waifu/usage-executor-runtime.js"]) {
    await assert.rejects(
      run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl(file))})`], {
        env: probe.env,
        windowsHide: true,
      }),
      (error) => error.stderr.includes("LITE_BOUNDARY_MODULE"),
    );
  }
});

test("Lite imports an existing Waifu achievement bundle using only read-only metadata validators", {
  timeout: 20_000,
}, async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const { createUsageExecutor } = await import("../src/usage-executor-waifu.js");
  const waifu = createUsageExecutor(fixture.options, { idleTimeoutMs: 60000 });
  const directory = path.join(fixture.root, "waifu-bundle");
  try {
    await waifu.sync({ options: fixture.options });
    await waifu.achievementStart({ edition: "waifu", timeZone: "UTC", now: Date.parse("2026-11-16T11:00:00Z") });
    await waifu.achievementUpdate();
    await waifu.backupHistoryBundle(directory);
  } finally {
    await waifu.close();
  }
  const probe = createLiteBoundaryProbe(fixture.root, { forbiddenModules });
  const script = path.join(fixture.root, "import-waifu.mjs");
  writeFileSync(
    script,
    `
    import assert from 'node:assert/strict';
    import {existsSync,readFileSync} from 'node:fs';
    import path from 'node:path';
    import {createHash} from 'node:crypto';
    import {createUsageExecutor} from ${JSON.stringify(moduleUrl("src/usage-executor-lite.js"))};
    const options=${JSON.stringify(fixture.options)},filters=${JSON.stringify(fixture.filters)};
    const directory=${JSON.stringify(directory)},root=${JSON.stringify(fixture.root)};
    const manifest=JSON.parse(readFileSync(path.join(directory,'bundle.manifest.json')));
    assert.equal(manifest.formatVersion,2); assert.ok(manifest.achievements);
    const digest=()=>createHash('sha256').update(readFileSync(path.join(directory,'bundle.manifest.json'))).digest('hex');
    const before=digest(),home=path.join(root,'lite-import-home');
    const client=createUsageExecutor(options,{idleTimeoutMs:60000});
    let imported;
    try {
      const published=await client.historyArchiveImport({sourceDirectory:directory,importDirectory:path.join(root,'lite-import')});
      imported=createUsageExecutor({...options,homeDir:home,databaseFile:published.runtimeFile,importContext:{}},{idleTimeoutMs:60000});
      await imported.open({imported:true});
      const summary=await imported.summarize(filters);
      assert.equal(summary.totals.total,310); assert.equal(Object.hasOwn(summary,'costEstimate'),false);
      assert.equal('achievementStart' in imported,false); assert.equal(Object.hasOwn(imported.state,'achievements'),false);
      assert.equal(existsSync(path.join(home,'achievements.sqlite')),false); assert.equal(digest(),before);
      console.log('readonly sidecar passed');
    } finally {await imported?.close();await client.close();}
  `,
  );
  const { stdout } = await run(process.execPath, [script], { env: probe.env, windowsHide: true, timeout: 18000 });
  assert.equal(stdout.trim(), "readonly sidecar passed");
  assert.equal(probe.read().filter((event) => event.forbidden).length, 0);
  assert.ok(
    probe.read().some((event) => event.kind === "load" && event.url === moduleUrl("src/achievement-backup-format.js")),
  );
});

test("Waifu frozen initialization never starts an inherited achievement profile", async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const { createUsageExecutor } = await import("../src/usage-executor-waifu.js");
  const { existsSync } = await import("node:fs");
  const client = createUsageExecutor({ ...fixture.options, achievement: { edition: "waifu", timeZone: "UTC" } });
  try {
    await client.open({ frozen: { checkedAt: fixture.filters.now } });
    await assert.rejects(client.achievementStart({ edition: "waifu", timeZone: "UTC" }), {
      code: "ACHIEVEMENT_CONTEXT_REQUIRED",
    });
    assert.equal(existsSync(path.join(fixture.root, "achievements.sqlite")), false);
  } finally {
    await client.close();
  }
});
