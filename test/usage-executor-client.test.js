import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";

const exec = promisify(execFile);
const forbiddenModules = [
  "src/usage-store.js",
  "src/usage-core.js",
  "src/usage-sources.js",
  "src/service-tier-evidence.js",
  ...readdirSync(new URL("../src/", import.meta.url))
    .filter((file) => /^(pricing(?:-.*)?|achievement-.*)\.js$/.test(file))
    .map((file) => `src/${file}`),
];
const entry = new URL("../src/usage-executor-client.js", import.meta.url).href;

test("the communication client imports without store, source or Waifu implementations", async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const probe = createLiteBoundaryProbe(fixture.root, { forbiddenModules });
  const { stdout } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const {default:assert}=await import('node:assert/strict');
    const {createUsageExecutorClient}=await import(${JSON.stringify(entry)});
    const client=createUsageExecutorClient({}, {workerFile:new URL('file:///unused-worker.js')});
    if(client.alive) throw new Error('client spawned without a request');
    assert.equal('serviceTierEvidence' in client, false);
    assert.equal(Object.hasOwn(client.stateSnapshot(), 'serviceTierEvidence'), false);
    assert.equal(Object.hasOwn(client.state, 'serviceTierEvidence'), false);
    client.restoreState({state:{checkedAt:'restored'}});
    assert.equal(client.checkedAt, 'restored');
    assert.equal(Object.hasOwn(client.state, 'serviceTierEvidence'), false);
    await client.close();
    console.log('closed');
  `,
    ],
    { env: probe.env, windowsHide: true },
  );
  assert.equal(stdout.trim(), "closed");
  assert.ok(probe.read().some((event) => event.kind === "load" && event.url === entry));
  assert.equal(probe.read().filter((event) => event.forbidden).length, 0);
  for (const file of ["usage-executor-waifu.js", "service-tier-evidence.js"]) {
    const url = new URL(`../src/${file}`, import.meta.url).href;
    await assert.rejects(
      exec(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`], {
        env: probe.env,
        windowsHide: true,
      }),
      (error) => error.stderr.includes("LITE_BOUNDARY_MODULE"),
    );
  }
  assert.ok(probe.read().some((event) => event.kind === "load" && event.forbidden));
});

test("the pure client preserves public state across IPC, freeze, idle and crash without Waifu fields", async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const workerFile = path.join(fixture.root, "pure-worker.mjs");
  writeFileSync(
    workerFile,
    `
    let initialState, state;
    process.on('disconnect', () => process.exit(0));
    process.on('message', (message) => {
      if (message.type === 'init') {
        initialState = message.state;
        state = {...initialState};
        process.send({type:'state', state});
        process.send({type:'ready'});
      } else if (message.type === 'idleClose') {
        process.send({type:'idle-exit'}, () => process.disconnect());
      } else {
        if (message.type === 'publish') {
          Object.assign(state, message.state);
          process.send({type:'state', state:message.state});
        }
        const result = message.type === 'snapshot' ? state : {initialState, message};
        process.send({type:'response', id:message.id, ok:true, result}, () => {
          if (message.type === 'close') process.disconnect();
        });
      }
    });
  `,
  );
  const probe = createLiteBoundaryProbe(fixture.root, { forbiddenModules });
  const scenarioFile = path.join(fixture.root, "pure-client.mjs");
  writeFileSync(
    scenarioFile,
    `
    import assert from 'node:assert/strict';
    import {setTimeout as delay} from 'node:timers/promises';
    const {createUsageExecutorClient}=await import(${JSON.stringify(entry)});
    const client=createUsageExecutorClient({}, {
      workerFile:new URL(${JSON.stringify(pathToFileURL(workerFile).href)}),
      idleTimeoutMs:20,
      requestTimeoutMs:5000,
    });
    const publicOnly = (value) => {
      const json=JSON.stringify(value);
      for (const key of ['serviceTierEvidence', 'pricing', 'achievements', 'costEstimate'])
        assert.equal(json.includes('"'+key+'"'), false, key);
    };
    try {
      client.restoreState({state:{
        status:{fingerprint:'public-state'},
        homes:[{id:'home'}],
        warnings:[{code:'PUBLIC_WARNING'}],
        quotaSourceEvidenceSnapshot:{formatVersion:1, entries:[]},
        checkedAt:'restored',
      }});
      const restored=client.stateSnapshot();
      const frozen={...restored, calendarContext:{timeZone:'UTC'}};
      const opened=await client.open({frozen});
      assert.deepEqual(opened.initialState, restored);
      assert.deepEqual(opened.message.frozen, frozen);
      publicOnly(opened);
      await client.request('publish', {state:{checkedAt:'published'}});
      assert.equal(client.checkedAt, 'published');
      const snapshot=await client.snapshot();
      assert.deepEqual(snapshot, client.stateSnapshot());
      publicOnly(snapshot);
      const deadline=Date.now()+5000;
      while(client.alive) {
        assert.ok(Date.now()<deadline, 'worker did not retire');
        await delay(10);
      }
      assert.deepEqual(client.stateSnapshot(), snapshot);
      const reopened=await client.open({frozen:snapshot});
      assert.deepEqual(reopened.initialState, snapshot);
      publicOnly(reopened);
      assert.equal(client.restarts, 0);
      assert.equal(await client.crashWorkerForTest(), true);
      assert.equal(client.status, null);
      assert.equal(client.checkedAt, null);
      publicOnly(client.state);
      const recovered=await client.open();
      assert.equal(client.restarts, 1);
      assert.equal(recovered.initialState.status, null);
      publicOnly(recovered);
      const closing=client.close();
      assert.equal(client.close(), closing);
      await closing;
      await assert.rejects(client.open(), {code:'EXECUTOR_UNAVAILABLE'});
      console.log('public IPC closed');
    } finally {
      await client.close();
    }
  `,
  );
  const { stdout } = await exec(process.execPath, [scenarioFile], {
    env: probe.env,
    windowsHide: true,
    timeout: 20000,
  });
  assert.equal(stdout.trim(), "public IPC closed");
  const events = probe.read();
  assert.equal(events.filter((event) => event.forbidden).length, 0);
  assert.ok(events.some((event) => event.role === "parent" && event.kind === "load" && event.url === entry));
  const children = events.filter(
    (event) => event.role === "child" && event.kind === "load" && event.url === pathToFileURL(workerFile).href,
  );
  assert.equal(new Set(children.map((event) => event.pid)).size, 3);
});
