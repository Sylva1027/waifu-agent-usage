import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createLiteBoundaryProbe, installLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";

const moduleURL = (file) => new URL(`../${file}`, import.meta.url).href;

function fixture(t) {
  const input = createLiteEditionFixture();
  t.after(() => input.close());
  return input;
}

function run(code, env = process.env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}

function assertFinished(probe) {
  const entries = probe.read();
  const started = entries
    .filter((entry) => entry.kind === "start")
    .map((entry) => entry.pid)
    .sort();
  const exited = entries
    .filter((entry) => entry.kind === "exit")
    .map((entry) => entry.pid)
    .sort();
  assert.ok(started.length > 0);
  assert.deepEqual(exited, started, "every probed process exited before fixture cleanup");
  return entries;
}

test("four-event fixture has independent totals, masks and a 1/3 cache cohort", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.expected, {
    eventCount: 4,
    sessionCount: 4,
    totals: { total: 310, input: 230, cached: 50, output: 50, reasoning: 7 },
    cacheRateInput: 150,
    cacheRateCached: 50,
    cacheHitRate: 1 / 3,
  });
  assert.deepEqual(
    f.events.map((event) => event.detailMask),
    [15, 15, 5, 0],
  );
  assert.equal(f.rolloutFiles.length, 4);
  const raw = f.rolloutFiles.map((file) => JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)));
  assert.deepEqual(raw[2].payload.info.last_token_usage, { total_tokens: 100, input_tokens: 80, output_tokens: 20 });
  assert.deepEqual(raw[3].payload.info.last_token_usage, { total_tokens: 30 });
  const sums = Object.fromEntries(
    Object.keys(f.expected.totals).map((key) => [key, f.events.reduce((n, event) => n + event.total[key], 0)]),
  );
  assert.deepEqual(sums, f.expected.totals);
  const second = fixture(t);
  f.events[0].total.total = -1;
  f.expected.totals.total = -1;
  assert.equal(second.events[0].total.total, 120);
  assert.equal(second.expected.totals.total, 310);
  const root = f.root;
  f.close();
  f.close();
  assert.equal(existsSync(root), false);
});

test("isolated Codex sources really parse into the four contract events", (t) => {
  const f = fixture(t);
  const result = run(`
    import assert from 'node:assert/strict';
    import { buildUsageReport } from ${JSON.stringify(moduleURL("src/usage-core.js"))};
    const report = await buildUsageReport(${JSON.stringify(f.options)});
    assert.equal(report.events.length, 4);
    const events = report.events.sort((a,b) => a.timestamp.localeCompare(b.timestamp));
    assert.deepEqual(events.map(e => e.detailMask), [15,15,5,0]);
    assert.deepEqual(events.map(e => e.total), ${JSON.stringify(f.events.map((event) => event.total))});
  `);
  assert.equal(result.status, 0, result.stderr);
});

test("ESM records static imports, re-exports and dynamic imports separately in parent and fork", (t) => {
  const f = fixture(t);
  const leaf = path.join(f.root, "leaf.mjs");
  const barrel = path.join(f.root, "barrel.mjs");
  const childFile = path.join(f.root, "child.mjs");
  writeFileSync(leaf, "export const value = 42;\nexport function prepare() { return value; }\n");
  writeFileSync(barrel, "export {value,prepare} from './leaf.mjs';\n");
  writeFileSync(
    childFile,
    "const m = await import('./barrel.mjs'); if (m.prepare() !== 42) throw Error('bad value');\n",
  );
  const probe = createLiteBoundaryProbe(f.root, {
    forbiddenModules: ["src/pricing.js", "src/achievement-runtime.js"],
    calls: [{ module: leaf, name: "projection.prepare", anchor: "export function prepare() {" }],
  });
  const result = run(
    `
    import { fork } from 'node:child_process';
    import { value } from ${JSON.stringify(pathToFileURL(barrel).href)};
    if (value !== 42) throw Error('bad parent value');
    const dynamic = await import(${JSON.stringify(pathToFileURL(leaf).href)});
    if (dynamic.prepare() !== 42) throw Error('bad dynamic value');
    const child = fork(${JSON.stringify(childFile)}, [], { execArgv: [], stdio: 'pipe', windowsHide: true });
    child.stdout.resume(); child.stderr.resume();
    await new Promise((resolve,reject) => {
      child.once('error',reject);
      child.once('exit', code => code === 0 ? resolve() : reject(Error('child failed: '+code)));
    });
  `,
    probe.env,
  );
  assert.equal(result.status, 0, result.stderr);
  const entries = assertFinished(probe);
  const starts = entries.filter((entry) => entry.kind === "start");
  assert.equal(starts.length, 2);
  const parent = starts.find((entry) => entry.role === "parent");
  const child = starts.find((entry) => entry.role === "child");
  assert.equal(child.ppid, parent.pid);
  for (const pid of [parent.pid, child.pid]) {
    assert.ok(
      entries.some((entry) => entry.pid === pid && entry.kind === "load" && entry.url === pathToFileURL(leaf).href),
    );
    assert.ok(
      entries.some(
        (entry) => entry.pid === pid && entry.kind === "resolve" && entry.parentURL === pathToFileURL(barrel).href,
      ),
    );
    assert.equal(probe.count("projection.prepare", pid), 1);
  }
  assert.equal(
    entries.some((entry) => entry.forbidden),
    false,
  );
  assert.equal(probe.count("pricing.event"), 0);
});

for (const child of [false, true]) {
  test(`real forbidden Waifu import fails in the ${child ? "child" : "parent"} process`, (t) => {
    const f = fixture(t);
    const probe = createLiteBoundaryProbe(f.root, { forbiddenModules: ["src/pricing.js"] });
    const load = `await import(${JSON.stringify(`${moduleURL("src/pricing.js")}?boundary=positive`)});`;
    const code = child
      ? `
      import { spawnSync } from 'node:child_process';
      const child = spawnSync(process.execPath, ['--input-type=module','--eval',${JSON.stringify(load)}], {env:process.env,encoding:'utf8',windowsHide:true,timeout:10000});
      if (child.error) throw child.error;
      process.stderr.write(child.stderr);
      process.exitCode = child.status;
    `
      : load;
    const result = run(code, probe.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LITE_BOUNDARY_MODULE/);
    const entries = assertFinished(probe);
    const blocked = entries.filter((entry) => entry.kind === "load" && entry.forbidden);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].role, child ? "child" : "parent");
  });
}

test("real cost and share calls are counted without changing their results", (t) => {
  const f = fixture(t);
  const probe = createLiteBoundaryProbe(f.root, {
    calls: [
      {
        module: "src/pricing.js",
        name: "pricing.accumulator",
        anchor: "export function createCostEstimateAccumulator(options = {}) {",
      },
      { module: "src/pricing.js", name: "pricing.event", anchor: "function estimateEventCost(event = {}) {" },
      {
        module: "public/range-metrics.js",
        name: "share.accumulator",
        anchor: 'export function createRangeMetricsAccumulator(calendarZone = "local", sourceKinds = new Map()) {',
      },
    ],
  });
  const code = `
    import { createCostEstimateAccumulator, estimateEventCost } from ${JSON.stringify(moduleURL("src/pricing.js"))};
    import { createRangeMetricsAccumulator } from ${JSON.stringify(moduleURL("public/range-metrics.js"))};
    createCostEstimateAccumulator();
    const share = createRangeMetricsAccumulator('utc');
    const events = ${JSON.stringify(f.events)};
    for (const event of events) share.add(event);
    console.log(JSON.stringify({ costs:events.map(e=>estimateEventCost(e)), share:share.result() }));
  `;
  const baseline = run(code);
  const observed = run(code, probe.env);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(observed.status, 0, observed.stderr);
  assert.deepEqual(JSON.parse(observed.stdout), JSON.parse(baseline.stdout));
  assert.equal(probe.count("pricing.accumulator"), 1);
  assert.equal(probe.count("pricing.event"), 4);
  assert.equal(probe.count("share.accumulator"), 1);
  assertFinished(probe);
});

test("a real record comparison call trips the function prohibition", (t) => {
  const f = fixture(t);
  const probe = createLiteBoundaryProbe(f.root, {
    forbiddenCalls: ["records.compare"],
    calls: [
      {
        module: "src/usage-record-store.js",
        name: "records.compare",
        anchor: "export function buildStoredRecordChampions(options) {",
      },
    ],
  });
  const result = run(
    `
    import { buildStoredRecordChampions } from ${JSON.stringify(moduleURL("src/usage-record-store.js"))};
    buildStoredRecordChampions({});
  `,
    probe.env,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LITE_BOUNDARY_CALL/);
  assert.equal(probe.count("records.compare"), 1);
  assertFinished(probe);
});

test("achievement initialization, evaluation, preparation and operations reach real call points", (t) => {
  const f = fixture(t);
  const probe = createLiteBoundaryProbe(f.root, {
    calls: [
      {
        module: "src/achievement-runtime.js",
        name: "achievement.runtime",
        anchor: "    this.usageStore = usageStore;",
      },
      {
        module: "src/achievement-store.js",
        name: "achievement.store",
        anchor: "  constructor({ databaseFile, catalog, clock = Date.now, fault = undefined }) {",
      },
      {
        module: "src/achievement-incremental.js",
        name: "achievement.evaluate",
        anchor: "  evaluate({ profile, cutoff, operations, inputKey }, existingAwards) {",
      },
      { module: "src/achievement-foundation.js", name: "achievement.prepare", anchor: "  prepare(options = {}) {" },
      {
        module: "src/achievement-store.js",
        name: "achievement.operation",
        anchor: "  recordOperation({ kind, key, occurredAt, payload }) {",
      },
    ],
  });
  const result = run(
    `
    import assert from 'node:assert/strict';
    import { runtimeFixture, T0 } from ${JSON.stringify(moduleURL("test/fixtures/achievement-runtime-fixture.js"))};
    const cleanup = [];
    try {
      const f = await runtimeFixture({after:close=>cleanup.push(close)});
      await f.runtime.start();
      f.insert({timestamp_ms:T0+1,total:120,input:100,output:20});
      f.setNow(T0+2000);
      assert.equal((await f.runtime.update()).rows.length,42);
      f.runtime.archive.recordOperation({kind:'share',key:'boundary-share',occurredAt:T0+1000,payload:{}});
      assert.equal(f.runtime.archive.readOperations().length,1);
    } finally { for (const close of cleanup.reverse()) await close(); }
  `,
    probe.env,
  );
  assert.equal(result.status, 0, result.stderr);
  for (const name of [
    "achievement.runtime",
    "achievement.store",
    "achievement.evaluate",
    "achievement.prepare",
    "achievement.operation",
  ])
    assert.ok(probe.count(name) > 0, name);
  assertFinished(probe);
});

test("Waifu Hermes evidence prohibition and scoped lifecycle counters stay separate", (t) => {
  const f = fixture(t);
  const probe = createLiteBoundaryProbe(f.root, {
    forbiddenCalls: ["achievement.hermesEvidence"],
    calls: [
      {
        module: "src/achievement-hermes-source.js",
        name: "achievement.hermesEvidence",
        anchor: "export async function streamAchievementHermesEvents(dbFile, source, onEvent, options = {}) {",
      },
    ],
  });
  const result = run(
    `
    import assert from 'node:assert/strict';
    import { streamAchievementHermesEvents } from ${JSON.stringify(moduleURL("src/achievement-hermes-source.js"))};
    await assert.rejects(streamAchievementHermesEvents('unused',{},()=>{}), {code:'LITE_BOUNDARY_CALL'});
  `,
    probe.env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(probe.count("achievement.hermesEvidence"), 1);
  assertFinished(probe);

  const localProbe = createLiteBoundaryProbe(f.root);
  const exitListeners = process.listenerCount("exit");
  const hooks = installLiteBoundaryProbe(localProbe.config);
  try {
    for (const name of [
      "connection.close",
      "lease.release",
      "projection.prepare",
      "achievement.workerRetain",
      "history.sidecar.validate",
    ])
      hooks.call(name);
    assert.equal(localProbe.count("history.sidecar.validate"), 1);
    assert.equal(localProbe.count("achievement.evaluate"), 0, "sidecar validation is separate from runtime evaluation");
  } finally {
    hooks.close();
    hooks.close();
  }
  assert.equal(process.listenerCount("exit"), exitListeners);
});

test("moved or ambiguous source anchors fail instead of producing a false zero", (t) => {
  const f = fixture(t);
  for (const anchor of ["missing body {", "repeat"]) {
    const file = path.join(f.root, "anchors.mjs");
    writeFileSync(file, "// repeat repeat\nexport const value = 1;\n");
    const probe = createLiteBoundaryProbe(f.root, { calls: [{ module: file, name: "guard", anchor }] });
    const result = run(`await import(${JSON.stringify(pathToFileURL(file).href)});`, probe.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Boundary probe anchor moved: guard/);
    assert.equal(probe.count("guard"), 0);
    assertFinished(probe);
  }
});
