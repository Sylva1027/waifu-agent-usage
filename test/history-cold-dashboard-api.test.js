import assert from "node:assert/strict";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { codexTokenLine as tokenLine } from "../test-support/codex-log-fixture.mjs";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";

const COLD_TIME = "2026-07-12T02:00:00.000Z";
const HOT_TIME = "2026-07-12T02:01:00.000Z";
const COLD_MS = Date.parse(COLD_TIME);
const HOT_MS = Date.parse(HOT_TIME);
const SESSION_ID = "cold-dashboard-api-session";

function sessionPrefix(codexHome, sessionId = SESSION_ID) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId, source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol" } }),
  ].join("\n");
}

function sourceOptions(root, codexHome) {
  return {
    homeDir: root,
    env: {},
    extraHomes: codexHome,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
}

async function listen(server) {
  await listenOnFetchPort(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function keyFields(summary, metadata, periodComparison) {
  return {
    summary: {
      total: summary.totals.total,
      eventCount: summary.eventCount,
      sessionCount: summary.sessionCount,
      homeCount: summary.homeCount,
    },
    metadata: {
      eventCount: metadata.eventCount,
      sessionCount: metadata.sessionCount,
      homeCount: metadata.homeCount,
      modelLastSeen: metadata.modelLastSeen,
    },
    period: {
      all: periodComparison.totals.all.total,
    },
  };
}

async function createArchivedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cold-dashboard-api-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-dashboard.jsonl");
  const source = sourceOptions(root, codexHome);
  const segmentFile = path.join(root, "cold-segment.sqlite");
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(
      usageFile,
      `${sessionPrefix(codexHome)}\n${tokenLine(COLD_TIME, 100, 100)}\n${tokenLine(HOT_TIME, 130, 30)}\n`,
    );

    const oracle = new UsageStore({ ...source, databaseFile: path.join(root, "oracle.sqlite") });
    let oracleKeys;
    try {
      await oracle.sync({ options: source });
      const now = new Date();
      oracleKeys = keyFields(
        oracle.summarize({ preset: "all", bucket: "day", calendarZone: "utc", now }),
        oracle.metadata(now),
        oracle.periodComparison({ now, calendarZone: "utc" }),
      );
    } finally {
      oracle.close();
    }

    const databaseFile = path.join(root, "usage-index.sqlite");
    const store = new UsageStore({ ...source, databaseFile });
    try {
      await store.sync({ options: source });
      await createHistoryArchiveCandidate(store.database, segmentFile, {
        startMs: COLD_MS,
        endMs: HOT_MS,
      });
      const plan = await prepareHistoryArchiveCommit(store.database, segmentFile);
      await store.commitHistoryArchiveEvents(plan);
      assert.deepEqual(
        store.database
          .prepare("SELECT total FROM events")
          .all()
          .map((row) => Number(row.total)),
        [30],
      );
    } finally {
      store.close();
    }

    return {
      root,
      usageFile,
      segmentFile,
      oracleKeys,
      serverOptions: {
        ...source,
        databaseFile,
        importStoreFile: path.join(root, "imports.json"),
        heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
        pricingRefreshSchedulerEnabled: false,
      },
      close() {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

test("summary and default usage APIs include cold history while the source remains", async () => {
  const fixture = await createArchivedFixture();
  let server;
  try {
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    assert.equal(existsSync(fixture.usageFile), true);

    for (const route of ["/api/summary?preset=all&calendarZone=utc", "/api/usage?preset=all&calendarZone=utc"]) {
      const response = await fetch(`${baseUrl}${route}`);
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.deepEqual(keyFields(body.summary, body.metadata, body.periodComparison), fixture.oracleKeys, route);
    }
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("cold-aware dashboard APIs fail closed when the authorized segment is missing", async () => {
  const fixture = await createArchivedFixture();
  let server;
  try {
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    unlinkSync(fixture.segmentFile);

    for (const route of ["/api/summary?preset=all&calendarZone=utc", "/api/usage?preset=all&calendarZone=utc"]) {
      const response = await fetch(`${baseUrl}${route}`);
      const body = await response.json();
      assert.equal(response.status, 500, route);
      assert.equal(body.code, "ENOENT", route);
      assert.equal(body.summary, undefined, route);
      assert.equal(body.metadata, undefined, route);
      assert.equal(body.periodComparison, undefined, route);
    }
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("an unsealed source selected over HTTP cannot make authorized history unreadable", {
  timeout: 30_000,
}, async (t) => {
  const fixture = await createArchivedFixture();
  const server = createUsageServer(fixture.serverOptions);
  try {
    const baseUrl = await listen(server);
    const usageRoute = `${baseUrl}/api/usage?preset=all&calendarZone=utc`;
    const before = await fetch(usageRoute, { signal: t.signal });
    assert.equal(before.status, 200);
    await before.json();

    const source = path.join(fixture.root, "new-codex-home");
    const file = path.join(source, "sessions", "2026", "07", "12", "rollout-unsealed-source.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${sessionPrefix(source, "unsealed-session")}\n${tokenLine(COLD_TIME, 25, 25)}\n`);
    const imported = await fetch(`${baseUrl}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ path: source }),
      signal: t.signal,
    });
    const accepted = await imported.json();
    assert.equal(imported.status, 200, JSON.stringify(accepted));
    let task = accepted.importTask;
    while (task.status === "running") {
      await delay(20, undefined, { signal: t.signal });
      const response = await fetch(`${baseUrl}/api/imports`, { signal: t.signal });
      assert.equal(response.status, 200);
      ({ importTask: task } = await response.json());
    }
    assert.match(task.error?.message ?? task.warnings?.join("\n") ?? "", /rollout-unsealed-source\.jsonl/);

    const after = await fetch(usageRoute, { signal: t.signal });
    const body = await after.json();
    assert.equal(after.status, 200, JSON.stringify(body));
    assert.equal(body.summary.totals.total, fixture.oracleKeys.summary.total);
    assert.equal(body.summary.eventCount, fixture.oracleKeys.summary.eventCount);
  } finally {
    await server.close();
    fixture.close();
  }
});
