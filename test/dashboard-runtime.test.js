import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { createDashboardRuntime } from "../public/dashboard-runtime.js";
import { createDashboardState } from "../public/usage-dashboard-state.js";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function usage(version = "v1", extra = {}) {
  return {
    metadata: { homes: [] },
    summary: { totals: { totalTokens: 123 } },
    fingerprint: `f-${version}`,
    usageVersion: version,
    checkedAt: "2026-11-17T01:00:00Z",
    ...extra,
  };
}

function fixture({ route, hooks = {}, paint = false, stored = null } = {}) {
  const state = createDashboardState();
  let time = Date.parse("2026-11-17T01:00:00Z");
  let sequence = 0;
  const nodes = new Map();
  const listeners = new Map();
  const timers = new Map();
  const frames = new Map();
  const events = [];
  const requests = [];
  const calls = { load: 0, check: 0, query: 0, render: 0, status: 0, imports: 0 };
  const writes = [];
  const document = {
    hidden: !paint,
    activeElement: null,
    querySelector(selector) {
      if (!nodes.has(selector)) {
        const classes = new Set();
        nodes.set(selector, {
          hidden: false,
          disabled: false,
          textContent: "",
          dataset: {},
          value: "",
          classList: {
            toggle(name, on) {
              if (on) classes.add(name);
              else classes.delete(name);
            },
            contains: (name) => classes.has(name),
          },
          attributes: {},
          setAttribute(name, value) {
            this.attributes[name] = value;
          },
          contains: () => false,
          focus() {
            document.activeElement = this;
          },
        });
      }
      return nodes.get(selector);
    },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) {
      listeners.get(name)?.delete(fn);
    },
  };
  const schedule = (callback, ms, interval = false) => {
    const id = ++sequence;
    timers.set(id, { callback, at: time + ms, ms, interval });
    return id;
  };
  const window = {
    setTimeout: (callback, ms) => schedule(callback, ms),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, ms) => schedule(callback, ms, true),
    clearInterval: (id) => timers.delete(id),
    requestAnimationFrame(callback) {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    EventSource: class {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        events.push(this);
      }
      addEventListener(name, fn) {
        this.listeners.set(name, fn);
      }
      emit(name, data) {
        this.listeners.get(name)?.({ data: JSON.stringify(data) });
      }
      close() {
        this.closed = true;
      }
    },
  };
  let runtime;
  const context = {
    state,
    document,
    window,
    now: () => time,
    storage: { getItem: () => stored, setItem: (...args) => writes.push(args) },
    fetch: async (url, init) => {
      requests.push({ url, init });
      const result = await (route?.(url, init) ?? {
        payload: url.startsWith("/api/status")
          ? { changed: false, usageVersion: "v1", checkedAt: "2026-11-17T01:00:00Z" }
          : usage(),
      });
      const status = result.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => result.payload };
    },
    render: () => {
      calls.render++;
    },
    loadUsage: (...args) => {
      calls.load++;
      return runtime.loadUsage(...args);
    },
    checkForUpdates: (...args) => {
      calls.check++;
      return runtime.checkForUpdates(...args);
    },
    usageQuery: (...args) => {
      calls.query++;
      return runtime.usageQuery(...args);
    },
    setAutoRefreshStatus: (...args) => {
      calls.status++;
      return runtime.setAutoRefreshStatus(...args);
    },
    clearQuotaNotice() {},
    reconcileQuotaSourceSelection() {},
    updateQuotaPresetButton() {},
    renderUnavailableQuota(reason) {
      context.unavailable = reason;
    },
    quotaWindowAvailability: () => ({ available: true }),
    isQuotaPreset: (value) => value.startsWith("quota_"),
    pollImportTask: () => {
      calls.imports++;
    },
  };
  runtime = createDashboardRuntime(context, hooks);
  return {
    state,
    runtime,
    context,
    calls,
    requests,
    nodes,
    events,
    timers,
    frames,
    listeners,
    writes,
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > time || !timers.has(id)) continue;
        if (timer.interval) timer.at += timer.ms;
        else timers.delete(id);
        timer.callback();
      }
    },
    paint() {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback();
      }
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("pure runtime executes refresh, freeze, SSE and dispose with exclusive modules forbidden (positive control)", async (t) => {
  const isolated = createLiteEditionFixture();
  t.after(isolated.close);
  const forbiddenModules = [
    "public/i18n.js",
    "public/waifu-locale.js",
    "public/app.js",
    "public/achievement-events.js",
    "public/pricing-models.js",
    "public/share-card-data.js",
    "public/cost-currency.js",
    "public/waifu-timeline.js",
  ];
  const probe = createLiteBoundaryProbe(isolated.root, { forbiddenModules });
  const url = (file) => new URL(`../public/${file}`, import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import {createDashboardRuntime} from ${JSON.stringify(url("dashboard-runtime.js"))};
    import {createDashboardState} from ${JSON.stringify(url("usage-dashboard-state.js"))};
    ${usage.toString()}
    ${fixture.toString()}
    const h=fixture();
    h.runtime.initializeAutoRefresh();
    await h.runtime.loadUsage();
    h.runtime.startAutoRefresh();
    await h.runtime.checkForUpdates();
    h.events[0].emit('usage-synced',{usageVersion:'v1'});
    assert.equal(h.calls.render,1);
    h.runtime.setAutoRefreshEnabled(false);
    await h.runtime.activeUsageLoadDone;
    assert.equal(h.events.at(-1).url,'/api/usage-events?watch=0');
    assert.match(h.requests.at(-1).url,/freeze=1/);
    assert.equal(h.events.at(-1).listeners.has('achievement-state'),false);
    assert.deepEqual(Object.keys(h.state).filter(key=>/pricing|achievement|share|cost|usdToCny/i.test(key)),[]);
    h.runtime.dispose();
    assert.equal(h.timers.size,0);
    assert.equal(h.events.at(-1).closed,true);
    console.log('pure runtime passed');
  `;
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", source], {
    env: probe.env,
    windowsHide: true,
  });
  assert.equal(stdout.trim(), "pure runtime passed");
  assert.equal(probe.read().filter((event) => event.forbidden).length, 0);
  for (const file of ["i18n.js", "pricing-models.js", "achievement-events.js"]) {
    await assert.rejects(
      run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url(file))})`], {
        env: probe.env,
        windowsHide: true,
      }),
      (error) => error.stderr.includes("LITE_BOUNDARY_MODULE"),
    );
  }
  const common = await readFile(new URL("../public/dashboard-runtime.js", import.meta.url), "utf8");
  assert.doesNotMatch(common, /pricing|achievement|preserveShare|costEstimate|usdToCny|shareSummary|更新价格|货币/iu);
});

test("latest filter wins and version confirmation waits for the matching paint through controller wrappers", async (t) => {
  const first = deferred(),
    second = deferred();
  let request = 0;
  const h = fixture({ paint: true, route: () => (++request === 1 ? first.promise : second.promise) });
  t.after(h.runtime.dispose);
  const oldLoad = h.runtime.loadUsage();
  const oldDone = h.runtime.activeUsageLoadDone;
  h.state.preset = "month";
  h.runtime.refreshViewForFilters();
  const currentDone = h.runtime.activeUsageLoadDone;
  let finished = false;
  currentDone.then(() => {
    finished = true;
  });
  second.resolve({ payload: usage("v2") });
  await flush();
  assert.equal(finished, false);
  assert.equal(h.calls.render, 1);
  assert.equal(h.state.lastSuccessfulCheck, null);
  h.paint();
  h.paint();
  await currentDone;
  assert.equal(h.state.lastSuccessfulCheck, "2026-11-17T01:00:00Z");
  first.resolve({ payload: usage("v1") });
  await oldLoad;
  await oldDone;
  assert.equal(h.state.fingerprint, "f-v2");
  assert.equal(h.calls.render, 1);
  assert.equal(h.calls.load, 1, "filter refresh passes through the controller load wrapper");
  assert.ok(h.calls.query >= 4);
  assert.ok(h.calls.status > 0);
});

test("pending retries wake once, retain completion and stop cleanly on dispose", async (t) => {
  let count = 0;
  const h = fixture({
    route: () =>
      ++count === 1 ? { status: 409, payload: { code: "SOURCE_UPDATE_PENDING" } } : { payload: usage("v2") },
  });
  t.after(h.runtime.dispose);
  const load = h.runtime.loadUsage();
  const done = h.runtime.activeUsageLoadDone;
  await flush();
  assert.equal(h.state.runtimeTasks[0].phase, "source-pending");
  assert.equal(h.requests.length, 1);
  h.advance(1000);
  await done;
  await load;
  assert.equal(h.requests.length, 2);
  assert.equal(h.calls.render, 1);
  const waiting = fixture({ route: () => ({ status: 409, payload: { code: "SOURCE_UPDATE_PENDING" } }) });
  const stopped = waiting.runtime.loadUsage();
  const stoppedDone = waiting.runtime.activeUsageLoadDone;
  await flush();
  waiting.runtime.dispose();
  waiting.runtime.dispose();
  await stoppedDone;
  await stopped;
  waiting.advance(60_000);
  await waiting.runtime.loadUsage();
  assert.equal(waiting.requests.length, 1);
  assert.equal(waiting.timers.size, 0);
  assert.equal(waiting.calls.render, 0);
  assert.equal(waiting.state.runtimeTasks.length, 0);
});

test("a pending status check keeps the displayed dashboard until the next publication", async (t) => {
  let locked = false;
  const h = fixture({
    route: () =>
      locked
        ? { status: 409, payload: { code: "SOURCE_UPDATE_PENDING" } }
        : { payload: usage(h.calls.render ? "v2" : "v1") },
  });
  t.after(h.runtime.dispose);
  await h.runtime.loadUsage();
  locked = true;
  const check = h.runtime.checkForUpdates();
  await flush();
  for (let attempt = 0; attempt < 32; attempt++) {
    h.advance(5000);
    await flush();
  }
  assert.equal(h.state.fingerprint, "f-v1");
  assert.deepEqual(h.state.runtimeErrors, []);
  locked = false;
  h.advance(5000);
  await check;
  assert.equal(h.state.fingerprint, "f-v2");
  assert.deepEqual(h.state.runtimeErrors, []);
});

test("SSE reconnect coalesces behind an active load and status confirmation cannot advance an unpainted version", async (t) => {
  const gate = deferred();
  let calls = 0;
  const h = fixture({
    route: (url) =>
      url.startsWith("/api/status")
        ? { payload: { changed: false, usageVersion: "v2", checkedAt: "2026-11-17T01:05:00Z" } }
        : ++calls === 1
          ? gate.promise
          : { payload: usage("v2", { checkedAt: "2026-11-17T01:05:00Z" }) },
  });
  t.after(h.runtime.dispose);
  h.runtime.initializeAutoRefresh();
  const load = h.runtime.loadUsage();
  h.events[0].onopen();
  h.events[0].emit("usage-synced", { usageVersion: "v2" });
  h.events[0].emit("usage-synced", { usageVersion: "v3" });
  gate.resolve({ payload: usage() });
  await load;
  await h.runtime.activeUsageLoadDone;
  assert.equal(calls, 2, "one coalesced follow-up read");
  assert.equal(h.calls.load, 1);
  const before = h.calls.render;
  await h.runtime.checkForUpdates();
  assert.equal(h.calls.render, before);
  assert.equal(h.state.lastSuccessfulCheck, "2026-11-17T01:05:00Z");
  h.runtime.startAutoRefresh();
  h.advance(60_000);
  await flush();
  assert.ok(h.calls.check > 0, "interval calls use the controller check wrapper");
});

test("extension hooks preserve order while completion excludes optional follow-up work", async (t) => {
  const order = [],
    optional = deferred();
  let h;
  h = fixture({
    hooks: {
      onLoadStart: () => order.push("start"),
      onUsage: () => order.push("usage"),
      onError: () => order.push("error"),
      afterUsage() {
        order.push(`after:${h.state.runtimeTasks.length}`);
        return optional.promise;
      },
      onStreamOpen: () => order.push("open"),
      bindStream: () => {
        order.push("bind");
        return () => order.push("unbind");
      },
    },
  });
  t.after(h.runtime.dispose);
  h.runtime.initializeAutoRefresh();
  const load = h.runtime.loadUsage();
  let returned = false;
  load.then(() => {
    returned = true;
  });
  await h.runtime.activeUsageLoadDone;
  assert.equal(returned, false);
  assert.deepEqual(order, ["bind", "start", "usage", "after:0"]);
  optional.resolve();
  await load;
  h.state.autoRefreshEnabled = false;
  h.events[0].onopen();
  assert.equal(order.at(-1), "open");
  h.runtime.closeUsageEventsStream();
  assert.equal(order.at(-1), "unbind");
});

test("dispose releases paint listeners and ignores late reads without loading any extension", async () => {
  const h = fixture({ paint: true });
  const load = h.runtime.loadUsage();
  await flush();
  assert.equal(h.frames.size, 1);
  assert.equal(h.listeners.get("visibilitychange").size, 1);
  h.runtime.dispose();
  await load;
  await h.runtime.activeUsageLoadDone;
  assert.equal(h.frames.size, 0);
  assert.equal(h.listeners.get("visibilitychange").size, 0);
  assert.equal(h.state.lastSuccessfulCheck, null);
  const gate = deferred();
  const late = fixture({ route: () => gate.promise });
  const pending = late.runtime.loadUsage();
  late.runtime.dispose();
  gate.resolve({ payload: usage("late") });
  await pending;
  assert.equal(late.calls.render, 0);
  assert.equal(late.state.summary, null);
});

test("expired snapshots refreeze, quota failures stay local and load errors use the explicit hook", async (t) => {
  const errors = [];
  let count = 0;
  const h = fixture({
    route: () =>
      ++count === 1
        ? { status: 410, payload: { code: "SNAPSHOT_EXPIRED" } }
        : { payload: usage("frozen", { snapshotId: "replacement" }) },
    hooks: { onError: (error, options) => errors.push({ error, options }) },
  });
  t.after(h.runtime.dispose);
  h.state.autoRefreshEnabled = false;
  h.state.snapshotId = "expired";
  await h.runtime.loadUsage({ skipCheck: true });
  await h.runtime.activeUsageLoadDone;
  assert.match(h.requests[0].url, /snapshot=expired/);
  assert.match(h.requests[1].url, /freeze=1/);
  assert.equal(h.state.snapshotId, "replacement");
  assert.equal(errors.length, 0, "automatic snapshot recovery does not report a failed range");
  const quota = fixture({
    route: () => ({ status: 413, payload: { quota: { marker: "latest" }, message: "too many" } }),
    hooks: { onError: (error, options) => errors.push({ error, options }) },
  });
  t.after(quota.runtime.dispose);
  quota.state.preset = "quota_5h";
  await quota.runtime.loadUsage({ preserveView: true });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.status, 413);
  assert.equal(errors[0].options.preserveView, true);
  assert.equal(quota.state.summary, null);
  assert.equal(quota.state.quotaSnapshot.marker, "latest");
  assert.equal(quota.state.runtimeErrors[0].message, "限额统计暂不可用");
  assert.equal(quota.calls.render, 0);
  assert.ok(quota.context.unavailable);
});
