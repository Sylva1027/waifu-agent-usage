import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createUsageExecutor } from "../src/usage-executor.js";
import { createUsageServer } from "../src/server.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

const stateKeys = ["awardRevision", "profileId", "progressRevision", "seenAwardRevision", "state"];
const version = (snapshot) => Object.fromEntries(stateKeys.map((key) => [key, snapshot[key]]));
async function waitFor(predicate) {
  for (let i = 0; i < 400; i++) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  }
  assert.fail("Achievement publication did not arrive");
}

async function stream(base, query = "?watch=0") {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/usage-events${query}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const snapshots = [];
  let ready = false;
  const done = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        while (buffer.includes("\n\n")) {
          const end = buffer.indexOf("\n\n");
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (event.startsWith("event: achievement-state\n")) snapshots.push(JSON.parse(event.split("\ndata: ")[1]));
          if (event.startsWith("event: ready\n")) ready = true;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  await waitFor(() => ready);
  return {
    snapshots,
    done,
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

test("executor callback observes the merged snapshot and also publishes pure refreshing states", {
  timeout: 30_000,
}, async () => {
  const fixture = createCodexIntegrationFixture();
  const snapshots = [];
  const merged = [];
  let executor;
  executor = createUsageExecutor(fixture.serverOptions, {
    onAchievementSnapshot: (snapshot) => {
      merged.push(executor.achievementSnapshot() === snapshot);
      snapshots.push(snapshot);
    },
  });
  try {
    await executor.open();
    await executor.achievementStart({ edition: "waifu", timeZone: "Pacific/Auckland" });
    await executor.achievementUpdate();
    const before = snapshots.at(-1);
    assert.equal(before.state, "ready");
    const count = snapshots.length;
    await executor.achievementUpdate();
    assert.ok(snapshots.length > count);
    assert.ok(snapshots.slice(count).some((snapshot) => snapshot.refreshing === true));
    assert.deepEqual(version(snapshots.at(-1)), version(before));
    assert.equal(snapshots.at(-1).timeZone, "Pacific/Auckland", "archive calendar stays fixed independently");
    assert.ok(merged.every(Boolean), "merge happens before callback");
  } finally {
    await executor.close();
    fixture.close();
  }
});

for (const failure of ["throw", "reject"]) {
  test(`achievement observer ${failure} cannot interrupt IPC or request settlement`, { timeout: 10_000 }, async () => {
    const fixture = createCodexIntegrationFixture();
    let calls = 0;
    const executor = createUsageExecutor(fixture.serverOptions, {
      onAchievementSnapshot: () => {
        calls++;
        if (failure === "throw") throw new Error("observer failed");
        return Promise.reject(new Error("async observer failed"));
      },
    });
    try {
      await executor.open();
      await executor.achievementStart({ edition: "waifu", timeZone: "UTC" });
      await executor.achievementUpdate();
      assert.ok(calls >= 2);
      assert.equal(executor.achievementSnapshot().state, "ready");
      assert.equal((await executor.dashboard({ preset: "all" })).summary.totals.total, 0);
    } finally {
      await executor.close();
      fixture.close();
    }
  });
}

test("close drains an admitted first open even before its child has spawned", { timeout: 10_000 }, async () => {
  const fixture = createCodexIntegrationFixture();
  const executor = createUsageExecutor(fixture.serverOptions);
  try {
    const opened = executor.open();
    const closing = executor.close();
    await opened;
    await closing;
    assert.equal(executor.alive, false);
    await assert.rejects(executor.dashboard({ preset: "all" }), { code: "EXECUTOR_UNAVAILABLE" });
  } finally {
    await executor.close();
    fixture.close();
  }
});

test("close stops HTTP admission before ending watched and passive SSE streams", { timeout: 10_000 }, async () => {
  const fixture = createCodexIntegrationFixture();
  const server = createUsageServer({ ...fixture.serverOptions, edition: "standard" });
  const observers = [];
  let closing;
  try {
    await listenOnFetchPort(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    observers.push(await stream(base), await stream(base, ""));
    closing = server.close();
    assert.equal(server.listening, false, "SSE end must not leave a reconnect window before native close");
    await closing;
    await Promise.all(observers.map((observer) => observer.done));
  } finally {
    await Promise.all(observers.map((observer) => observer.close()));
    await (closing || server.close());
    fixture.close();
  }
});

test("late SSE requests disconnect for native retry while imported runtimes retain terminal 204", async () => {
  const fixture = createCodexIntegrationFixture();
  try {
    for (const imported of [false, true]) {
      const server = createUsageServer({
        ...fixture.serverOptions,
        edition: "standard",
        ...(imported ? { importContext: {} } : {}),
      });
      await server.close();
      let status;
      let headers = {};
      let disconnected = false;
      await new Promise((resolve) =>
        server.emit(
          "request",
          {
            url: "/api/usage-events?watch=0",
            method: "GET",
            headers: { host: "127.0.0.1:3765" },
            headersDistinct: { host: ["127.0.0.1:3765"] },
            socket: { localAddress: "127.0.0.1", localPort: 3765 },
          },
          {
            writeHead: (code, values) => {
              status = code;
              headers = values;
            },
            end: resolve,
            destroy: () => {
              disconnected = true;
              resolve();
            },
          },
        ),
      );
      assert.equal(status, imported ? 204 : undefined);
      assert.equal(disconnected, !imported);
      assert.equal(headers["cache-control"], imported ? "no-store" : undefined);
    }
  } finally {
    fixture.close();
  }
});

test("passive SSE clients receive award/seen versions, deduplicate refreshing, and recover on reconnect/restart", {
  timeout: 60_000,
}, async () => {
  const fixture = createCodexIntegrationFixture();
  let server;
  let base;
  const observers = [];
  const start = async () => {
    server = createUsageServer({ ...fixture.serverOptions, edition: "waifu", achievementTimeZone: "Pacific/Auckland" });
    await listenOnFetchPort(server);
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const get = async (url = "/api/achievements", body) => {
    const response = await fetch(
      base + url,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { Origin: base, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const observe = async () => {
    const observer = await stream(base);
    observers.push(observer);
    return observer;
  };
  try {
    await start();
    const initial = await waitFor(async () => {
      const value = await get();
      return value.state === "ready" && !value.refreshing && value;
    });
    const a = await observe();
    const b = await observe();
    assert.deepEqual(a.snapshots, [version(initial)]);
    assert.deepEqual(b.snapshots, [version(initial)]);
    await appendFile(
      fixture.rolloutFiles[0],
      `${JSON.stringify({
        type: "event_msg",
        timestamp: new Date(Date.now() - 1).toISOString(),
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 10_000_000_000, input_tokens: 10_000_000_000 } },
        },
      })}\n`,
    );
    await get("/api/summary?preset=all&calendarZone=utc");
    const awarded = await waitFor(() => a.snapshots.find((snapshot) => snapshot.awardRevision > initial.awardRevision));
    await waitFor(() => b.snapshots.some((snapshot) => snapshot.awardRevision === awarded.awardRevision));
    const current = await get();
    assert.deepEqual(a.snapshots.at(-1), version(current));
    for (const snapshot of [...a.snapshots, ...b.snapshots]) assert.deepEqual(Object.keys(snapshot).sort(), stateKeys);
    for (const observer of [a, b]) {
      assert.equal(
        new Set(observer.snapshots.map((snapshot) => JSON.stringify(snapshot))).size,
        observer.snapshots.length,
        "refreshing-only publications must not duplicate SSE versions",
      );
    }
    const seen = await get("/api/achievements/seen", {
      profileId: awarded.profileId,
      seenThroughRevision: awarded.awardRevision,
    });
    await waitFor(() => a.snapshots.at(-1)?.seenAwardRevision === awarded.awardRevision);
    await waitFor(() => b.snapshots.at(-1)?.seenAwardRevision === awarded.awardRevision);
    assert.equal(seen.seenThroughRevision, awarded.awardRevision);
    const count = a.snapshots.length;
    await get("/api/achievements/seen", { profileId: awarded.profileId, seenThroughRevision: awarded.awardRevision });
    await delay(30);
    assert.equal(a.snapshots.length, count, "idempotent seen does not broadcast another version");
    const reconnected = await observe();
    assert.deepEqual(reconnected.snapshots, [a.snapshots.at(-1)]);
    const saved = await get();
    await Promise.all(observers.map((observer) => observer.close()));
    observers.length = 0;
    await server.close();
    await start();
    const restored = await waitFor(async () => {
      const value = await get();
      return value.state === "ready" && !value.refreshing && value;
    });
    assert.equal(restored.profileId, saved.profileId);
    assert.equal(restored.timeZone, "Pacific/Auckland");
    assert.equal(restored.awardRevision, saved.awardRevision);
    assert.equal(restored.seenAwardRevision, saved.seenAwardRevision);
    const reopened = await observe();
    assert.deepEqual(reopened.snapshots, [version(restored)]);
  } finally {
    await Promise.all(observers.map((observer) => observer.close()));
    await server?.close();
    fixture.close();
  }
});
