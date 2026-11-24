import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { summarizeUsage } from "../src/usage-core.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";

test("share hooks submit only after copy/download success, capture pre-await receipt and keep standard isolated", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) return t.skip("Chromium runtime is unavailable");
  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
  const index = await readFile(path.join(publicDir, "index.html"), "utf8");
  const dialogs = index.slice(index.indexOf('<dialog id="shareDialog"'), index.indexOf('<script src="/app.js"'));
  const requests = [];
  let failOperation = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/achievements/operations") {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.writeHead(failOperation ? 503 : 200, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    if (url.pathname === "/") {
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          `<!doctype html><html data-edition="${url.searchParams.get("edition") === "standard" ? "standard" : "waifu"}"><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/share.css"></head><body><button id="shareToggle">Share</button><dialog id="achievementFixture"><button id="achievementFixtureShare">Share achievement</button></dialog>${dialogs}</body></html>`,
        );
      return;
    }
    const filename = path.resolve(publicDir, `.${url.pathname}`);
    if (!filename.startsWith(publicDir)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const content = await readFile(filename);
      res.writeHead(200, { "Content-Type": filename.endsWith(".js") ? "text/javascript" : "text/css" }).end(content);
    } catch {
      res.writeHead(404).end();
    }
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    navigator.clipboard.write = async () => {
      window.copyStarted = true;
      if (window.copyMode === "fail") throw new Error("copy failed");
      if (window.copyMode === "pending")
        await new Promise((resolve) => {
          window.finishCopy = resolve;
        });
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const now = "2026-11-17T01:00:00.000Z";
  const summary = summarizeUsage(
    {
      events: [
        {
          timestamp: now,
          model: "gpt-6",
          sessionId: "s",
          homeId: "h",
          total: { total: 100, input: 75, cached: 25, output: 25, reasoning: 0 },
        },
      ],
    },
    { preset: "today", now, calendarZone: "utc" },
  );
  const open = async (receipt, target = page) => {
    await target.evaluate(
      async ({ summary, receipt }) => {
        const { openShareDialog } = await import("/share-dialog.js");
        openShareDialog({ summary, locale: "en-US", achievementReceipt: receipt });
      },
      { summary, receipt },
    );
    await target.waitForFunction(() => !document.querySelector("#copyShareImage").disabled);
  };
  const close = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const dialog = document.querySelector("#shareDialog");
          dialog.addEventListener("close", resolve, { once: true });
          dialog.close();
        }),
    );
  const posted = (receipt) =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/achievements/operations") &&
        response.request().postDataJSON().receipt === receipt,
    );
  await open("old-snapshot");
  assert.equal(requests.length, 0, "Opening/rendering is not a success");
  await page.evaluate(() => {
    window.copyMode = "fail";
  });
  await page.locator("#copyShareImage").click();
  await page.waitForFunction(() => document.querySelector("#shareStatus").textContent.includes("Could not copy"));
  assert.equal(requests.length, 0, "Failed clipboard writes are not recorded");

  await page.evaluate(() => {
    window.copyMode = "pending";
    window.copyStarted = false;
  });
  await page.locator("#copyShareImage").click();
  await page.waitForFunction(() => window.copyStarted);
  await close();
  await open("new-snapshot");
  const oldPosted = posted("old-snapshot");
  await page.evaluate(() => window.finishCopy());
  await oldPosted;
  assert.deepEqual(requests, [{ kind: "share", receipt: "old-snapshot" }]);

  await page.evaluate(() => {
    window.originalDownloadClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {
      throw new Error("download failed");
    };
  });
  const failedDownload = page.waitForEvent("pageerror");
  await page.locator("#saveShareImage").click();
  assert.equal((await failedDownload).message, "download failed");
  assert.equal(requests.length, 1, "A failed download trigger is not recorded");
  await page.evaluate(() => {
    HTMLAnchorElement.prototype.click = window.originalDownloadClick;
  });

  failOperation = true;
  const download = page.waitForEvent("download");
  const attempted = posted("new-snapshot");
  await page.locator("#saveShareImage").click();
  assert.ok((await download).suggestedFilename().endsWith(".png"));
  await attempted;
  failOperation = false;
  await page.evaluate(async () => {
    await (await import("/achievement-events.js")).retryAchievementOperations();
  });
  assert.deepEqual(requests.slice(1), [
    { kind: "share", receipt: "new-snapshot" },
    { kind: "share", receipt: "new-snapshot" },
  ]);
  await close();
  await open(null);
  const noReceiptDownload = page.waitForEvent("download");
  await page.locator("#saveShareImage").click();
  await noReceiptDownload;
  assert.equal(requests.length, 3, "Missing receipts never prevent sharing or fabricate a success");
  await close();

  const openAchievement = (imageMode) =>
    page.evaluate(async (imageMode) => {
      const { openAchievementShareDialog } = await import("/share-dialog.js");
      const fixture = document.querySelector("#achievementFixture");
      if (!fixture.open) fixture.showModal();
      window.copyMode = null;
      openAchievementShareDialog({
        opener: fixture.querySelector("button"),
        locale: "en-US",
        title: "Let's Sync Up",
        render: () => {
          if (imageMode === "fail") throw new Error("render failed");
          const picture = document.createElement("canvas");
          picture.width = 960;
          picture.height = 1200;
          if (imageMode === "pending") {
            return new Promise((resolve) => {
              window.finishAchievementImage = () => picture.toBlob(resolve);
            });
          }
          return new Promise((resolve) => picture.toBlob(resolve));
        },
      });
    }, imageMode);

  await page.setViewportSize({ width: 350, height: 600 });
  await openAchievement("pending");
  assert.equal(await page.locator("#shareStatus").textContent(), "Creating image…");
  await close();
  await openAchievement("fail");
  await page.evaluate(() => window.finishAchievementImage());
  await page.waitForFunction(() => document.querySelector("#shareStatus").textContent.includes("Image could not load"));
  assert.equal(await page.locator("#shareImage").getAttribute("src"), null);
  assert.equal(await page.locator("#shareImage").getAttribute("aria-busy"), "false");
  await close();

  await openAchievement("ready");
  await page.waitForFunction(() => !document.querySelector("#saveShareImage").disabled);
  assert.equal(await page.locator("#shareTitle").textContent(), "Share achievement");
  assert.equal(await page.locator("#shareDialog").getAttribute("data-layout"), "achievement");
  assert.equal(await page.locator(".share-customize").isVisible(), false);
  assert.equal(await page.locator("#shareImage").getAttribute("alt"), "Let's Sync Up");
  assert.ok(await page.locator("#shareDialog").evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  await page.locator("#openShareImage").click();
  assert.equal(await page.locator("#shareOriginalDialog").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement.id === "openShareImage");
  await page.locator("#copyShareImage").click();
  await page.waitForFunction(() => document.querySelector("#shareCopyHint").textContent === "Image copied");
  const achievementDownload = page.waitForEvent("download");
  await page.locator("#saveShareImage").click();
  assert.equal((await achievementDownload).suggestedFilename(), "waifu-achievement-Let's Sync Up.png");
  assert.equal(requests.length, 3, "Sharing a badge does not create a usage share receipt");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement.id === "achievementFixtureShare");
  assert.equal(await page.locator("#achievementFixture").isVisible(), true);
  await page.keyboard.press("Escape");
  await open(null);
  assert.equal(await page.locator("#shareDialog").getAttribute("data-layout"), "portrait");
  assert.equal(await page.locator(".share-customize").isVisible(), true);

  const standard = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const standardModules = [];
  standard.on("request", (request) => {
    if (request.url().includes("achievement")) standardModules.push(request.url());
  });
  await standard.goto(`http://127.0.0.1:${server.address().port}/?edition=standard`);
  await open("standard-ignored", standard);
  const standardDownload = standard.waitForEvent("download");
  await standard.locator("#saveShareImage").click();
  await standardDownload;
  assert.deepEqual(standardModules, [], "Standard never loads the Waifu-only module or endpoints");
  assert.deepEqual(errors, ["download failed"]);
});
