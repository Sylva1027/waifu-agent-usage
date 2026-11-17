import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { createUsageExecutor } from "../src/usage-executor.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

const FILTERS = { preset: "all", bucket: "day", calendarZone: "utc", now: new Date("2026-10-04T14:00:00Z") };
const context = (requestId, kind = "statistics", shared = false) => ({ requestId, kind, shared });
const terminal = (event) => event.state === "done" || event.state === "failed";

function assertSettled(events, state) {
  assert.equal(events[0].state, "queued", "queued is registered before waiting for the child");
  assert.equal(events.at(-1).state, state);
  assert.equal(events.filter(terminal).length, 1, "each request settles exactly once");
  for (const event of events) {
    assert.equal(event.id, events[0].id);
    assert.match(event.id, /^executor:[\da-f-]+:\d+$/);
    assert.equal(event.requestId, events[0].requestId);
    assert.equal(event.shared, events[0].shared);
    assert.equal(event.kind, events[0].kind);
  }
  for (let index = 1; index < events.length; index++) {
    assert.notDeepEqual(
      [events[index].state, events[index].phase],
      [events[index - 1].state, events[index - 1].phase],
      "consecutive duplicate phases are not published",
    );
  }
}

function realExecutor(t, observer = () => {}) {
  const input = createCodexIntegrationFixture();
  const events = [],
    stages = [];
  const client = createUsageExecutor(input.serverOptions, {
    onActivity: (event) => {
      events.push(event);
      return observer(event);
    },
    onImportStage: (stage) => stages.push(stage),
  });
  const release = client.retainWorker();
  t.after(async () => {
    release();
    await client.close();
    input.close();
  });
  return { client, input, events, stages, release };
}

test("real child preserves async request context, import hooks and operation phases", async (t) => {
  const f = realExecutor(t);
  const syncing = f.client.runWithActivity(context(null, "import", true), () =>
    f.client.sync({ options: f.input.serverOptions }),
  );
  assert.equal(f.events[0].state, "queued", "the first event is synchronous");
  const status = await syncing;
  assert.ok(status.fingerprint);
  assertSettled(f.events, "done");
  assert.deepEqual(f.stages, ["reading", "statistics"], "original onImportStage remains available");
  assert.deepEqual(
    f.events.map((event) => event.phase),
    ["queued", "checking", "reading", "statistics", "settling", "settling"],
  );
  assert.ok(f.events.every((event) => event.shared && event.requestId === null && event.kind === "import"));
  f.events.length = 0;
  const left = f.client.runWithActivity(context("pageA:1"), async () => {
    await Promise.resolve();
    return f.client.dashboard(FILTERS);
  });
  const right = f.client.runWithActivity(context("pageB:1", "pricing"), async () => {
    await Promise.resolve();
    return f.client.periodComparison(FILTERS);
  });
  const [dashboard, comparison] = await Promise.all([left, right]);
  assert.ok(dashboard.summary);
  assert.ok(comparison.totals);
  for (const requestId of ["pageA:1", "pageB:1"]) {
    const events = f.events.filter((event) => event.requestId === requestId);
    assertSettled(events, "done");
    assert.ok(events.some((event) => event.state === "running" && event.phase === "statistics"));
    assert.ok(events.every((event) => !event.shared));
    assert.equal(events[0].kind, requestId === "pageA:1" ? "statistics" : "pricing");
  }
  assert.equal(new Set(f.events.filter(terminal).map((event) => event.id)).size, 2);
  assert.ok(!JSON.stringify(f.client.stateSnapshot()).includes("pageA:1"), "observation never enters published data");
  f.events.length = 0;
  await assert.rejects(
    f.client.runWithActivity(context("failed-snapshot"), () =>
      f.client.snapshot({ databaseFile: path.join(f.input.codexHome, "missing", "copy.sqlite") }),
    ),
    (error) => {
      assert.equal(f.events.at(-1).error.code, error.code);
      assert.equal(f.events.at(-1).error.message, error.message);
      return true;
    },
  );
  assertSettled(f.events, "failed");
});

test("activity observers do not retain an idle child, even when their promises never settle", {
  timeout: 5_000,
}, async (t) => {
  const fork = childProcess.fork;
  const exited = Promise.withResolvers();
  t.mock.method(childProcess, "fork", (...args) => {
    const child = fork(...args);
    child.once("exit", exited.resolve);
    return child;
  });
  syncBuiltinESMExports();
  const f = realExecutor(t, () => new Promise(() => {}));
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  f.release();
  await f.client.open();
  assertSettled(f.events, "done");
  await exited.promise;
  assert.equal(f.client.alive, false);
});

test("separate executor instances and recovered children have distinct task identities", async (t) => {
  const first = realExecutor(t),
    second = realExecutor(t);
  await first.client.runWithActivity(context("first"), () => first.client.open());
  await second.client.runWithActivity(context("second"), () => second.client.open());
  const firstId = first.events[0].id;
  assert.notEqual(firstId, second.events[0].id);
  await first.client.crashWorkerForTest();
  first.events.length = 0;
  await first.client.runWithActivity(context("recovered"), () => first.client.open());
  assert.notEqual(first.events[0].id.split(":")[1], firstId.split(":")[1]);
  assertSettled(first.events, "done");
  assert.equal(first.client.restarts, 1);
});

test("throwing and rejecting observers cannot change real child results", async (t) => {
  const f = realExecutor(t, (event) => {
    if (event.state === "running") return Promise.reject(new Error("observer rejected"));
    throw new Error("observer threw");
  });
  assert.deepEqual(await f.client.open(), { opened: true });
  assertSettled(f.events, "done");
});

test("real initialization failure settles the queued activity", async (t) => {
  const input = createCodexIntegrationFixture();
  const events = [];
  const client = createUsageExecutor(
    { ...input.serverOptions, databaseFile: input.codexHome },
    {
      onActivity: (event) => events.push(event),
    },
  );
  t.after(async () => {
    await client.close();
    input.close();
  });
  await assert.rejects(
    client.runWithActivity(context("bad-open"), () => client.open()),
    (error) => {
      assert.equal(events.at(-1).error.code, error.code);
      assert.equal(events.at(-1).error.message, error.message);
      return true;
    },
  );
  assertSettled(events, "failed");
  assert.equal(
    events.some((event) => event.state === "running"),
    false,
  );
});

function fakeExecutor(t, fail) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () =>
    queueMicrotask(() => {
      child.signalCode = "SIGKILL";
      child.emit("exit");
    });
  child.send = (message, callback) => {
    if (message.type === "init") {
      if (fail === "init-send") throw new Error("init send failed");
      queueMicrotask(() => child.emit("message", { type: "ready" }));
    } else if (message.type === "close") {
      queueMicrotask(() => {
        child.emit("message", { type: "response", id: message.id, ok: true });
        child.exitCode = 0;
        child.emit("exit");
      });
    } else fail(child, message, callback);
  };
  t.mock.method(childProcess, "fork", () => {
    if (fail === "spawn") throw new Error("spawn failed");
    return child;
  });
  syncBuiltinESMExports();
  const events = [];
  const client = createUsageExecutor({}, { requestTimeoutMs: 20_000, onActivity: (event) => events.push(event) });
  const release = client.retainWorker();
  t.after(async () => {
    release();
    await client.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { client, child, events };
}

for (const [name, fail, code] of [
  ["spawn", "spawn", "EXECUTOR_UNAVAILABLE"],
  ["init send", "init-send", "EXECUTOR_UNAVAILABLE"],
  [
    "send throw",
    () => {
      throw new Error("send failed");
    },
    "EXECUTOR_UNAVAILABLE",
  ],
  ["send callback", (_child, _message, callback) => callback(new Error("send failed")), "EXECUTOR_UNAVAILABLE"],
  [
    "fatal",
    (child) => child.emit("message", { type: "fatal", error: { code: "TEST_INIT", message: "fatal" } }),
    "TEST_INIT",
  ],
  ["error", (child) => child.emit("error", new Error("child failed")), "EXECUTOR_EXITED"],
  ["exit", (child) => child.emit("exit"), "EXECUTOR_EXITED"],
]) {
  test(`${name} settles activity once without accepting later progress`, async (t) => {
    const f = fakeExecutor(t, fail);
    await assert.rejects(
      f.client.runWithActivity(context("fault"), () => f.client.open()),
      { code },
    );
    assertSettled(f.events, "failed");
    assert.equal(f.events.at(-1).error.code, code);
    assert.ok(f.events.at(-1).error.message);
    const before = [...f.events];
    f.child.emit("message", { type: "activity", id: 1, state: "running", phase: "statistics" });
    f.child.emit("message", { type: "response", id: 1, ok: true, result: "late" });
    assert.deepEqual(f.events, before);
  });
}

test("timeout rejects every pending task; late child progress cannot revive them", async (t) => {
  const dispatched = Promise.withResolvers();
  const f = fakeExecutor(t, (child, message) => {
    child.emit("message", { type: "activity", id: message.id, state: "running", phase: "statistics" });
    if (message.id === 2) dispatched.resolve();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const work = Promise.allSettled([
    f.client.runWithActivity(context("timeoutA"), () => f.client.open()),
    f.client.runWithActivity(context("timeoutB"), () => f.client.open()),
  ]);
  await dispatched.promise;
  t.mock.timers.tick(20_000);
  const results = await work;
  assert.ok(results.every((row) => row.status === "rejected" && row.reason.code === "EXECUTOR_TIMEOUT"));
  for (const requestId of ["timeoutA", "timeoutB"]) {
    const events = f.events.filter((event) => event.requestId === requestId);
    assertSettled(events, "failed");
    assert.equal(events.at(-1).error.code, "EXECUTOR_TIMEOUT");
  }
  const before = [...f.events];
  f.child.emit("message", { type: "activity", id: 1, state: "running", phase: "reading" });
  assert.deepEqual(f.events, before);
  t.mock.timers.reset();
});
