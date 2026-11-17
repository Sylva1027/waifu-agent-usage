import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";

test("Lite HTTP, refresh, full report and freeze run without Waifu modules in either process", async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const forbiddenModules = [
    "src/server.js",
    "src/waifu/server-features.js",
    "src/usage-store.js",
    "src/usage-core.js",
    "src/pricing.js",
    "src/pricing-store.js",
    "src/pricing-auto.js",
    "src/usage-record-store.js",
    "src/service-tier-evidence.js",
    "src/history-quote-inputs.js",
    "src/achievement-store.js",
    "src/achievement-runtime.js",
    "src/achievement-operations.js",
    "public/pricing-models.js",
    "public/range-metrics.js",
    "public/waifu-timeline.js",
  ];
  const probe = createLiteBoundaryProbe(fixture.root, { forbiddenModules });
  const serverModule = new URL("../src/server-lite.js", import.meta.url).href;
  const ports = new URL("../test-support/fetch-port.mjs", import.meta.url).href;
  const scenario = `
    import assert from "node:assert/strict";
    import {appendFile} from "node:fs/promises";
    const {createUsageServer}=await import(${JSON.stringify(serverModule)});
    const {listenOnFetchPort}=await import(${JSON.stringify(ports)});
    const server=createUsageServer(${JSON.stringify(fixture.options)});
    try {
      await listenOnFetchPort(server); const root='http://127.0.0.1:'+server.address().port;
      const get=async route=>{const response=await fetch(root+route);const text=await response.text();assert.equal(response.status,200,text);return JSON.parse(text)};
      const current=await get('/api/usage?view=dashboard');
      assert.deepEqual(current.summary.totals,${JSON.stringify(fixture.expected.totals)});
      assert.equal(current.summary.cacheHitRate,1/3); assert.ok(current.usageVersion);
      for(const key of ['pricingCatalog','achievementShareReceipt']) assert.equal(key in current,false);
      for(const key of ['costEstimate','records','rangeMetrics']) assert.equal(key in current.summary,false);
      for(const key of ['activeHarnessModels','modelLastSeen','harnessModels']) assert.equal(key in current.metadata,false);
      const status=await get('/api/status?since='+current.fingerprint);assert.equal(status.changed,false);assert.ok(status.usageVersion);
      const full=await get('/api/usage?detail=full');assert.equal(full.summary.totals.total,310);assert.equal('pricingCatalog' in full.report,false);
      const frozen=await get('/api/usage?view=dashboard&freeze=1');assert.ok(frozen.snapshotId);
      await appendFile(${JSON.stringify(fixture.rolloutFiles[0])},JSON.stringify({type:'event_msg',timestamp:'2026-11-16T12:59:00Z',payload:{type:'token_count',info:{last_token_usage:{total_tokens:1,input_tokens:1}}}})+String.fromCharCode(10));
      const next=await get('/api/usage?view=dashboard');assert.equal(next.summary.totals.total,311);assert.notEqual(next.usageVersion,current.usageVersion);
      const captured=await get('/api/usage?view=dashboard&snapshot='+frozen.snapshotId);assert.equal(captured.summary.totals.total,310);
      for(const route of ['/api/pricing','/api/achievements','/share-card.js','/pricing-models.js','/skin-palette-studio.html']) assert.equal((await fetch(root+route)).status,404,route);
      console.log(JSON.stringify({total:next.summary.totals.total,version:next.usageVersion,freeze:captured.summary.totals.total}));
    } finally {await server.close();}
  `;
  const file = path.join(fixture.root, "lite-http-scenario.mjs");
  await writeFile(file, scenario);
  const { stdout } = await promisify(execFile)(process.execPath, [file], {
    env: probe.env,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.total, 311);
  assert.equal(result.freeze, 310);
  const evidence = probe.read();
  assert.equal(evidence.filter((row) => row.forbidden).length, 0);
  assert.ok(
    evidence.some((row) => row.role === "child"),
    "the probe must observe the actual executor process",
  );
});
