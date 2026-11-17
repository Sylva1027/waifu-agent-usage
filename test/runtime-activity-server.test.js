import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createUsageServer } from "../src/server.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";

async function stream(base, query = "?watch=0") {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/usage-events${query}`, { signal: controller.signal });
  const snapshots = [];
  let ready;
  const opened = new Promise((resolve) => {
    ready = resolve;
  });
  const done = (async () => {
    let buffer = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        while (buffer.includes("\n\n")) {
          const end = buffer.indexOf("\n\n");
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (event.startsWith("event: activity-state\n")) snapshots.push(JSON.parse(event.split("\ndata: ")[1]));
          if (event.startsWith("event: ready\n")) ready();
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  await opened;
  return {
    snapshots,
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

test("passive activity streams observe real executor stages without starting source watchers", {
  timeout: 30_000,
}, async (t) => {
  const fixture = createCodexIntegrationFixture();
  let watchCalls = 0;
  const watchers = new Set();
  const watch = fs.watch;
  t.mock.method(fs, "watch", (...args) => {
    watchCalls++;
    const watcher = watch(...args);
    watchers.add(watcher);
    watcher.once("close", () => watchers.delete(watcher));
    return watcher;
  });
  syncBuiltinESMExports();
  const server = createUsageServer(fixture.serverOptions);
  await listenOnFetchPort(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const observer = await stream(base);
  t.after(async () => {
    await observer.close();
    await server.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fixture.close();
  });
  assert.equal(observer.snapshots.length, 1);
  assert.deepEqual(observer.snapshots[0].tasks, []);
  assert.equal(watchCalls, 0);
  const get = async (query, id) => {
    const response = await fetch(base + query, { headers: { "X-Usage-Request-Id": id } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const query = "/api/usage?preset=all&view=dashboard&calendarZone=utc";
  const frozen = await get(`${query}&skipCheck=1&freeze=1`, "pageA:initial");
  assert.ok(frozen.snapshotId);
  const [a, b] = await Promise.all([
    get(`${query}&snapshot=${frozen.snapshotId}`, "pageA:filter"),
    get(`${query}&skipCheck=1`, "pageB:filter"),
  ]);
  assert.deepEqual(a.summary.totals, b.summary.totals);
  const invalid = await fetch(base + query, { headers: { "X-Usage-Request-Id": "bad identity" } });
  assert.equal(invalid.status, 400);
  // Ordered SSE writes precede this final response; reopening also verifies current snapshot recovery.
  const reconnect = await stream(base);
  assert.deepEqual(reconnect.snapshots[0].tasks, []);
  assert.equal(reconnect.snapshots[0].epoch, observer.snapshots[0].epoch);
  await reconnect.close();
  await observer.close();
  const tasks = observer.snapshots.flatMap((snapshot) => snapshot.tasks);
  for (const id of ["pageA:initial", "pageA:filter", "pageB:filter"]) {
    assert.ok(
      tasks.some((task) => task.requestId === id),
      `request identity: ${id}`,
    );
    assert.ok(
      tasks.some((task) => task.requestId === id && task.id.startsWith("executor:")),
      `real executor: ${id}`,
    );
  }
  assert.ok(tasks.some((task) => task.shared && task.kind === "sync"));
  assert.ok(tasks.some((task) => task.phase === "statistics" && task.state === "running"));
  assert.ok(observer.snapshots.every((snapshot, index, all) => !index || snapshot.revision > all[index - 1].revision));
  assert.equal(watchCalls, 0, "observing state and frozen filters never start source watchers");
  const passive = await stream(base);
  const live = await stream(base, "");
  assert.ok(watchCalls > 0, "a real-time subscriber still starts source watchers");
  const closed = Promise.all([...watchers].map((watcher) => once(watcher, "close")));
  await live.close();
  await closed;
  assert.equal(watchers.size, 0, "last real-time subscriber closes watchers while passive observer remains");
  const previousCalls = watchCalls;
  await get(`${query}&snapshot=${frozen.snapshotId}`, "pageA:paused");
  assert.equal(watchCalls, previousCalls, "frozen work does not reactivate closed watchers");
  await passive.close();
});
