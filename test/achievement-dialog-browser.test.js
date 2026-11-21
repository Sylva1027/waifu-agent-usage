import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { SKIN_PREFERENCE_KEY } from "../public/skins.js";
import { createAchievementUiFixture } from "../test-support/achievement-ui-fixture.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createUsageServer as createLiteUsageServer } from "../src/server-lite.js";

async function setup(t, options = {}) {
  const runtime = await resolveBrowserRuntime();
  assert.ok(runtime, "Desktop browser runtime is required for S09-A acceptance");
  let fixture;
  if (options.edition === "lite") {
    const source = await createPaletteFixture();
    const server = createLiteUsageServer(createPaletteServerOptions(source));
    fixture = {
      ...source,
      get url() {
        return `http://127.0.0.1:${server.address().port}`;
      },
      async close() {
        await server.close();
        await source.close();
      },
    };
    try {
      await listenOnFetchPort(server);
    } catch (error) {
      await fixture.close();
      throw error;
    }
  } else {
    fixture = await createAchievementUiFixture(options);
  }
  let browser;
  t.after(async () => {
    await browser?.close();
    await fixture.close();
  });
  if (options.edition !== "lite") await fixture.ready();
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await page.addInitScript((key) => {
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem("codexUsageLocale", "zh-CN");
    localStorage.setItem("codexUsageTheme", "dark");
    localStorage.setItem(key, JSON.stringify({ version: 1, skinId: "chatgpt", showCharacters: true, opacity: 0.5 }));
  }, SKIN_PREFERENCE_KEY);
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push({ path: new URL(request.url()).pathname, method: request.method() }));
  return { fixture, page, errors, requests };
}

async function open(page) {
  await page.locator("#achievementToggle").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#achievementDialog")?.open && !document.querySelector("#achievementList [role=status]"),
  );
}

async function box(page) {
  return page.locator("#achievementDialog").evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    const list = dialog.querySelector(".achievement-list-frame").getBoundingClientRect();
    const buttons = [...dialog.querySelectorAll("[data-category]")];
    const detail = dialog.querySelector(".detail-panel")?.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      listHeight: list.height,
      titleSize: getComputedStyle(dialog.querySelector("h2")).fontSize,
      categoryWidths: buttons.map((button) => button.getBoundingClientRect().width),
      categoryFonts: buttons.map((button) => getComputedStyle(button).fontSize),
      detailInside: !detail || (detail.left >= rect.left + 12 && detail.right <= rect.right - 12),
      scrollbar: getComputedStyle(dialog.querySelector(".list-well"), "::-webkit-scrollbar").width,
      clip: getComputedStyle(dialog.querySelector(".achievement-list-frame"), "::after").clipPath,
    };
  });
}

test("production modal uses real API progress and dates; material preview is read-only and a real upgrade survives reopening", async (t) => {
  const { fixture, page, errors, requests } = await setup(t);
  await page.goto(fixture.url);
  await open(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), "achievementTitle");
  await page.locator('[data-category="用量规模"]').click();
  await page.locator('[data-achievement="A01"]').click();
  const before = await (await fetch(`${fixture.url}/api/achievements`)).json();
  const row = before.rows.find((row) => row.id === "A01");
  assert.equal(row.highestEarned, "silver");
  assert.equal(row.earnedAt.bronze, row.earnedAt.silver, "Single scan awards share the exact date");
  assert.equal(
    await page.locator(".detail-panel > .badge").getAttribute("src"),
    "/assets/achievements/A01/silver.webp",
  );
  const bronzeDate = await page.locator('[data-preview-grade="bronze"]').getAttribute("title");
  assert.match(bronzeDate, /^获得日期 \d{4}\.\d{2}\.\d{2}$/);
  assert.equal(bronzeDate, await page.locator('[data-preview-grade="silver"]').getAttribute("title"));
  assert.equal(await page.locator('[data-preview-grade="gold"]').getAttribute("title"), null);
  assert.deepEqual(await page.locator(".metal-swatch > span:first-child").allTextContents(), ["50B", "200B", "5T"]);
  assert.match(await page.locator(".detail-panel .progress-meta").textContent(), /^226\.1B \/ 5T$/);
  await page.locator('[data-preview-grade="gold"]').click();
  assert.equal(await page.locator(".detail-panel > .badge").getAttribute("src"), "/assets/achievements/A01/gold.webp");
  assert.equal(
    await page.locator(".detail-panel > .badge").evaluate((badge) => getComputedStyle(badge).opacity),
    "0.22",
  );
  await page.locator('[data-preview-grade="silver"]').click();
  assert.equal(await page.locator(".detail-panel > .badge").evaluate((badge) => getComputedStyle(badge).opacity), "1");
  const afterPreview = await (await fetch(`${fixture.url}/api/achievements`)).json();
  assert.equal(afterPreview.awardRevision, before.awardRevision);
  assert.deepEqual(afterPreview.rows, before.rows);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.id), "achievementToggle");
  const upgraded = await fixture.addGold();
  await open(page);
  await page.waitForFunction(() => document.querySelector('[data-preview-grade="gold"]')?.title);
  assert.equal(upgraded.rows.find((row) => row.id === "A01").earnedAt.bronze, row.earnedAt.bronze);
  assert.ok(await page.locator('[data-preview-grade="gold"]').getAttribute("title"));
  await page.locator('[data-preview-grade="gold"]').click();
  assert.equal(await page.locator(".detail-panel > .badge").evaluate((badge) => getComputedStyle(badge).opacity), "1");
  assert.ok(
    requests.some((request) => request.path === "/api/achievements/seen" && request.method === "POST"),
    "A successfully displayed Recent view acknowledges its captured revision",
  );
  assert.deepEqual(errors, []);
});

test("S07 desktop geometry, filters, search, focus and bilingual themed card presentation remain stable", async (t) => {
  const { fixture, page, errors } = await setup(t);
  await page.goto(fixture.url);
  const pageOverflow = await page.evaluate(() => getComputedStyle(document.body).overflowY);
  await open(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflowY), pageOverflow);
  const initial = await box(page);
  assert.equal(initial.width, 980);
  assert.equal(initial.listHeight, 486);
  assert.equal(initial.titleSize, "16px");
  assert.deepEqual(initial.categoryFonts, Array(6).fill("15px"));
  assert.ok(Math.max(...initial.categoryWidths) - Math.min(...initial.categoryWidths) < 0.1);
  assert.equal(initial.scrollbar, "8px");
  assert.equal(initial.clip, "inset(0px 8px 0px 0px)");
  assert.ok(initial.detailInside);
  assert.equal(await page.locator("#achievementList .achievement-row").count(), 6);
  await mkdir("output/playwright", { recursive: true });
  await page.screenshot({ path: "output/playwright/s09-a-zh-dark-chatgpt.png" });
  await page.locator('[data-category="模型工具"]').click();
  assert.equal(await page.locator("#achievementList .achievement-row").count(), 10);
  assert.equal((await box(page)).height, initial.height);
  await page.locator('[data-achievement="A07"]').focus();
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/achievements"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refreshed;
  await page.waitForFunction(() => document.activeElement.dataset.achievement === "A07");
  await page.locator("#achievementSearch").fill("You're All My Wings");
  assert.equal(await page.locator("#achievementList .achievement-row").count(), 1);
  assert.equal(await page.locator("#achievementList .achievement-row").getAttribute("data-achievement"), "A07");
  await page.locator("#achievementSearch").fill("");
  await page.locator("#achievementStatusFilter").click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#achievementStatusMenu").isVisible(), false);
  assert.equal(await page.locator("#achievementDialog").evaluate((dialog) => dialog.open), true);
  await page.locator("#achievementStatusFilter").press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#achievementStatusValue").textContent(), "未获得");
  assert.ok(await page.locator("#achievementList .achievement-row.is-locked").count());
  assert.equal(await page.locator(".detail-date").textContent(), "");
  assert.equal((await box(page)).height, initial.height);
  await page.keyboard.press("Escape");
  await page.locator("#languageToggle").click();
  await open(page);
  assert.deepEqual(await page.locator("[data-category]").allTextContents(), [
    "Recent",
    "Toolkit",
    "Projects",
    "Usage",
    "Activity",
    "Stories",
  ]);
  assert.equal(await page.locator("#achievementTitle").textContent(), "Achievements");
  await page.locator("#achievementStatusFilter").click();
  await page.locator('[data-status="all"]').click();
  assert.equal(await page.locator("#achievementStatusValue").textContent(), "All");
  await page.locator('[data-category="故事纪念"]').click();
  await page.locator('[data-achievement="A76"]').click();
  assert.equal(await page.locator(".detail-panel h3").textContent(), "What a Long, Strange Trip It's Been");
  assert.equal(await page.locator(".detail-flavor").evaluate((node) => getComputedStyle(node).wordBreak), "normal");
  const geometry = await page.locator("#achievementDialog .detail-panel").boundingBox();
  const outer = await page.locator("#achievementDialog").boundingBox();
  assert.ok(geometry.y + geometry.height <= outer.y + outer.height - 12, "Long copy stays within the fixed modal");
  await mkdir("output/playwright", { recursive: true });
  await page.screenshot({ path: "output/playwright/s09-a-en-dark.png" });
  await page.keyboard.press("Escape");
  await page.locator("#themeToggle").click();
  await page.evaluate(async () => {
    const { state } = await import("/app-state.js");
    state.skinRuntime.setSkin("deepseek");
  });
  await open(page);
  assert.equal((await box(page)).height, initial.height);
  assert.ok((await box(page)).detailInside);
  await page.screenshot({ path: "output/playwright/s09-a-en-light-deepseek.png" });
  await page.mouse.click(10, 10);
  assert.equal(await page.locator("#achievementDialog").evaluate((dialog) => dialog.open), false);
  assert.deepEqual(errors, []);
});

test("an empty archive, initial network failure and retry never display invented awards; a later failure preserves complete rows", async (t) => {
  const { fixture, page, errors } = await setup(t, { empty: true });
  let reject = true;
  await page.route("**/api/achievements", async (route) => {
    if (reject) await route.fulfill({ status: 503, json: { error: "isolated failure" } });
    else await route.continue();
  });
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.querySelector("#totalTokens").textContent !== "-");
  await page.locator("#achievementToggle").click();
  await page.locator("[data-retry]").waitFor();
  assert.equal(await page.locator("#achievementList .achievement-row").count(), 0);
  reject = false;
  await page.locator("[data-retry]").click();
  await page.getByText("还没有近期成就", { exact: true }).waitFor();
  await page.locator('[data-category="用量规模"]').click();
  assert.equal(await page.locator("#achievementList .achievement-row").count(), 6);
  assert.equal(await page.locator("#achievementList .achievement-row:not(.is-locked)").count(), 0);
  assert.equal(await page.locator(".detail-date").textContent(), "");
  assert.equal(
    await page.locator(".detail-panel > .badge").getAttribute("src"),
    "/assets/achievements/A01/bronze.webp",
  );
  assert.equal(await page.locator('[data-preview-grade="bronze"]').getAttribute("aria-pressed"), "true");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    for (const grade of ["bronze", "silver", "gold"]) {
      await page.locator(`[data-preview-grade="${grade}"]`).click();
      const style = await page.locator(".detail-panel > .badge").evaluate((badge) => ({
        opacity: getComputedStyle(badge).opacity,
        filter: getComputedStyle(badge).filter,
        src: badge.getAttribute("src"),
      }));
      assert.deepEqual(style, { opacity: "0.22", filter: "none", src: `/assets/achievements/A01/${grade}.webp` });
    }
    assert.equal(
      await page
        .locator('#achievementList [data-achievement="A01"] .badge')
        .evaluate((badge) => getComputedStyle(badge).opacity),
      "0.22",
    );
  }
  await page.locator('[data-category="故事纪念"]').click();
  await page.locator('[data-achievement="A31"]').click();
  assert.equal(
    await page.locator(".detail-panel > .badge").evaluate((badge) => getComputedStyle(badge).opacity),
    "0.22",
  );
  await page.locator('[data-category="用量规模"]').click();
  reject = true;
  await page.keyboard.press("Escape");
  const failedResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/achievements") && response.status() === 503,
  );
  await page.locator("#achievementToggle").click();
  await failedResponse;
  assert.equal(await page.locator("#achievementList .achievement-row").count(), 6);
  assert.deepEqual(errors, []);
});

test("Lite page never creates the entry, dialog or frontend achievement dependency requests", async (t) => {
  const { fixture, page, errors, requests } = await setup(t, { edition: "lite" });
  const html = await readFile(new URL("../public/lite/index.html", import.meta.url), "utf8");
  assert.equal(await fetch(fixture.url).then((response) => response.text()), html);
  await page.goto(fixture.url);
  await page.locator('[data-preset="all"]').click();
  await page.waitForFunction(() => Number.parseFloat(document.querySelector("#totalTokens")?.textContent) > 0);
  assert.equal(await page.locator("html").getAttribute("data-edition"), "lite");
  assert.equal(await page.locator("#achievementToggle, #achievementDialog").count(), 0);
  assert.deepEqual(
    requests.filter((request) => /achievement-|assets\/achievements|\/api\/achievements/.test(request.path)),
    [],
  );
  assert.deepEqual(errors, []);
});
