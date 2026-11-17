import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { calendarContext } from "../src/calendar-context.js";
import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { createUsageServer } from "../src/server.js";
import { summaryCacheKey } from "../src/usage-summary-cache.js";
import { UsageStore } from "../src/usage-store.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

const run = promisify(execFile);
const line = (row) => `${JSON.stringify(row)}\n`;
const usage = (timestamp, total) =>
  line({
    type: "event_msg",
    timestamp,
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: total, input_tokens: total } } },
  });

async function isolatedCalendarChecks() {
  const initialZone = calendarContext().timeZone;
  const fixture = createCodexIntegrationFixture();
  const server = createUsageServer({ ...fixture.serverOptions, edition: "standard", achievementsEnabled: false });
  let executor;
  let changingExecutor;
  let frozenExecutor;
  try {
    await appendFile(fixture.rolloutFiles[0], usage("2026-11-17T00:30:00Z", 100) + usage("2026-11-17T08:30:00Z", 200));
    if (process.env.CODEX_USAGE_CALENDAR_COLD === "1") {
      const store = new UsageStore(fixture.serverOptions);
      try {
        await store.sync({ options: fixture.reportOptions });
        const segment = path.join(fixture.reportOptions.homeDir, "calendar-cold.sqlite");
        await createHistoryArchiveCandidate(store.database, segment, {
          startMs: Date.parse("2026-11-17T00:00:00Z"),
          endMs: Date.parse("2026-11-17T01:00:00Z"),
        });
        const registered = await store.registerHistoryArchiveCandidate(segment);
        store.database
          .prepare("INSERT OR REPLACE INTO store_meta(key,value) VALUES (?,?)")
          .run(
            "history_archive_event_authority",
            JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
          );
        store.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(Date.parse("2026-11-17T01:00:00Z"));
      } finally {
        store.close();
      }
    }
    await listenOnFetchPort(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (query) => {
      const response = await fetch(base + query);
      assert.equal(response.status, 200, await response.clone().text());
      return { body: await response.json(), cache: response.headers.get("x-summary-cache") };
    };
    const query = "/api/summary?preset=custom&startDate=2026-11-17&endDate=2026-11-17&bucket=day";
    const expected = initialZone === "America/Los_Angeles" ? 200 : 300;
    for (const parameter of ["", "&calendarZone=utc", "&calendarZone=local", "&calendarZone=obsolete"]) {
      const { body } = await get(query + parameter);
      assert.equal(body.summary.totals.total, expected);
      assert.equal(body.summary.range.calendarZone, "local");
      assert.equal(body.summary.range.timeZone, initialZone);
      assert.deepEqual(body.metadata.calendarContext, { timeZone: initialZone });
    }
    if (process.env.CODEX_USAGE_CALENDAR_COLD !== "1") {
      const full = (await get(`${query.replace("/api/summary", "/api/usage")}&detail=full&calendarZone=utc`)).body;
      assert.equal(full.summary.totals.total, expected);
      assert.equal(full.summary.range.timeZone, initialZone);
      assert.equal(full.metadata.calendarContext.timeZone, initialZone);
    }
    const frozen = (await get(`${query}&freeze=1&calendarZone=utc`)).body;
    assert.ok(frozen.snapshotId);
    const beforeStatus = (await get("/api/status")).body;
    const keyBefore = summaryCacheKey(
      { preset: "all", calendarZone: "local", now: new Date("2026-11-17T12:00Z") },
      true,
      {},
    );
    const changedZone = initialZone === "America/Los_Angeles" ? "Asia/Shanghai" : "America/Los_Angeles";
    // Only this disposable child process changes TZ; the test runner and user's machine do not.
    process.env.TZ = changedZone;
    assert.equal(calendarContext().timeZone, changedZone);
    const keyAfter = summaryCacheKey(
      { preset: "all", calendarZone: "local", now: new Date("2026-11-17T12:00Z") },
      true,
      {},
    );
    assert.notEqual(keyBefore, keyAfter);
    const afterStatus = (await get(`/api/status?since=${beforeStatus.fingerprint}`)).body;
    assert.equal(afterStatus.changed, true, "existing status checks detect calendar changes without new facts");
    assert.notEqual(afterStatus.fingerprint, beforeStatus.fingerprint);
    const live = await get(`${query}&skipCheck=1&calendarZone=utc`);
    assert.equal(live.cache, "miss", "a new IANA identity must not reuse the old summary");
    assert.equal(live.body.summary.range.timeZone, changedZone);
    assert.equal(live.body.summary.totals.total, changedZone === "Asia/Shanghai" ? 300 : 200);
    const paused = (await get(`${query}&snapshot=${frozen.snapshotId}&calendarZone=local`)).body;
    assert.equal(paused.metadata.calendarContext.timeZone, initialZone);
    assert.deepEqual(paused.summary, frozen.summary, "frozen calculations keep their captured IANA calendar");
    assert.equal(paused.fingerprint, frozen.fingerprint, "frozen identity also keeps the captured calendar");
    const resumed = (await get(`${query}&calendarZone=utc`)).body;
    assert.equal(resumed.summary.range.timeZone, changedZone);
    assert.deepEqual(resumed.summary.totals, live.body.summary.totals);
    if (process.env.CODEX_USAGE_CALENDAR_COLD !== "1") {
      const fullChanged = (await get(`${query.replace("/api/summary", "/api/usage")}&detail=full&calendarZone=utc`))
        .body;
      assert.equal(fullChanged.summary.range.timeZone, changedZone);
      assert.deepEqual(fullChanged.summary.totals, resumed.summary.totals);
      process.env.TZ = "Asia/Shanghai";
      let warmed = await get(query);
      for (let i = 0; i < 3 && warmed.cache !== "hit"; i++) warmed = await get(`${query}&skipCheck=1`);
      assert.equal(warmed.cache, "hit");
      const sameOffsetKey = summaryCacheKey({ preset: "all", now: new Date("2026-11-17T12:00Z") }, true, {});
      const offset = new Date("2026-11-17T12:00Z").getTimezoneOffset();
      process.env.TZ = "Asia/Singapore";
      assert.equal(new Date("2026-11-17T12:00Z").getTimezoneOffset(), offset);
      assert.notEqual(sameOffsetKey, summaryCacheKey({ preset: "all", now: new Date("2026-11-17T12:00Z") }, true, {}));
      const sameOffset = await get(`${query}&skipCheck=1`);
      assert.equal(sameOffset.cache, "miss", "even equal-offset IANA zones cannot share cached responses");
      assert.equal(sameOffset.body.summary.range.start, warmed.body.summary.range.start);
      assert.equal(sameOffset.body.summary.range.end, warmed.body.summary.range.end);
      assert.equal(sameOffset.body.summary.range.timeZone, "Asia/Singapore");
      process.env.TZ = changedZone;
    }

    changingExecutor = createUsageExecutor(fixture.serverOptions);
    const release = changingExecutor.retainWorker();
    try {
      await changingExecutor.open();
      const results = await Promise.all(
        [initialZone, changedZone, initialZone].map((timeZone) =>
          changingExecutor.dashboard({
            preset: "custom",
            startDate: "2026-11-17",
            endDate: "2026-11-17",
            calendarZone: "local",
            calendarContext: { timeZone },
          }),
        ),
      );
      assert.deepEqual(
        results.map((result) => result.summary.range.timeZone),
        [initialZone, changedZone, initialZone],
      );
      assert.deepEqual(
        results.map((result) => result.summary.totals.total),
        [expected, changedZone === "Asia/Shanghai" ? 300 : 200, expected],
      );
    } finally {
      release();
      await changingExecutor.close();
    }

    executor = createUsageExecutor({ ...fixture.serverOptions, calendarTimeZone: "America/New_York" });
    await executor.open();
    for (const [date, start, end] of [
      ["2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T03:59:59.999Z"],
      ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T04:59:59.999Z"],
      ["2028-02-29", "2028-02-29T05:00:00.000Z", "2028-03-01T04:59:59.999Z"],
      ["2026-12-31", "2026-12-31T05:00:00.000Z", "2027-01-01T04:59:59.999Z"],
    ]) {
      const result = await executor.dashboard({
        preset: "custom",
        startDate: date,
        endDate: date,
        calendarZone: "local",
      });
      assert.equal(result.summary.range.start, start);
      assert.equal(result.summary.range.end, end);
      assert.equal(result.summary.range.timeZone, "America/New_York");
    }
    const week = await executor.dashboard({
      preset: "week",
      calendarZone: "local",
      now: new Date("2026-03-09T04:30:00Z"),
    });
    assert.equal(week.summary.range.start, "2026-03-09T04:00:00.000Z", "Monday begins in the service calendar");
    for (const [preset, now, start, end] of [
      ["today", "2026-03-09T03:59:59Z", "2026-03-08T05:00:00.000Z", "2026-03-09T03:59:59.999Z"],
      ["today", "2026-03-09T04:00:00Z", "2026-03-09T04:00:00.000Z", "2026-03-10T03:59:59.999Z"],
      ["month", "2026-03-01T04:59:59Z", "2026-02-01T05:00:00.000Z", "2026-03-01T04:59:59.999Z"],
      ["month", "2026-03-01T05:00:00Z", "2026-03-01T05:00:00.000Z", "2026-03-02T04:59:59.999Z"],
      ["recent", "2027-01-01T04:59:59Z", "2026-01-01T05:00:00.000Z", "2027-01-01T04:59:59.999Z"],
      ["recent", "2027-01-01T05:00:00Z", "2027-01-01T05:00:00.000Z", "2027-01-02T04:59:59.999Z"],
    ]) {
      const result = await executor.dashboard({
        preset,
        recentValue: "今年",
        calendarZone: "local",
        now: new Date(now),
      });
      assert.equal(result.summary.range.start, start, `${preset} starts in the service calendar at ${now}`);
      assert.equal(result.summary.range.end, end, `${preset} ends in the service calendar at ${now}`);
    }
    const utc = await executor.dashboard({
      preset: "custom",
      startDate: "2026-03-08",
      endDate: "2026-03-08",
      calendarZone: "utc",
    });
    assert.equal(utc.summary.range.start, "2026-03-08T00:00:00.000Z", "internal UTC callers keep working");
    assert.equal(utc.summary.range.timeZone, "UTC");
    const capturedFile = path.join(fixture.reportOptions.homeDir, "fixed-calendar.sqlite");
    const capture = await executor.snapshot({ databaseFile: capturedFile, asOf: Date.parse("2026-11-17T12:00Z") });
    assert.equal(capture.calendarContext.timeZone, "America/New_York");
    frozenExecutor = createUsageExecutor({ databaseFile: capturedFile });
    await frozenExecutor.open({ frozen: capture });
    const restoredCapture = await frozenExecutor.dashboard({
      preset: "custom",
      startDate: "2026-03-08",
      endDate: "2026-03-08",
      calendarZone: "local",
    });
    assert.equal(restoredCapture.summary.range.start, "2026-03-08T05:00:00.000Z");
    assert.equal(
      restoredCapture.summary.range.timeZone,
      "America/New_York",
      "open restores capture context without an explicit new option",
    );
    assert.equal(calendarContext().timeZone, changedZone, "fixed reader TZ never changes the HTTP parent TZ");
    console.log("calendar checks passed");
  } finally {
    await executor?.close();
    await changingExecutor?.close();
    await frozenExecutor?.close();
    await server.close();
    fixture.close();
  }
}

async function isolatedArchiveCalendarCheck() {
  const fixture = createCodexIntegrationFixture();
  const server = createUsageServer({ ...fixture.serverOptions, edition: "waifu" });
  try {
    await listenOnFetchPort(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (url = "/api/achievements") => {
      const response = await fetch(base + url);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const ready = async (minimumAwardRevision = 0) => {
      for (let i = 0; i < 300; i++) {
        const snapshot = await get();
        if (snapshot.state === "ready" && !snapshot.refreshing && snapshot.awardRevision >= minimumAwardRevision)
          return snapshot;
        await delay(10);
      }
      assert.fail("Isolated archive did not publish");
    };
    const initial = await ready();
    assert.equal(initial.timeZone, "Asia/Shanghai");
    await appendFile(fixture.rolloutFiles[0], usage(new Date(Date.now() - 1).toISOString(), 100_000_000_000));
    await get("/api/summary?preset=all");
    const awarded = await ready(initial.awardRevision + 1);
    process.env.TZ = "America/Los_Angeles";
    const changed = await get("/api/summary?preset=all&calendarZone=utc");
    assert.equal(changed.summary.range.timeZone, "America/Los_Angeles");
    const after = await ready(awarded.awardRevision);
    assert.equal(after.profileId, initial.profileId);
    assert.equal(after.enabledAt, initial.enabledAt);
    assert.equal(after.timeZone, initial.timeZone);
    assert.equal(after.awardRevision, awarded.awardRevision);
    assert.deepEqual(
      after.rows.map((row) => [row.id, row.highestEarned, row.earnedAt, row.updatedAt]),
      awarded.rows.map((row) => [row.id, row.highestEarned, row.earnedAt, row.updatedAt]),
    );
    console.log("archive calendar checks passed");
  } finally {
    await server.close();
    fixture.close();
  }
}

if (process.env.CODEX_USAGE_CALENDAR_TEST_CHILD === "1") {
  if (process.env.CODEX_USAGE_CALENDAR_PROFILE === "1") await isolatedArchiveCalendarCheck();
  else await isolatedCalendarChecks();
} else {
  test("calendar context requires a concrete valid IANA identity", () => {
    assert.throws(() => calendarContext("local"));
    assert.throws(() => calendarContext(""));
    assert.throws(() => calendarContext("invalid/calendar"));
    assert.deepEqual(calendarContext("UTC"), { timeZone: "UTC" });
  });
  for (const timeZone of ["Asia/Shanghai", "America/Los_Angeles", "Pacific/Auckland"]) {
    test(`HTTP, frozen and fixed executor calendars stay coherent from ${timeZone}`, { timeout: 90_000 }, async () => {
      const result = await run(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, TZ: timeZone, CODEX_USAGE_CALENDAR_TEST_CHILD: "1" },
        windowsHide: true,
        timeout: 80_000,
      });
      assert.match(result.stdout, /calendar checks passed/);
    });
  }
  test("mixed cold/hot HTTP calendars preserve their frozen IANA across a live zone change", {
    timeout: 90_000,
  }, async () => {
    const result = await run(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        TZ: "Asia/Shanghai",
        CODEX_USAGE_CALENDAR_TEST_CHILD: "1",
        CODEX_USAGE_CALENDAR_COLD: "1",
      },
      windowsHide: true,
      timeout: 80_000,
    });
    assert.match(result.stdout, /calendar checks passed/);
  });
  test("live service zone changes preserve the archive IANA, T0 and earned dates", { timeout: 30_000 }, async () => {
    const result = await run(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        TZ: "Asia/Shanghai",
        CODEX_USAGE_CALENDAR_TEST_CHILD: "1",
        CODEX_USAGE_CALENDAR_PROFILE: "1",
      },
      windowsHide: true,
      timeout: 25_000,
    });
    assert.match(result.stdout, /archive calendar checks passed/);
  });
}
