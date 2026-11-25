import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { hasSelectedCodexSource } from "../public/timeline-utils.js";
import { createUsageServer } from "../src/server.js";
import {
  buildUsageIndex,
  buildUsageReport,
  discoverUsageSources,
  summarizeUsage,
  summarizeUsageIndex,
} from "../src/usage-core.js";
import { UsageStore as LiteStore } from "../src/usage-store-lite.js";
import { UsageStore } from "../src/usage-store.js";
import { codexTokenLine } from "../test-support/codex-log-fixture.mjs";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";

const time = "2026-11-24T12:00:00.000Z";
const now = "2026-11-24T12:30:00.000Z";
const model = "gpt-6-sol";
const secret = "OMP-PRIVATE-BODY-TITLE-ERROR";
function header(id, parentSession) {
  return { type: "session", version: 3, id, cwd: "/omp-fixture", timestamp: time, parentSession, title: secret };
}
function journal(id, input, output, cacheRead = 0, cacheWrite = 0, extra = {}) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: time,
    message: {
      role: "assistant",
      provider: "openai",
      api: "openai-codex-responses",
      model,
      content: secret,
      timestamp: Date.parse(time),
      responseId: `response-${id}`,
      usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, ...extra },
    },
  };
}
const a = journal("a", 100, 40, 200, 50, { reasoningTokens: 10 });
const b = {
  type: "model_usage",
  id: "b",
  parentId: "a",
  timestamp: time,
  purpose: "title",
  api: "openai-codex-responses",
  model,
  provider: "openai",
  stopReason: "error",
  errorMessage: secret,
  completion: { prompt: secret, reply: secret },
  usage: { input: 10, output: 5, cacheRead: 15, cacheWrite: 0, totalTokens: 30 },
};
const c = journal("c", 20, 5, 30);
const d = journal("d", 7, 3);

async function logs(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  const lines = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(file, file.endsWith(".gz") ? gzipSync(lines) : lines);
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-end-to-end-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const agent = path.join(root, ".omp", "agent");
  const sessions = path.join(agent, "sessions", "project");
  return { root, agent, sessions, options: { homeDir: root, env: {} } };
}

async function codexSource(root) {
  const token = JSON.parse(codexTokenLine(time, 70, 70));
  const reset = (iso) => Date.parse(iso) / 1000;
  token.payload.rate_limits = {
    limit_id: "codex",
    primary: { window_minutes: 300, resets_at: reset("2026-11-24T15:00:00Z"), used_percent: 42 },
    secondary: { window_minutes: 10080, resets_at: reset("2026-11-29T00:00:00Z"), used_percent: 25 },
  };
  const codex = path.join(root, ".codex");
  await logs(path.join(codex, "sessions", "rollout-shared.jsonl"), [
    {
      type: "session_meta",
      timestamp: time,
      payload: {
        id: "shared",
        source: "cli",
        originator: "codex-tui",
        cwd: "/codex-fixture",
        model_provider: "openai",
      },
    },
    { type: "turn_context", payload: { model } },
    token,
  ]);
  const db = new DatabaseSync(path.join(codex, "logs_2.sqlite"));
  try {
    db.exec(
      "CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)",
    );
    db.prepare("INSERT INTO logs VALUES (1, ?, 0, 'shared', 'codex_core::session::handlers', ?)").run(
      reset(time) - 60,
      'Submission sub=Submission { id: "x", op: TurnInput { service_tier: Some(Some("fast")), collaboration_mode: None } }',
    );
  } finally {
    db.close();
  }
}

test("OMP journal facts agree across report, streaming index, Waifu and Lite with separate Codex quota and tier evidence", async (t) => {
  const { root, agent, sessions, options } = await fixture(t);
  await logs(path.join(sessions, "origin.jsonl"), [
    header("shared"),
    a,
    b,
    { type: "message", message: { role: "toolResult", details: { usage: c.message.usage } } },
  ]);
  await logs(path.join(sessions, "fork.jsonl"), [header("child-fork", "shared"), a, d]);
  const archive = path.join(agent, "archive", "sessions", "project");
  await logs(path.join(archive, "origin.jsonl.gz"), [header("shared"), a, b]);
  await logs(path.join(archive, "origin", "__advisor.jsonl"), [header("advisor"), c]);
  await codexSource(root);
  const homes = await discoverUsageSources(options);
  const omp = homes.find((home) => home.kind === "omp");
  assert.ok(omp);
  assert.equal(hasSelectedCodexSource([omp]), false);
  const report = await buildUsageReport(options);
  const index = await buildUsageIndex({ ...options, homes });
  const ompEvents = report.events.filter((e) => e.sourceKind === "omp");
  assert.equal(ompEvents.length, 4);
  assert.ok(ompEvents.every((e) => e.serviceTier === "unknown" && !e.quotaSource));
  assert.equal(ompEvents.filter((e) => e.sessionId === "shared").length, 2);
  assert.ok(
    report.events.some((e) => e.sessionId === "shared" && e.sourceKind !== "omp" && e.serviceTier === "fast"),
    "Codex evidence control",
  );
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  const all = { preset: "all", calendarZone: "utc", bucket: "day", now };
  const readers = [(filters) => summarizeUsage(report, filters), (filters) => summarizeUsageIndex(index, filters)];
  const stores = [];
  try {
    for (const Store of [UsageStore, LiteStore]) {
      const dbFile = path.join(root, Store === UsageStore ? "waifu.sqlite" : "lite.sqlite");
      const store = new Store({ ...options, databaseFile: dbFile });
      stores.push(store);
      await store.sync();
      const published = await store.publishedUsageReport();
      const events = published.events.filter((e) => e.sourceKind === "omp");
      assert.equal(events.length, 4);
      assert.ok(events.every((e) => e.serviceTier === "unknown" && !e.quotaSource));
      assert.equal(events.filter((e) => e.sessionId === "shared").length, 2);
      assert.doesNotMatch(JSON.stringify(published), new RegExp(secret));
      store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      assert.equal((await readFile(dbFile)).includes(Buffer.from(secret)), false);
      readers.push((filters) => store.summarize(filters));
    }
    for (const summarize of readers) {
      const full = summarize(all);
      assert.equal(full.totals.total, 555);
      assert.equal(full.eventCount, 5);
      const only = summarize({
        ...all,
        excludeHomes: homes.filter((home) => home.kind !== "omp").map((home) => home.id),
      });
      assert.deepEqual(only.totals, { total: 485, input: 432, cached: 245, output: 53, reasoning: 10 });
      assert.equal(only.eventCount, 4);
      assert.equal(only.sessionCount, 3);
      for (const preset of ["quota_5h", "quota_week"])
        assert.equal(summarize({ ...all, preset }).totals.total, 70, preset);
    }
  } finally {
    for (const store of stores) store.close();
  }
});

test("web confirmation imports OMP and full details retain the published owner when a missing parent appears", async (t) => {
  const { root, agent, sessions, options } = await fixture(t);
  const lateParent = "a-parent.jsonl";
  await logs(path.join(sessions, "z-fork.jsonl"), [header("first-visible", "missing-parent"), a]);
  const server = createUsageServer({
    ...options,
    databaseFile: path.join(root, "web.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
    pricingFetcher: async () => {
      throw new Error("offline fixture");
    },
  });
  try {
    await listenOnFetchPort(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    async function get(route, body) {
      const response = await fetch(
        base + route,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      );
      const json = await response.json();
      assert.equal(response.status, 200, JSON.stringify(json));
      return json;
    }
    const dashboard = "/api/usage?preset=all&view=dashboard";
    assert.equal((await get(dashboard)).metadata.eventCount, 0);
    await get("/api/imports", { paths: [agent] });
    for (let i = 0; i < 100; i++) {
      const task = (await get("/api/status")).importTask;
      if (task.status !== "running") {
        assert.equal(task.status, "ready", JSON.stringify(task));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const full = "/api/usage?preset=all&detail=full";
    assert.equal((await get(full)).report.events[0]?.sessionId, "first-visible");
    await logs(path.join(sessions, lateParent), [header("missing-parent"), a]);
    assert.equal((await get(dashboard)).summary.totals.total, 390);
    const result = await get(full);
    assert.equal(result.report.events.length, 1);
    assert.equal(result.report.events[0].sessionId, "first-visible");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  } finally {
    await server.close();
  }
});
