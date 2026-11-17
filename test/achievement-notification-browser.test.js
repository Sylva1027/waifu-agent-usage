import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createAchievementUiFixture } from "../test-support/achievement-ui-fixture.mjs";
import { SKIN_PREFERENCE_KEY } from "../public/skins.js";

const row = (snapshot, id) => snapshot.rows.find((item) => item.id === id);

async function setup(t, options = {}) {
  const runtime = await resolveBrowserRuntime();
  assert.ok(runtime, "Desktop browser runtime is required for S09-B acceptance");
  const fixture = await createAchievementUiFixture(options);
  let browser;
  const errors = [];
  t.after(async () => {
    await browser?.close();
    await fixture.close();
    assert.deepEqual(errors, []);
  });
  await fixture.ready();
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const newPage = async ({ autoRefresh = false } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await context.addInitScript(
      ({ key, autoRefresh }) => {
        localStorage.setItem("codexUsageAutoRefresh", autoRefresh ? "on" : "off");
        localStorage.setItem("codexUsageLocale", "zh-CN");
        localStorage.setItem("codexUsageTheme", "dark");
        localStorage.setItem(
          key,
          JSON.stringify({ version: 1, skinId: "chatgpt", showCharacters: true, opacity: 0.5 }),
        );
        window.achievementTestEvents = [];
        window.achievementTestStreams = [];
        window.achievementTestConnections = 0;
        window.achievementTestIntervals = [];
        const NativeEventSource = window.EventSource;
        window.EventSource = class extends NativeEventSource {
          constructor(url, options) {
            super(url, options);
            window.achievementTestStreams.push(String(url));
            this.addEventListener("open", () => window.achievementTestConnections++);
            this.addEventListener("achievement-state", (event) => {
              window.achievementTestEvents.push(JSON.parse(event.data));
            });
          }
        };
        const interval = window.setInterval;
        window.setInterval = (callback, ms, ...args) => {
          window.achievementTestIntervals.push(ms);
          return interval(callback, ms, ...args);
        };
      },
      { key: SKIN_PREFERENCE_KEY, autoRefresh },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const requests = [];
    const sseResponses = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) =>
      requests.push({ path: new URL(request.url()).pathname, method: request.method(), request }),
    );
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/usage-events")
        sseResponses.push({
          url: response.url(),
          status: response.status(),
          contentType: response.headers()["content-type"],
        });
    });
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname === "/api/usage-events")
        sseResponses.push({ url: request.url(), error: request.failure()?.errorText });
    });
    return { page, requests, sseResponses };
  };
  return { fixture, newPage };
}

async function visit(page, fixture) {
  await page.goto(fixture.url);
  await page.locator("#achievementNotice").waitFor({ state: "attached" });
  await page.waitForFunction(() => document.querySelector("#totalTokens").textContent !== "-");
  await page.waitForFunction(() => window.achievementTestEvents.length > 0);
}

async function notice(page, visible) {
  await page.waitForFunction((shown) => {
    const button = document.querySelector("#achievementNotice");
    return button && !button.hidden === shown;
  }, visible);
}

async function eventAt(page, snapshot) {
  await page.waitForFunction(
    ({ progressRevision, awardRevision, seenAwardRevision }) =>
      window.achievementTestEvents.some(
        (event) =>
          event.progressRevision >= progressRevision &&
          event.awardRevision >= awardRevision &&
          event.seenAwardRevision >= seenAwardRevision,
      ),
    snapshot,
  );
}

async function post(fixture, path, body) {
  const response = await fetch(fixture.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: fixture.url },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function acknowledge(fixture, snapshot) {
  await post(fixture, "/api/achievements/seen", {
    profileId: snapshot.profileId,
    seenThroughRevision: snapshot.awardRevision,
  });
  return fixture.waitForSnapshot((value) => value.seenAwardRevision === snapshot.awardRevision);
}

async function viewRecent(page, fixture, shown) {
  await page.locator("#achievementNotice").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#achievementDialog").open && document.querySelector("#achievementDetail .detail-panel"),
  );
  assert.equal(await page.locator('[data-category="近期获得"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#achievementSearch").inputValue(), "");
  assert.equal(await page.locator("#achievementStatusValue").textContent(), "全部状态");
  await fixture.waitForSnapshot((snapshot) => snapshot.seenAwardRevision === shown.awardRevision);
  await notice(page, false);
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector("#achievementDialog").open && document.activeElement.id === "achievementToggle",
  );
  await notice(page, false);
  assert.equal(await page.evaluate(() => document.activeElement.id), "achievementToggle");
}

// Pause actual production requests/responses; award JSON always comes from the real server.
async function hold(t, page, path, { response = false } = {}) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let held = false;
  const handler = async (route) => {
    if (held) return route.continue();
    held = true;
    try {
      const upstream = response ? await route.fetch() : null;
      entered.resolve(response ? await upstream.json() : route.request().postDataJSON());
      await release.promise;
      if (upstream) await route.fulfill({ response: upstream });
      else await route.continue();
    } finally {
      finished.resolve();
    }
  };
  await page.route(`**${path}`, handler);
  t.after(() => release.resolve());
  return {
    entered: entered.promise,
    async release() {
      release.resolve();
      await finished.promise;
      await page.unroute(`**${path}`, handler);
    },
  };
}

test("real multi-award batch merges into one S07 notice; cross-level upgrade, progress and bilingual styles stay correct", {
  timeout: 60_000,
}, async (t) => {
  const { fixture, newPage } = await setup(t, { empty: true });
  const { page, requests } = await newPage();
  await visit(page, fixture);
  await notice(page, false);
  const before = await fixture.snapshot();
  const earned = await fixture.appendBatch([
    { total: 210_000_000_000 },
    { model: "hy4free", total: 15_000_000_000 },
    { model: "claude-sonnet-4", total: 1_100_000_000 },
  ]);
  assert.equal(earned.awardRevision, before.awardRevision + 1);
  assert.ok(new Set(earned.awards.map((award) => award.id)).size > 6);
  assert.equal(row(earned, "A01").highestEarned, "silver");
  assert.equal(row(earned, "A01").earnedAt.bronze, row(earned, "A01").earnedAt.silver);
  assert.equal(new Set(earned.awards.map((award) => award.earnedAt)).size, 1);
  await eventAt(page, earned);
  await notice(page, true);
  assert.equal(await page.locator("#achievementNotice").count(), 1);
  assert.equal(await page.locator("#achievementNotice").textContent(), "新成就");
  const style = await page.locator("#achievementNotice").evaluate((button) => {
    const css = getComputedStyle(button);
    const well = button.parentElement.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const status = document.querySelector(".auto-refresh-info").getBoundingClientRect();
    return {
      parent: button.parentElement.className,
      font: css.fontSize,
      weight: css.fontWeight,
      line: css.lineHeight,
      border: css.borderTopWidth,
      shadow: css.boxShadow,
      background: css.backgroundColor,
      glow: css.textShadow,
      animation: css.animationName,
      inside: rect.right <= well.right && rect.left >= status.right,
      children: button.childElementCount,
    };
  });
  assert.equal(style.parent, "auto-refresh-well");
  assert.equal(style.font, "13px");
  assert.equal(style.weight, "650");
  assert.equal(style.line, "19px");
  assert.equal(style.border, "0px");
  assert.equal(style.shadow, "none");
  assert.equal(style.background, "rgba(0, 0, 0, 0)");
  assert.match(style.glow, /6px/);
  assert.equal(style.animation, "none");
  assert.equal(style.inside, true);
  assert.equal(style.children, 0);
  await viewRecent(page, fixture, earned);
  assert.equal(await page.locator("#achievementList .achievement-row").count(), 6);
  await page.locator("#achievementToggle").click();
  await page.waitForFunction(() => document.querySelector("#achievementDialog").open);
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector("#achievementDialog").open && document.activeElement.id === "achievementToggle",
  );
  assert.equal(await page.evaluate(() => document.activeElement.id), "achievementToggle");

  const progress = await fixture.appendBatch([{ total: 1 }]);
  assert.ok(progress.progressRevision > earned.progressRevision);
  assert.equal(BigInt(row(progress, "A01").observedValue), BigInt(row(earned, "A01").observedValue) + 1n);
  assert.equal(progress.awardRevision, earned.awardRevision);
  assert.deepEqual(progress.awards, earned.awards);
  await eventAt(page, progress);
  await notice(page, false);

  const upgraded = await fixture.addGold();
  assert.equal(row(upgraded, "A01").highestEarned, "gold");
  assert.equal(row(upgraded, "A01").earnedAt.bronze, row(earned, "A01").earnedAt.bronze);
  await notice(page, true);
  await page.locator("#languageToggle").click();
  await page.waitForFunction(() => document.querySelector("#achievementNotice").textContent === "New achievement");
  await page.locator("#themeToggle").click();
  assert.equal(
    await page.locator("#achievementNotice").evaluate((node) => getComputedStyle(node).borderTopWidth),
    "0px",
  );
  assert.equal(await page.locator("#achievementNotice").evaluate((node) => getComputedStyle(node).boxShadow), "none");
  assert.ok(
    !requests.some(({ path }) => path === "/api/status"),
    "watch=0 notification delivery never asks for a usage check",
  );
});

test("two independent pages including watch=0 share persistent unread state across restart without new polling", {
  timeout: 60_000,
}, async (t) => {
  const { fixture, newPage } = await setup(t);
  const a = await newPage();
  const b = await newPage({ autoRefresh: true });
  const requireReconnection = async (counts) => {
    try {
      await Promise.all(
        [a.page, b.page].map((page, index) =>
          page.waitForFunction((count) => window.achievementTestConnections > count, counts[index]),
        ),
      );
    } catch (error) {
      t.diagnostic(
        `SSE reconnect failure: ${JSON.stringify(
          await Promise.all(
            [a, b].map(async ({ page, sseResponses }) => ({
              responses: sseResponses,
              state: await page.evaluate(async () => {
                const { state } = await import("/app-state.js");
                return {
                  url: state.usageEventsSource?.url,
                  readyState: state.usageEventsSource?.readyState,
                  connections: window.achievementTestConnections,
                };
              }),
            })),
          ),
        )}`,
      );
      throw error;
    }
  };
  await Promise.all([visit(a.page, fixture), visit(b.page, fixture)]);
  await Promise.all([notice(a.page, true), notice(b.page, true)]);
  assert.deepEqual(await a.page.evaluate(() => window.achievementTestStreams), ["/api/usage-events?watch=0"]);
  assert.ok((await b.page.evaluate(() => window.achievementTestStreams)).includes("/api/usage-events"));
  const before = await fixture.snapshot();
  await viewRecent(a.page, fixture, before);
  await notice(b.page, false);
  await post(fixture, "/api/achievements/seen", { profileId: before.profileId, seenThroughRevision: 0 });
  assert.equal((await fixture.snapshot()).seenAwardRevision, before.awardRevision);

  const upgrade = await fixture.addGold();
  await Promise.all([notice(a.page, true), notice(b.page, true)]);
  const previousConnections = await Promise.all(
    [a.page, b.page].map((page) => page.evaluate(() => window.achievementTestConnections)),
  );
  t.diagnostic("restarting unread fixture with both SSE clients connected");
  const restarted = await fixture.restart();
  t.diagnostic("unread restart complete");
  await requireReconnection(previousConnections);
  assert.equal(restarted.profileId, before.profileId);
  assert.equal(restarted.enabledAt, before.enabledAt);
  assert.equal(restarted.seenAwardRevision, before.awardRevision);
  assert.deepEqual(restarted.awards, upgrade.awards);
  await Promise.all([eventAt(a.page, restarted), eventAt(b.page, restarted)]);
  await viewRecent(b.page, fixture, restarted);
  await notice(a.page, false);
  const readConnections = await Promise.all(
    [a.page, b.page].map((page) => page.evaluate(() => window.achievementTestConnections)),
  );
  t.diagnostic("restarting acknowledged fixture with both SSE clients connected");
  const readRestart = await fixture.restart();
  t.diagnostic("acknowledged restart complete");
  await requireReconnection(readConnections);
  assert.equal(readRestart.seenAwardRevision, readRestart.awardRevision);
  await visit(a.page, fixture);
  await notice(a.page, false);
  const timers = await a.page.evaluate(() => ({
    intervals: window.achievementTestIntervals,
    streams: window.achievementTestStreams,
  }));
  assert.deepEqual(
    timers.intervals,
    [60_000, 3_600_000],
    "only the existing relative check-time and pricing intervals remain",
  );
  assert.deepEqual(timers.streams, ["/api/usage-events?watch=0"]);
  await a.page.waitForTimeout(250);
  const counts = a.requests.filter(({ path }) => path === "/api/achievements").length;
  await a.page.waitForTimeout(1_200);
  assert.equal(
    a.requests.filter(({ path }) => path === "/api/achievements").length,
    counts,
    "idle pages do not poll achievements",
  );
  assert.ok(!a.requests.some(({ path }) => path === "/api/status"));
});

test("a delayed real seen request acknowledges only the displayed version and leaves an award earned while viewing unread", {
  timeout: 60_000,
}, async (t) => {
  const { fixture, newPage } = await setup(t);
  const { page } = await newPage();
  await visit(page, fixture);
  await notice(page, true);
  const displayed = await fixture.snapshot();
  const gate = await hold(t, page, "/api/achievements/seen");
  await page.locator("#achievementNotice").click();
  const body = await gate.entered;
  assert.deepEqual(body, { profileId: displayed.profileId, seenThroughRevision: displayed.awardRevision });
  const newer = await fixture.addGold();
  assert.ok(newer.awardRevision > displayed.awardRevision);
  await eventAt(page, newer);
  await page.keyboard.press("Escape");
  await gate.release();
  const after = await fixture.waitForSnapshot((snapshot) => snapshot.seenAwardRevision >= displayed.awardRevision);
  assert.equal(after.seenAwardRevision, displayed.awardRevision);
  assert.equal(after.awardRevision, newer.awardRevision);
  await notice(page, true);
  await viewRecent(page, fixture, after);
});

test("a delayed real GET cannot roll back a newer event or acknowledge an unseen upgrade", {
  timeout: 60_000,
}, async (t) => {
  const { fixture, newPage } = await setup(t);
  const initial = await fixture.snapshot();
  await acknowledge(fixture, initial);
  const { page } = await newPage();
  await visit(page, fixture);
  await notice(page, false);
  const gate = await hold(t, page, "/api/achievements", { response: true });
  await page.locator("#achievementToggle").click();
  const stale = await gate.entered;
  assert.equal(stale.awardRevision, initial.awardRevision);
  const newer = await fixture.addGold();
  await eventAt(page, newer);
  await page.keyboard.press("Escape");
  await gate.release();
  await notice(page, true);
  assert.equal((await fixture.snapshot()).seenAwardRevision, initial.awardRevision);
  await viewRecent(page, fixture, newer);
});

test("failed fetch/seen and empty search never clear unread; notice resets retained filters before displaying recent", {
  timeout: 60_000,
}, async (t) => {
  const { fixture, newPage } = await setup(t);
  const { page, requests } = await newPage();
  let failGet = true;
  const fail = (route) => (failGet ? route.abort("failed") : route.continue());
  await page.route("**/api/achievements", fail);
  await page.goto(fixture.url);
  await page.locator("#achievementToggle").click();
  await page.locator("[data-retry]").waitFor();
  assert.equal(requests.filter(({ path }) => path === "/api/achievements/seen").length, 0);
  failGet = false;
  await page.locator("[data-retry]").click({ force: true });
  await page.waitForFunction(() => !!document.querySelector("#achievementDetail .detail-panel"));
  await fixture.waitForSnapshot((snapshot) => snapshot.seenAwardRevision === snapshot.awardRevision);
  await notice(page, false);
  await page.locator('[data-category="模型工具"]').click();
  await page.locator("#achievementStatusFilter").click();
  await page.locator('[data-status="locked"]').click();
  await page.locator("#achievementSearch").fill("no-such-achievement");
  const seenBefore = requests.filter(({ path }) => path === "/api/achievements/seen").length;
  const upgraded = await fixture.addGold();
  await eventAt(page, upgraded);
  await page.mouse.click(10, 10);
  await page.waitForFunction(() => !document.querySelector("#achievementDialog").open);
  assert.equal(requests.filter(({ path }) => path === "/api/achievements/seen").length, seenBefore);
  await notice(page, true);
  const rejectSeen = (route) => route.abort("failed");
  await page.route("**/api/achievements/seen", rejectSeen);
  const failed = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url().endsWith("/api/achievements/seen"),
  });
  await page.locator("#achievementNotice").click();
  await failed;
  assert.equal(await page.locator("#achievementSearch").inputValue(), "");
  assert.equal(await page.locator('[data-category="近期获得"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#achievementStatusValue").textContent(), "全部状态");
  assert.ok((await fixture.snapshot()).seenAwardRevision < upgraded.awardRevision);
  await page.keyboard.press("Escape");
  await notice(page, true);
  await page.unroute("**/api/achievements/seen", rejectSeen);
  await viewRecent(page, fixture, upgraded);
});

test("a successful real share download awards A43 and notifies a second page without new usage; replay does not award again", {
  timeout: 60_000,
}, async (t) => {
  const { fixture, newPage } = await setup(t);
  const a = await newPage();
  const b = await newPage();
  const baseline = await acknowledge(fixture, await fixture.snapshot());
  await Promise.all([visit(a.page, fixture), visit(b.page, fixture)]);
  await Promise.all([notice(a.page, false), notice(b.page, false)]);
  await a.page.locator('[data-preset="all"]').click();
  await a.page.waitForFunction(() => !document.querySelector("#shareToggle").disabled);
  await a.page.locator("#shareToggle").click();
  await a.page.waitForFunction(() => !document.querySelector("#saveShareImage").disabled);
  assert.equal(row(await fixture.snapshot(), "A43").highestEarned, null);
  const operation = a.page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/achievements/operations") && response.request().postDataJSON().kind === "share",
  );
  const download = a.page.waitForEvent("download");
  await a.page.locator("#saveShareImage").click();
  await download;
  const response = await operation;
  const receipt = response.request().postDataJSON();
  assert.equal(response.status(), 200);
  const shared = await fixture.waitForSnapshot((snapshot) => row(snapshot, "A43").highestEarned === "bronze");
  assert.equal(shared.awardRevision, baseline.awardRevision + 1);
  assert.equal(row(shared, "A01").observedValue, row(baseline, "A01").observedValue);
  await notice(b.page, true);
  const replay = await post(fixture, "/api/achievements/operations", receipt);
  assert.equal(replay.recorded, false);
  assert.equal(replay.snapshot.awardRevision, shared.awardRevision);
});
