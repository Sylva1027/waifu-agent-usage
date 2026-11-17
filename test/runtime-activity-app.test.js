import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

process.env.U4_HARNESS_ONLY = "1";
const { createCycleHarness, createRouter, loadRecordedPayloads } = await import("./app-autorefresh.test.js");

class Events {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    Events.instances.push(this);
  }
  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }
  emit(name, data) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

async function fixture(options = {}) {
  Events.instances = [];
  const payloads = await loadRecordedPayloads();
  payloads.today.usageVersion = "v1";
  const router = createRouter({
    payloads,
    status: () => ({ payload: { changed: false, usageVersion: "v1", checkedAt: payloads.today.checkedAt } }),
    usage: () => ({ payload: payloads.today }),
    ...options.router,
  });
  const harness = await createCycleHarness({ response: router, EventSource: Events, ...options.harness });
  return { harness, payload: payloads.today };
}

const busy = (h) => h.dom.byId.get("autoRefreshSpinner").classList.contains("is-loading");
const text = (h) => h.dom.byId.get("runtimeStatusText").textContent;
const run = (h, code) => vm.runInContext(code, h.context);
function runtimeClock(h) {
  h.context.__runtimeNow = Date.now();
  run(h, "globalThis.Date = class extends Date { static now() { return globalThis.__runtimeNow; } };");
  return (ms = 1100) => {
    h.context.__runtimeNow += ms;
    const timers = h.timers.timeouts.filter((timer) => !timer.cleared && timer.ms <= ms);
    for (const timer of timers) {
      timer.cleared = true;
      timer.callback();
    }
  };
}
const snapshot = (tasks = [], errors = [], revision = 1, epoch = "server-1") => ({ epoch, revision, tasks, errors });
const remote = (id, extra = {}) => ({
  id,
  requestId: null,
  shared: true,
  kind: "sync",
  phase: "reading",
  state: "running",
  ...extra,
});

test("state observation starts before the first usage response and passive reconnect never checks or loads", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { harness: h, payload } = await fixture({
    harness: { storage: { codexUsageAutoRefresh: "off" } },
    router: { usage: () => gate },
  });
  try {
    const source = Events.instances[0];
    assert.equal(source.url, "/api/usage-events?watch=0");
    assert.equal(busy(h), true);
    assert.equal(h.dom.byId.get("autoRefreshSpinner").getAttribute("aria-hidden"), "true");
    assert.equal(text(h), "正在加载数据…");
    assert.ok(h.fetchLog.find((r) => r.path === "/api/usage").requestId);
    const before = h.fetchLog.length;
    source.onopen();
    source.emit("ready", {});
    source.emit("activity-state", snapshot([remote("shared")]));
    source.emit("usage-synced", { usageVersion: "v2" });
    assert.equal(h.fetchLog.length, before);
    release({ payload: { ...payload, snapshotId: "frozen" } });
    await h.settle();
    assert.equal(h.state.snapshotId, "frozen");
    source.onerror();
    assert.equal(text(h), "自动刷新已暂停");
    assert.equal(busy(h), false);
    assert.equal(h.state.snapshotId, "frozen");
  } finally {
    release({ payload });
    await h.settle();
    h.dispose();
  }
});

test("snapshots replace tasks, ignore other pages, order revisions within epochs and recover after disconnect", async () => {
  const { harness: h } = await fixture();
  try {
    await h.settle();
    const advance = runtimeClock(h);
    const source = Events.instances[0];
    source.emit("activity-state", snapshot([remote("a")], [], 5));
    assert.equal(busy(h), false);
    advance();
    assert.equal(text(h), "正在同步数据…");
    source.emit("activity-state", snapshot([], [], 4));
    assert.equal(busy(h), true);
    source.emit(
      "activity-state",
      snapshot([remote("foreign", { shared: false, requestId: "other-page", kind: "statistics" })], [], 1, "server-2"),
    );
    assert.equal(busy(h), false);
    source.emit("activity-state", snapshot([remote("b")], [], 2, "server-2"));
    source.onerror();
    assert.equal(busy(h), false);
    source.onopen();
    await h.settle();
    source.emit("activity-state", snapshot([remote("c", { kind: "pricing", phase: "unknown" })], [], 1, "server-3"));
    assert.equal(text(h), "正在更新价格…");
    source.emit("activity-state", snapshot([], [], 2, "server-3"));
    assert.equal(text(h), "就绪");
  } finally {
    h.dispose();
  }
});

test("local user work preempts shared work, coalesces phases, and stale completion cannot end the new load", async () => {
  const gates = [];
  let pending = false;
  const { harness: h, payload } = await fixture({
    router: {
      usage: ({ payloads }) => (pending ? new Promise((resolve) => gates.push(resolve)) : { payload: payloads.today }),
    },
  });
  try {
    await h.settle();
    pending = true;
    const source = Events.instances[0];
    source.emit("activity-state", snapshot([remote("sync")]));
    const old = h.api.loadUsage({ skipCheck: true });
    const oldId = h.fetchLog.at(-1).requestId;
    assert.equal(text(h), "正在计算统计…");
    source.emit(
      "activity-state",
      snapshot([remote("old", { shared: false, requestId: oldId, phase: "reading" })], [], 2),
    );
    assert.equal(text(h), "正在计算统计…");
    const current = h.api.loadUsage({ skipCheck: true });
    const currentId = h.fetchLog.at(-1).requestId;
    assert.notEqual(currentId, oldId);
    gates[0]({ status: 500, payload: { error: "stale failure" } });
    await old;
    assert.equal(busy(h), true);
    assert.equal(h.dom.byId.get("autoRefreshError").hidden, true);
    source.emit(
      "activity-state",
      snapshot([remote("current", { shared: false, requestId: currentId, phase: "dashboard" })], [], 3),
    );
    assert.equal(text(h), "正在计算统计…");
    const timer = h.timers.timeouts.findLast((t) => !t.cleared && t.ms <= 1000);
    timer.callback();
    assert.equal(text(h), "正在更新看板…");
    gates[1]({ payload });
    await current;
    assert.equal(busy(h), false, "completed request must retire late server activity");
    assert.equal(text(h), "就绪");
  } finally {
    for (const resolve of gates) resolve({ payload });
    await h.settle();
    h.dispose();
  }
});

test("relative clock runs locally while paused without fetching or rendering", async () => {
  const { harness: h } = await fixture({ harness: { storage: { codexUsageAutoRefresh: "off" } } });
  try {
    await h.settle();
    h.resetCounts();
    const before = h.fetchLog.length;
    const clock = h.activeIntervals(60_000).find((t) => t.id === h.state.relativeTimeTimer);
    assert.ok(clock);
    clock.callback();
    for (const handler of h.dom.document.__listeners.get("visibilitychange") || []) handler();
    await h.flush();
    assert.equal(h.fetchLog.length, before);
    assert.equal(h.counts.renders, 0);
  } finally {
    h.dispose();
  }
});

test("same-kind retry clears its own error but heartbeat success leaves unrelated errors intact", async () => {
  const { harness: h } = await fixture();
  try {
    await h.settle();
    run(
      h,
      'globalThis.failedImport = beginRuntimeTask("import", { user: true }); finishRuntimeTask(failedImport, new Error("import failed"));',
    );
    await h.api.checkForUpdates();
    assert.match(h.dom.byId.get("autoRefreshErrorText").value, /import failed/);
    run(h, 'globalThis.retryImport = beginRuntimeTask("import", { user: true });');
    assert.equal(h.dom.byId.get("autoRefreshError").hidden, true);
    assert.equal(busy(h), true);
    run(h, "finishRuntimeTask(retryImport);");
    assert.equal(text(h), "就绪");
  } finally {
    h.dispose();
  }
});

test("changed checks commit trusted time after the matching version paints; filters keep that time", async () => {
  let changed = false;
  let release;
  const checkedAt = "2026-11-16T01:02:03Z";
  const { harness: h, payload } = await fixture({
    router: {
      status: ({ payloads }) => ({
        payload: {
          changed,
          usageVersion: changed ? "v2" : "v1",
          checkedAt: changed ? checkedAt : payloads.today.checkedAt,
        },
      }),
      usage: ({ payloads }) =>
        changed
          ? new Promise((resolve) => {
              release = resolve;
            })
          : { payload: payloads.today },
    },
  });
  try {
    await h.settle();
    const previous = h.state.lastSuccessfulCheck;
    const frames = [];
    h.context.window.requestAnimationFrame = (callback) => {
      frames.push(callback);
      return frames.length;
    };
    changed = true;
    const check = h.api.checkForUpdates();
    await h.flush();
    assert.equal(h.state.lastSuccessfulCheck, previous);
    assert.equal(busy(h), true);
    release({ payload: { ...payload, usageVersion: "v2", checkedAt: "2026-11-16T01:02:00Z" } });
    await h.flush();
    assert.equal(busy(h), true, "synchronous render is still before paint");
    assert.equal(h.state.lastSuccessfulCheck, previous);
    frames.shift()();
    await h.flush();
    assert.equal(busy(h), true);
    frames.shift()();
    await check;
    assert.equal(h.state.lastSuccessfulCheck, checkedAt);
    assert.equal(busy(h), false);
    const filtering = h.api.loadUsage({ skipCheck: true });
    release({ payload: { ...payload, usageVersion: "v2", checkedAt: "2026-11-16T02:00:00Z" } });
    await h.flush();
    frames.shift()();
    frames.shift()();
    await filtering;
    assert.equal(h.state.lastSuccessfulCheck, checkedAt);
  } finally {
    h.dispose();
  }
});

test("unchanged status with a different version still loads before committing time", async () => {
  let changedVersion = false;
  let release;
  const checkedAt = "2026-11-16T03:00:00Z";
  const { harness: h, payload } = await fixture({
    router: {
      status: ({ payloads }) => ({
        payload: {
          changed: false,
          usageVersion: changedVersion ? "v2" : "v1",
          checkedAt: changedVersion ? checkedAt : payloads.today.checkedAt,
        },
      }),
      usage: ({ payloads }) =>
        changedVersion
          ? new Promise((resolve) => {
              release = resolve;
            })
          : { payload: payloads.today },
    },
  });
  try {
    await h.settle();
    const previous = h.state.lastSuccessfulCheck;
    changedVersion = true;
    const checking = h.api.checkForUpdates();
    await h.flush();
    assert.equal(h.state.lastSuccessfulCheck, previous);
    assert.equal(busy(h), true);
    release({ payload: { ...payload, usageVersion: "v2", checkedAt } });
    await checking;
    assert.equal(h.state.lastSuccessfulCheck, checkedAt);
    assert.equal(busy(h), false);
  } finally {
    h.dispose();
  }
});

test("pending publication does not advance time and an unchanged completed check settles it", async () => {
  let pending = false;
  const checkedAt = "2026-11-16T04:00:00Z";
  const { harness: h } = await fixture({
    router: {
      status: () => ({ payload: { changed: false, usageVersion: "v1", updatePending: false, checkedAt } }),
      usage: ({ payloads }) => ({
        payload: {
          ...payloads.today,
          updatePending: pending,
          checkedAt: pending ? checkedAt : payloads.today.checkedAt,
        },
      }),
    },
  });
  try {
    await h.settle();
    const previous = h.state.lastSuccessfulCheck;
    pending = true;
    await h.api.loadUsage();
    assert.equal(h.state.lastSuccessfulCheck, previous);
    assert.equal(busy(h), true);
    await h.api.checkForUpdates();
    assert.equal(h.state.lastSuccessfulCheck, checkedAt);
    assert.equal(busy(h), false);
  } finally {
    h.dispose();
  }
});

for (const manual of [false, true]) {
  test(`paused ${manual ? "local manual" : "passive foreign"} import ${manual ? "applies its result" : "preserves the frozen result"}`, async () => {
    let importTask = null;
    const ready = {
      id: "import-test",
      status: "ready",
      stage: "dashboard",
      startedAt: Date.now(),
      sourceVersion: "source-v2",
      sourceIds: ["fixture-codex"],
      count: 1,
    };
    const { harness: h } = await fixture({
      harness: { storage: { codexUsageAutoRefresh: "off" } },
      router: {
        extra: {
          "/api/imports": ({ request }) => {
            if (request.init?.method === "POST") importTask = ready;
            return { payload: { importTask } };
          },
        },
        usage: ({ payloads }) => ({
          payload: {
            ...payloads.today,
            snapshotId: importTask ? null : "frozen-v1",
            sourceVersion: importTask ? "source-v2" : "source-v1",
            metadata: {
              ...payloads.today.metadata,
              homes: payloads.today.metadata.homes.map((home) => ({ ...home, eventCount: 1 })),
            },
            summary: {
              ...payloads.today.summary,
              totals: { ...payloads.today.summary.totals, total: importTask ? 2200 : 1100 },
            },
          },
        }),
      },
    });
    try {
      await h.settle();
      h.resetCounts();
      const message = h.dom.byId.get("importMessage");
      Object.defineProperty(message, "lastElementChild", { get: () => message.children.at(-1) || null });
      if (manual) {
        h.dom.byId.get("manualImportArea").hidden = false;
        h.dom.byId.get("importPath").value = "/new/record/directory";
        await h.context.submitImportDirectory({ preventDefault() {} });
        await h.settle();
        assert.equal(h.state.summary.totals.total, 2200);
        assert.equal(h.counts.usageSyncs, 1);
        assert.equal(h.state.runtimeErrors.length, 0);
        const post = h.fetchLog.findLast((request) => request.path === "/api/imports" && request.requestId);
        const usage = h.fetchLog.findLast((request) => request.path === "/api/usage");
        assert.equal(usage.requestId, post.requestId);
        assert.match(message.textContent, /已导入/);
      } else {
        importTask = ready;
        await h.context.pollImportTask();
        assert.equal(h.state.snapshotId, "frozen-v1");
        assert.equal(h.state.summary.totals.total, 1100);
        assert.equal(h.counts.usageSyncs, 0);
      }
      assert.equal(h.state.autoRefreshEnabled, false);
      assert.equal(h.counts.statusChecks, 0, "import observation must not poll the source-checking status endpoint");
      assert.equal(busy(h), false);
      assert.equal(text(h), "自动刷新已暂停");
    } finally {
      h.dispose();
    }
  });
}

test("pricing save keeps the dialog and error details when its statistics reload fails", async () => {
  let saved = false;
  const { harness: h } = await fixture({
    router: {
      extra: {
        "/api/pricing": ({ request }) => {
          if (request.init?.method === "PUT") saved = true;
          return { payload: {} };
        },
      },
      usage: ({ payloads }) =>
        saved ? { status: 500, payload: { error: "statistics failed after save" } } : { payload: payloads.today },
    },
  });
  try {
    await h.settle();
    const summary = h.state.summary;
    h.state.pricingCatalog = { version: 1, models: {} };
    h.dom.byId.get("usdToCnyRate").value = "6.72";
    h.dom.byId.get("pricingDialog").hidden = false;
    await h.context.submitPricing({ preventDefault() {} });
    assert.equal(saved, true);
    assert.equal(h.dom.byId.get("pricingDialog").hidden, false);
    assert.equal(h.dom.byId.get("autoRefreshError").hidden, false);
    assert.match(h.dom.byId.get("autoRefreshErrorText").value, /statistics failed after save/);
    assert.match(h.dom.byId.get("pricingMessage").textContent, /保存失败/);
    assert.equal(h.state.summary, summary);
    assert.equal(busy(h), false);
    assert.equal(h.dom.byId.get("savePricingButton").disabled, false);
  } finally {
    h.dispose();
  }
});

test("background waiting stays in one sync operation and unrelated completion cannot flush a user phase", async () => {
  const { harness: h } = await fixture();
  try {
    await h.settle();
    const advance = runtimeClock(h);
    Events.instances[0].emit(
      "activity-state",
      snapshot([remote("source-pending", { phase: "settling", state: "queued" })]),
    );
    advance();
    assert.equal(text(h), "正在同步数据…");
    run(
      h,
      'globalThis.prices = beginRuntimeTask("pricing"); globalThis.userTask = beginRuntimeTask("statistics", { user: true }); updateRuntimeTask(userTask, "reading");',
    );
    assert.equal(text(h), "正在计算统计…");
    run(h, "finishRuntimeTask(prices);");
    assert.equal(text(h), "正在计算统计…");
    run(h, 'updateRuntimeTask(userTask, "settling"); updateRuntimeTask(userTask, "dashboard");');
    const timer = h.timers.timeouts.findLast((t) => !t.cleared && t.ms <= 1000);
    timer.callback();
    assert.equal(text(h), "正在更新看板…", "only the latest stage is displayed");
    Events.instances[0].emit("activity-state", snapshot([], [], 2));
    run(h, "finishRuntimeTask(userTask);");
    assert.equal(busy(h), false);
  } finally {
    h.dispose();
  }
});

test("short watcher checks remain silent while long checks become one continuous sync operation", async () => {
  const { harness: h } = await fixture();
  try {
    await h.settle();
    const advance = runtimeClock(h);
    const source = Events.instances[0];
    let revision = 1;
    for (let index = 0; index < 6; index++) {
      source.emit("activity-state", snapshot([remote(`probe-${index}`, { phase: "checking" })], [], revision++));
      advance(400);
      assert.equal(busy(h), false, "a subsecond watcher probe must not flash a spinner");
      assert.equal(text(h), "就绪");
      source.emit("activity-state", snapshot([], [], revision++));
      advance(1100);
      assert.equal(busy(h), false, "a finished probe cannot reappear through a delayed callback");
    }
    source.emit("activity-state", snapshot([remote("long", { phase: "checking" })], [], revision++));
    advance();
    assert.equal(text(h), "正在检查更新…");
    assert.equal(busy(h), true);
    source.emit("activity-state", snapshot([remote("long"), remote("parent", { phase: "checking" })], [], revision++));
    advance();
    assert.equal(text(h), "正在同步数据…");
    source.emit("activity-state", snapshot([remote("parent", { phase: "checking" })], [], revision++));
    advance();
    assert.equal(text(h), "正在同步数据…", "cleanup cannot regress an active sync back to checking");
    source.emit("activity-state", snapshot([], [], revision++));
    assert.equal(text(h), "就绪");
    assert.equal(busy(h), false);
    advance();
    assert.equal(busy(h), false);
  } finally {
    h.dispose();
  }
});

test("paused views ignore unrelated shared work but immediately show their own frozen filtering", async () => {
  let pending = false;
  let release;
  const { harness: h, payload } = await fixture({
    harness: { storage: { codexUsageAutoRefresh: "off" } },
    router: {
      usage: ({ payloads }) =>
        pending
          ? new Promise((resolve) => {
              release = resolve;
            })
          : { payload: { ...payloads.today, snapshotId: "frozen" } },
    },
  });
  try {
    await h.settle();
    const advance = runtimeClock(h);
    const source = Events.instances[0];
    source.emit(
      "activity-state",
      snapshot(
        [remote("sync"), remote("pricing", { kind: "pricing" }), remote("import", { kind: "import" })],
        [{ id: "foreign-error", shared: true, kind: "sync", message: "other page failed" }],
      ),
    );
    advance();
    assert.equal(text(h), "自动刷新已暂停");
    assert.equal(busy(h), false);
    assert.equal(h.dom.byId.get("autoRefreshError").hidden, true);
    pending = true;
    const load = h.api.loadUsage({ skipCheck: true });
    assert.equal(text(h), "正在计算统计…");
    assert.equal(busy(h), true);
    assert.equal(h.fetchLog.at(-1).params.snapshot, "frozen");
    release({ payload: { ...payload, snapshotId: "frozen" } });
    await load;
    assert.equal(text(h), "自动刷新已暂停");
    assert.equal(busy(h), false);
    advance();
    assert.equal(busy(h), false);
  } finally {
    release?.({ payload });
    await h.settle();
    h.dispose();
  }
});

test("user statistics do not bounce between HTTP placeholders and worker queue phases", async () => {
  let pending = false;
  let release;
  const { harness: h, payload } = await fixture({
    router: {
      usage: ({ payloads }) =>
        pending
          ? new Promise((resolve) => {
              release = resolve;
            })
          : { payload: payloads.today },
    },
  });
  try {
    await h.settle();
    const advance = runtimeClock(h);
    pending = true;
    const load = h.api.loadUsage({ skipCheck: true });
    const requestId = h.fetchLog.at(-1).requestId;
    const source = Events.instances[0];
    let revision = 1;
    for (const phase of ["queued", "statistics", "queued", "checking", "settling"]) {
      source.emit(
        "activity-state",
        snapshot([remote("request", { requestId, shared: false, kind: "statistics", phase })], [], revision++),
      );
      advance();
      assert.equal(text(h), "正在计算统计…");
      assert.equal(busy(h), true);
    }
    source.emit("activity-state", snapshot([], [], revision++));
    assert.equal(busy(h), true, "the HTTP/paint lifetime still belongs to this user request");
    release({ payload });
    await load;
    assert.equal(busy(h), false);
    assert.equal(text(h), "就绪");
  } finally {
    release?.({ payload });
    await h.settle();
    h.dispose();
  }
});
