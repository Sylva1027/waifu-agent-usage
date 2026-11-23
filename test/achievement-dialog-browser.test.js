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
  browser = await runtime.chromium.launch({
    executablePath: runtime.executablePath,
    headless: true,
    args: options.graphics ? ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] : [],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    hasTouch: options.hasTouch ?? false,
  });
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

test("only the displayed earned tier loads and draws the 3D badge; redraws, fallback and closing preserve the original", async (t) => {
  const { fixture, page, errors, requests } = await setup(t, { graphics: true, hasTouch: true });
  const bundle = "/waifu-achievement-badge.js";
  const canvas = page.locator("#achievementDetail .badge-canvas");
  const image = page.locator(".detail-panel > img.badge");
  await page.addInitScript(() => {
    const clear = WebGL2RenderingContext.prototype.clear;
    window.badgeFrames = [];
    WebGL2RenderingContext.prototype.clear = function (...args) {
      if (this.canvas.classList.contains("badge-canvas")) window.badgeFrames.push(performance.now());
      return clear.apply(this, args);
    };
  });
  await page.goto(fixture.url);
  await open(page);
  await page.locator('[data-category="用量规模"]').click();
  await page.locator('[data-achievement="A01"]').click();
  assert.equal(await canvas.count(), 0, "Reduced motion uses the WebP on an earned tier");
  await page.locator('[data-preview-grade="gold"]').click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await canvas.count(), 0, "A locked gold preview on an earned silver badge stays static");
  assert.equal(requests.filter(({ path }) => path === bundle).length, 0);

  // Hold a real module response until the user has already left the earned tier.
  const loading = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route(
    `**${bundle}`,
    async (route) => {
      loading.resolve();
      await release.promise;
      await route.continue();
    },
    { times: 1 },
  );
  await page.locator('[data-preview-grade="silver"]').click();
  await loading.promise;
  assert.equal(await image.evaluate((node) => getComputedStyle(node).opacity), "1");
  await page.locator('[data-preview-grade="gold"]').click();
  const arrived = page.waitForResponse((response) => new URL(response.url()).pathname === bundle);
  release.resolve();
  await arrived;
  assert.equal(await canvas.count(), 0);
  assert.equal(await image.evaluate((node) => getComputedStyle(node).opacity), "0.22");
  assert.equal(await page.evaluate(() => window.badgeFrames.length), 0);

  await page.locator('[data-preview-grade="silver"]').click();
  await page.locator(".detail-panel > .badge-canvas.is-ready").waitFor();
  const retained = await canvas.elementHandle();
  for (const [height, size] of [
    [1000, 120],
    [660, 72],
  ]) {
    await page.setViewportSize({ width: 1440, height });
    const original = await image.boundingBox();
    assert.equal(original.width, size);
    assert.deepEqual(await canvas.boundingBox(), original);
  }
  await page.locator('[data-preview-grade="silver"]').click();
  assert.ok(await retained.evaluate((node) => node === document.querySelector(".detail-panel > canvas")));
  assert.equal(await image.evaluate((node) => getComputedStyle(node).opacity), "0");
  const badgeBox = await image.boundingBox();
  assert.equal(
    await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches),
    false,
    "The primary input is touch while a separate mouse drives the badge",
  );
  for (const [edge, x, y, axis, sign] of [
    ["left", 0.1, 0.5, 2, 1],
    ["right", 0.9, 0.5, 2, -1],
    ["top", 0.5, 0.1, 6, -1],
    ["bottom", 0.5, 0.9, 6, 1],
  ]) {
    await page.mouse.move(badgeBox.x + badgeBox.width * x, badgeBox.y + badgeBox.height * y);
    // In the actual vertex shader's model-view matrix, entries 2 and 6 are the
    // right/up axes' camera-space Z components. Increasing Z approaches the viewer.
    await page
      .waitForFunction(
        ([axis, sign]) => {
          const gl = document.querySelector(".badge-canvas").getContext("webgl2");
          const program = gl.getParameter(gl.CURRENT_PROGRAM);
          const location = program && gl.getUniformLocation(program, "modelViewMatrix");
          return location && gl.getUniform(program, location)[axis] * sign > 0.04;
        },
        [axis, sign],
        { timeout: 4000 },
      )
      .catch((cause) => {
        throw new Error(`Hovering the ${edge} edge must tilt it away from the viewer`, { cause });
      });
  }
  const frameTimes = await image.evaluate(async (node) => {
    const rect = node.getBoundingClientRect();
    const start = performance.now();
    window.badgeFrames = [];
    await new Promise((done) => {
      function move(now) {
        if (now - start >= 1500) return done();
        node.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
            clientX: rect.left + rect.width * (0.5 + Math.sin(now / 140) * 0.4),
            clientY: rect.top + rect.height / 2,
          }),
        );
        requestAnimationFrame(move);
      }
      requestAnimationFrame(move);
    });
    return window.badgeFrames;
  });
  assert.ok(frameTimes.length >= 2 && frameTimes.length <= 20, `Unexpected draw count in 1.5 s: ${frameTimes.length}`);
  await page.locator("#achievementDetail").dispatchEvent("pointerleave");
  await page.waitForTimeout(250);
  const idle = await page.evaluate(() => window.badgeFrames.length);
  await image.dispatchEvent("pointermove", {
    pointerType: "touch",
    clientX: badgeBox.x + badgeBox.width * 0.9,
    clientY: badgeBox.y + badgeBox.height * 0.5,
  });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.badgeFrames.length), idle);
  await canvas.evaluate((node) => node.getContext("webgl2").getExtension("WEBGL_lose_context").loseContext());
  await canvas.waitFor({ state: "detached" });
  assert.equal(await image.evaluate((node) => getComputedStyle(node).opacity), "1");
  assert.ok(await image.evaluate((node) => node.complete && node.naturalWidth === 256));
  await page.locator('[data-preview-grade="bronze"]').click();
  await page.locator(".badge-canvas.is-ready").waitFor();
  await page.keyboard.press("Escape");
  await canvas.waitFor({ state: "detached" });
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
  const { fixture, page, errors, requests } = await setup(t, { empty: true });
  await page.emulateMedia({ reducedMotion: "no-preference" });
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
  assert.equal(await page.locator(".detail-panel > canvas").count(), 0);
  assert.equal(requests.filter(({ path }) => path === "/waifu-achievement-badge.js").length, 0);
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
