import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createUsageServer } from "../src/server.js";
import { createUsageServer as createLiteUsageServer } from "../src/server-lite.js";
import { discoverUsageSources } from "../src/usage-core.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";

const line = (row) => JSON.stringify(row) + "\n";
function tokenRow(total, time = Date.now() - 1) {
  return {
    timestamp: new Date(time).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: total,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    },
  };
}
async function fixture(t, { lite = false, historyTotal = 999, ...extra } = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "achievement-api-"));
  const sessionFile = path.join(homeDir, ".codex", "sessions", "2026", "11", "17", "rollout.jsonl");
  const importStoreFile = path.join(homeDir, "imports.json");
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(
    sessionFile,
    line({
      timestamp: new Date(Date.now() - 100000).toISOString(),
      type: "session_meta",
      payload: { id: "achievement-api-session", source: "cli", originator: "codex-tui", cwd: homeDir },
    }) + line(tokenRow(historyTotal, Date.now() - 100000)),
  );
  await writeFile(
    importStoreFile,
    JSON.stringify({ version: 2, imports: await discoverUsageSources({ homeDir, env: {} }) }),
  );
  const databaseFile = path.join(homeDir, "usage-index.sqlite");
  const options = {
    homeDir,
    importStoreFile,
    databaseFile,
    env: {},
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
    ...extra,
  };
  let server, base;
  const start = async () => {
    server = (lite ? createLiteUsageServer : createUsageServer)(options);
    await listenOnFetchPort(server);
    base = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  t.after(async () => {
    await server.close();
    assert.equal(path.dirname(homeDir), path.resolve(tmpdir()));
    assert.ok(path.basename(homeDir).startsWith("achievement-api-"));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const request = async (url = "/api/achievements", body, headers = {}) => {
    const response = await fetch(
      base + url,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: base, ...headers },
            body: JSON.stringify(body),
          },
    );
    const text = await response.text();
    return {
      status: response.status,
      body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text,
    };
  };
  const wait = async (predicate) => {
    let latest;
    for (let i = 0; i < 200; i++) {
      latest = await request();
      if (latest.status !== 200) throw new Error(JSON.stringify(latest));
      if (predicate(latest.body)) return latest.body;
      await delay(10);
    }
    assert.fail(`Achievement state did not settle: ${JSON.stringify(latest)}`);
  };
  return {
    options,
    homeDir,
    sessionFile,
    request,
    wait,
    restart: async () => {
      await server.close();
      await start();
    },
  };
}
const row = (snapshot, id) => snapshot.rows.find((item) => item.id === id);

test("first Waifu startup indexes historical logs and grants a single award batch before opening a window", async (t) => {
  const f = await fixture(t, { historyTotal: 210_000_000_000 });
  const initial = await f.wait((snapshot) => snapshot.state === "ready" && !snapshot.refreshing);
  assert.equal(initial.rows.length, 42);
  assert.equal(row(initial, "A01").observedValue, "210000000000");
  assert.equal(row(initial, "A01").highestEarned, "silver");
  assert.equal(row(initial, "A01").earnedAt.bronze, row(initial, "A01").earnedAt.silver);
  assert.equal(row(initial, "A31").highestEarned, "stone");
  assert.equal(initial.awardRevision, 1);
  assert.equal(initial.seenAwardRevision, 0);
  assert.ok(initial.awards.every((award) => award.awardRevision === initial.awardRevision));
  assert.ok(existsSync(path.join(f.homeDir, "achievements.sqlite")));
  await appendFile(f.sessionFile, line(tokenRow(5_100_000_000_000)));
  const response = await f.request("/api/summary?preset=all");
  assert.equal(response.status, 200);
  const updated = await f.wait(
    (snapshot) => snapshot.state === "ready" && row(snapshot, "A01").highestEarned === "gold",
  );
  if (process.env.S08D_CAPTURE_API === "1")
    await writeFile(
      new URL("../docs/validation/2026-11-16-achievement-production/S08-D/api-examples.json", import.meta.url),
      JSON.stringify(
        {
          isolated: true,
          initial: { request: "GET /api/achievements", status: 200, body: initial },
          afterRealUsage: { request: "GET /api/achievements", status: 200, body: updated },
          summaryCapture: {
            request: "GET /api/summary?preset=all",
            status: response.status,
            body: { summary: response.body.summary, achievementShareReceipt: response.body.achievementShareReceipt },
          },
        },
        null,
        2,
      ) + "\n",
    );
  assert.equal(row(updated, "A01").observedValue, "5100000000000");
  assert.equal(row(updated, "A01").earnedAt.silver, row(initial, "A01").earnedAt.silver);
  assert.equal(updated.awardRevision, initial.awardRevision + 1);
  const received = await f.request("/api/achievements?preset=today&exclude=all");
  assert.equal(row(received.body, "A01").observedValue, "5100000000000");
  for (let i = 0; i < 5; i++) assert.equal((await f.request()).body.progressRevision, updated.progressRevision);
  assert.equal(
    (
      await f.request("/api/achievements/seen", {
        profileId: updated.profileId,
        seenThroughRevision: updated.awardRevision,
      })
    ).status,
    200,
  );
  await f.restart();
  const restarted = await f.wait((snapshot) => snapshot.state === "ready" && !snapshot.refreshing);
  assert.equal(restarted.profileId, initial.profileId);
  assert.equal(restarted.enabledAt, initial.enabledAt);
  assert.deepEqual(restarted.awards, updated.awards);
  assert.equal(restarted.seenAwardRevision, updated.awardRevision);
});

test("real summary receipts and applied skins record once, survive restart, and preserve unseen updates", async (t) => {
  const f = await fixture(t);
  await f.wait((snapshot) => snapshot.state === "ready");
  const summary = await f.request("/api/summary?preset=all&freeze=1");
  assert.equal(summary.status, 200);
  const receipt = summary.body.achievementShareReceipt;
  assert.equal(typeof receipt, "string");
  const first = await f.request("/api/achievements/operations", { kind: "share", receipt });
  assert.equal(first.status, 200);
  assert.equal(first.body.recorded, true);
  assert.equal(row(first.body.snapshot, "A43").observedValue, "1");
  const repeat = await f.request("/api/achievements/operations", { kind: "share", receipt });
  assert.equal(repeat.body.recorded, false);
  const viewed = first.body.snapshot;
  await appendFile(f.sessionFile, line(tokenRow(10_000_000_999)));
  assert.equal((await f.request("/api/summary?preset=all")).status, 200);
  await f.wait((snapshot) => snapshot.state === "ready" && snapshot.awardRevision > viewed.awardRevision);
  const skin = await f.request("/api/achievements/operations", { kind: "skin", characterId: "chatgpt" });
  assert.equal(skin.status, 200);
  assert.equal(row(skin.body.snapshot, "A44").observedValue, "1");
  assert.equal(
    (await f.request("/api/achievements/operations", { kind: "skin", characterId: "chatgpt" })).body.recorded,
    false,
  );
  assert.equal((await f.request("/api/achievements/operations", { kind: "skin", characterId: "classic" })).status, 400);
  for (const characterId of ["muse", "mimo"]) {
    assert.equal((await f.request("/api/achievements/operations", { kind: "skin", characterId })).status, 400);
  }
  await f.request("/api/achievements/seen", { profileId: viewed.profileId, seenThroughRevision: viewed.awardRevision });
  const seen = (await f.request()).body;
  assert.equal(seen.seenAwardRevision, viewed.awardRevision);
  assert.ok(seen.awardRevision > seen.seenAwardRevision);
  await f.restart();
  await f.wait((snapshot) => snapshot.state === "ready");
  const old = await f.request("/api/achievements/operations", { kind: "share", receipt });
  assert.equal(old.status, 200);
  assert.equal(old.body.recorded, false);
  assert.equal(row(old.body.snapshot, "A43").observedValue, "1");
});

test("achievement mutation API rejects cross-origin, non-JSON, forged awards and future seen revisions", async (t) => {
  const f = await fixture(t);
  const current = await f.wait((snapshot) => snapshot.state === "ready");
  const url = "/api/achievements/operations";
  const invalid = [
    [{ kind: "skin", characterId: "chatgpt" }, { Origin: "https://other.example" }, 403],
    [{ kind: "skin", characterId: "chatgpt" }, { "Content-Type": "text/plain" }, 415],
    [{ kind: "restore", receipt: "fake" }, {}, 400],
    [{ kind: "share", receipt: "fake" }, {}, 400],
    [{ kind: "skin", characterId: "chatgpt", id: "A01", tier: "gold" }, {}, 400],
    [[], {}, 400],
  ];
  for (const [body, headers, expected] of invalid) assert.equal((await f.request(url, body, headers)).status, expected);
  assert.equal(
    (
      await f.request("/api/achievements/seen", {
        profileId: current.profileId,
        seenThroughRevision: current.awardRevision + 1,
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request("/api/achievements/seen", { profileId: "different", seenThroughRevision: 0 })).status,
    409,
  );
  const after = (await f.request()).body;
  assert.equal(after.awardRevision, current.awardRevision);
  assert.equal(row(after, "A43").observedValue, "0");
});

test("Lite edition has no achievement routes or profile and does not initialize the extension", async (t) => {
  const f = await fixture(t, { lite: true });
  const usage = await f.request("/api/usage?view=dashboard&preset=all");
  assert.equal(usage.status, 200);
  assert.equal(usage.body.summary.totals.total, 999);
  assert.equal(Object.hasOwn(usage.body.summary, "costEstimate"), false);
  assert.equal((await f.request()).status, 404);
  assert.equal((await f.request("/api/achievements/operations", { kind: "skin", characterId: "chatgpt" })).status, 404);
  assert.equal(existsSync(path.join(f.homeDir, "achievements.sqlite")), false);
});
