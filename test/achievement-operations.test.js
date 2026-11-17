import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AchievementOperationService } from "../src/achievement-operations.js";
import { AchievementStore } from "../src/achievement-store.js";
import { summarizeUsage } from "../src/usage-core.js";

const T0 = Date.parse("2026-11-17T00:00:00Z");
const now = T0 + 3600000;
function summary(overrides = {}) {
  return summarizeUsage(
    {
      events: [
        {
          timestamp: new Date(now - 1000).toISOString(),
          model: "gpt-6",
          sessionId: "s",
          homeId: "h",
          channel: "Codex",
          total: { total: 100, input: 75, cached: 25, output: 25, reasoning: 0 },
        },
      ],
    },
    { preset: "today", now, calendarZone: "utc", ...overrides },
  );
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "achievement-operations-"));
  const stores = [];
  const create = (name = "archive.sqlite", fault = undefined) => {
    const archive = new AchievementStore({
      databaseFile: path.join(root, name),
      catalog: [{ id: "A43", tiers: ["stone"] }],
      fault,
    });
    archive.open({ enabledAt: T0, timeZone: "UTC", rulesVersion: "test", catalogHash: "test" });
    stores.push(archive);
    return archive;
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const archive = create();
  return { root, archive, create, service: new AchievementOperationService({ archive, clock: () => now }) };
}

test("share receipts bind stable captured aggregates, excluding styling, pricing, asOf and unrelated revisions", (t) => {
  const { service, archive } = fixture(t);
  const first = summary();
  const receipt = service.issueShareReceipt(first, first.range);
  const cosmetic = structuredClone(first);
  cosmetic.range.asOf = new Date(now + 60000).toISOString();
  cosmetic.generatedAt = "later";
  cosmetic.costEstimate = { totalUsd: 999, cacheHitRate: 0.01, modelCount: 999 };
  cosmetic.revision = "global-change";
  cosmetic.theme = "dark";
  cosmetic.layout = "landscape";
  cosmetic.models.reverse();
  cosmetic.timeline.reverse();
  assert.equal(service.issueShareReceipt(cosmetic, cosmetic.range), receipt);
  assert.equal(archive.readOperations().length, 0, "Issuing/previewing a receipt is not a success");
  assert.equal(service.recordBrowserOperation({ kind: "share", receipt }), true);
  assert.equal(service.recordBrowserOperation({ kind: "share", receipt }), false);
  assert.equal(archive.readOperations()[0].occurredAt, new Date(now).toISOString());
  cosmetic.totals.total++;
  assert.notEqual(service.issueShareReceipt(cosmetic, cosmetic.range), receipt);
  const differentRange = summary({ preset: "week" });
  assert.notEqual(service.issueShareReceipt(differentRange, differentRange.range), receipt);
});

test("quota polling cutoff cannot turn unchanged window data into another share", (t) => {
  const { service } = fixture(t);
  const data = summary();
  Object.assign(data.range, {
    preset: "quota_5h",
    quotaWindow: true,
    quotaPreset: "quota_5h",
    quotaState: "available",
    windowEndExclusive: new Date(now + 3600000).toISOString(),
  });
  const before = service.issueShareReceipt(data, data.range);
  data.range.asOf = new Date(now + 60000).toISOString();
  data.range.end = new Date(now + 59999).toISOString();
  assert.equal(service.issueShareReceipt(data, data.range), before);
});

test("server filters cannot replace summary boundaries; all cutoff drift dedupes while calendar cycles remain distinct", (t) => {
  const { service } = fixture(t);
  const today = summary();
  const initial = service.issueShareReceipt(today, { preset: "today", excludeHomes: ["b", "a", "a"] });
  assert.equal(
    service.issueShareReceipt(today, { preset: "today", start: "bogus", end: "bogus", excludeHomes: ["a", "b"] }),
    initial,
  );
  assert.notEqual(service.issueShareReceipt(today, { excludeHomes: ["a"] }), initial);
  const all = summary({ preset: "all" });
  const allReceipt = service.issueShareReceipt(all);
  all.range.end = new Date(now + 60000).toISOString();
  all.range.asOf = all.range.end;
  assert.equal(service.issueShareReceipt(all), allReceipt);
  today.range.start = "2026-11-18T00:00:00.000Z";
  today.range.end = "2026-11-18T23:59:59.999Z";
  assert.notEqual(service.issueShareReceipt(today, { excludeHomes: ["a", "b"] }), initial);
  const week = summary({ preset: "week" });
  const thisWeek = service.issueShareReceipt(week);
  week.range.start = "2026-11-23T00:00:00.000Z";
  week.range.end = "2026-11-23T23:59:59.999Z";
  assert.notEqual(service.issueShareReceipt(week), thisWeek);
});

test("trust boundary rejects forged, foreign, unsupported and award-supplying browser operations", (t) => {
  const { service, create, archive } = fixture(t);
  const receipt = service.issueShareReceipt(summary());
  const foreign = new AchievementOperationService({ archive: create("foreign.sqlite"), clock: () => now });
  for (const operation of [
    { kind: "share", receipt: "self-issued" },
    { kind: "share", receipt: `${receipt.slice(0, -1)}${receipt.endsWith("a") ? "b" : "a"}` },
    { kind: "share", receipt, id: "A43" },
    { kind: "share", receipt, occurredAt: "2020-01-01T00:00:00Z" },
    { kind: "restore", receipt },
    { kind: "skin", characterId: "classic" },
    { kind: "skin", characterId: "missing" },
    { kind: "skin", characterId: "deepseek", tier: "gold" },
  ])
    assert.throws(() => service.recordBrowserOperation(operation));
  assert.throws(() => foreign.recordBrowserOperation({ kind: "share", receipt }));
  assert.throws(() => service.issueShareReceipt({ totals: { total: 1 } }));
  assert.equal(archive.readOperations().length, 0);
  assert.equal(service.recordBrowserOperation({ kind: "skin", characterId: "deepseek" }), true);
  assert.equal(service.recordBrowserOperation({ kind: "skin", characterId: "deepseek" }), false);
});

test("captured/frozen receipts remain valid across updates, progress clearing and archive restart", (t) => {
  const { service, archive, create } = fixture(t);
  const old = summary();
  const receipt = service.issueShareReceipt(old);
  const changed = structuredClone(old);
  changed.totals.total *= 2;
  const newer = service.issueShareReceipt(changed);
  assert.notEqual(newer, receipt);
  archive.clearProgress();
  archive.close();
  const restarted = new AchievementOperationService({ archive: create(), clock: () => now + 2000 });
  assert.equal(restarted.issueShareReceipt(old), receipt);
  assert.equal(restarted.recordBrowserOperation({ kind: "share", receipt }), true);
  assert.equal(restarted.recordBrowserOperation({ kind: "share", receipt }), false);
  assert.equal(restarted.recordBrowserOperation({ kind: "share", receipt: newer }), true);
});

test("failed operation commit can retry the original receipt without a second success", (t) => {
  const { service, archive, create } = fixture(t);
  const receipt = service.issueShareReceipt(summary());
  let fail = true;
  const faulty = create("archive.sqlite", () => {
    if (fail) throw new Error("injected commit failure");
  });
  const failing = new AchievementOperationService({ archive: faulty, clock: () => now });
  assert.throws(() => failing.recordBrowserOperation({ kind: "share", receipt }), /injected/);
  assert.equal(archive.readOperations().length, 0);
  fail = false;
  assert.equal(failing.recordBrowserOperation({ kind: "share", receipt }), true);
});

test("restore success journal survives failed accounting and replays after restart without rerunning restore", (t) => {
  const { root, archive, service, create } = fixture(t);
  const receiptFile = path.join(root, "restore-success.json");
  const request = {
    receiptFile,
    operationId: "restore-1",
    packageDigest: "a".repeat(64),
    target: path.join(root, "restored.sqlite"),
  };
  const receipt = service.persistRestoreSuccess(request);
  assert.equal(archive.readOperations().length, 0);
  const saved = readFileSync(receiptFile, "utf8");
  assert.equal(service.persistRestoreSuccess(request), receipt);
  assert.throws(() => service.persistRestoreSuccess({ ...request, operationId: "another" }), /another operation/);
  const faulty = create("archive.sqlite", () => {
    throw new Error("accounting unavailable");
  });
  assert.throws(
    () => new AchievementOperationService({ archive: faulty }).replayRestoreSuccess(receiptFile),
    /unavailable/,
  );
  assert.equal(readFileSync(receiptFile, "utf8"), saved);
  faulty.close();
  archive.close();
  const reopened = create();
  const restarted = new AchievementOperationService({ archive: reopened });
  assert.equal(restarted.replayRestoreSuccess(receiptFile), true);
  assert.equal(restarted.replayRestoreSuccess(receiptFile), false);
  const [operation] = reopened.readOperations();
  assert.equal(operation.kind, "restore");
  assert.equal(operation.occurredAt, new Date(now).toISOString());
  assert.equal(operation.payload.target, request.target);
  assert.equal(
    readdirSync(root).some((name) => name.includes(".creating-")),
    false,
  );
  const foreign = new AchievementOperationService({ archive: create("foreign.sqlite") });
  assert.throws(() => foreign.replayRestoreSuccess(receiptFile));
  writeFileSync(receiptFile, JSON.stringify({ receipt: "forged" }));
  assert.throws(() => restarted.replayRestoreSuccess(receiptFile));
  assert.equal(reopened.readOperations().length, 1);
});

test("restore persistence preserves an open failure and accepts a verified winner published during its race", (t) => {
  const { root, archive, service } = fixture(t);
  const request = {
    receiptFile: path.join(root, "missing-parent", "success.json"),
    operationId: "restore-race",
    packageDigest: "b".repeat(64),
    target: path.join(root, "restored.sqlite"),
  };
  assert.throws(
    () => service.persistRestoreSuccess(request),
    (error) => error.code === "ENOENT" && error.syscall === "open",
  );
  request.receiptFile = path.join(root, "success.json");
  let winner;
  const racing = new AchievementOperationService({
    archive,
    clock: () => {
      winner = service.persistRestoreSuccess(request);
      return now + 5000;
    },
  });
  assert.equal(racing.persistRestoreSuccess(request), winner);
  assert.equal(service.persistRestoreSuccess(request), winner);
  assert.equal(service.replayRestoreSuccess(request.receiptFile), true);
  assert.equal(service.replayRestoreSuccess(request.receiptFile), false);
  assert.equal(archive.readOperations()[0].occurredAt, new Date(now).toISOString());
  assert.equal(
    readdirSync(root).some((name) => name.includes(".creating-")),
    false,
  );
});
