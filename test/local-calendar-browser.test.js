import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createAchievementUiFixture } from "../test-support/achievement-ui-fixture.mjs";
import { calendarParts, dateKey } from "../public/calendar.js";
import { shareCardFilename } from "../public/share-card-data.js";

test("a browser in a different time zone ignores the old UTC preference and uses the service's captured calendar for dates and sharing", async (t) => {
  const fixture = await createAchievementUiFixture();
  let browser;
  t.after(async () => {
    await browser?.close();
    await fixture.close();
  });
  await fixture.ready();
  const runtime = await resolveBrowserRuntime();
  assert.ok(runtime);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Pacific/Honolulu" });
  await context.addInitScript(() => {
    localStorage.setItem("codexUsageCalendarZoneV2", "utc");
    localStorage.setItem("codexUsageLocale", "zh-CN");
    localStorage.setItem("codexUsageAutoRefresh", "off");
  });
  const page = await context.newPage();
  const queries = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["/api/usage", "/api/summary"].includes(url.pathname)) queries.push(url);
  });
  await page.clock.setFixedTime(new Date("2026-01-01T00:30:00Z"));
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.querySelector("#totalTokens").textContent !== "-");
  assert.equal(await page.locator("#calendarZoneSelect, #calendarZoneMenu").count(), 0);
  assert.equal(
    await page.evaluate(async () => Object.hasOwn((await import("/app-state.js")).state, "calendarZone")),
    false,
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/usage" && new URL(response.url()).searchParams.get("preset") === "all",
  );
  await page.locator('[data-preset="all"]').click();
  const payload = await (await responsePromise).json();
  const captured = { range: payload.summary.range, context: payload.metadata.calendarContext };
  const expectedLabel = `${dateKey(new Date(captured.range.start), captured.range.timeZone)} 至 ${dateKey(new Date(captured.range.end), captured.range.timeZone)}`;
  await page.waitForFunction((label) => document.querySelector("#rangeLabel").textContent === label, expectedLabel);
  assert.equal(captured.range.timeZone, captured.context.timeZone);
  assert.notEqual(captured.context.timeZone, "Pacific/Honolulu");
  const parts = calendarParts(new Date("2026-01-01T00:30:00Z"), captured.context.timeZone);
  await page.locator("#dateRangeButton").click();
  assert.equal(
    await page.locator(".date-picker-title").textContent(),
    `${parts.year}年${String(parts.month).padStart(2, "0")}月`,
  );
  await page.keyboard.press("Escape");
  assert.ok(queries.length > 0);
  assert.ok(queries.every((url) => !url.searchParams.has("calendarZone")));
  assert.equal(await page.locator("#rangeLabel").textContent(), expectedLabel);
  await page.locator("#shareToggle").click();
  await page.locator("#saveShareImage:not([disabled])").waitFor();
  const name = await page.evaluate(async () => {
    const { state } = await import("/app-state.js");
    const { shareCardFilename } = await import("/share-card-data.js");
    return shareCardFilename(state.summary.range);
  });
  assert.equal(name, shareCardFilename(captured.range));
});
