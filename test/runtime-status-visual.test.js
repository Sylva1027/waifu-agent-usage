import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createUsageServer } from "../src/server.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";
import { SKIN_PREFERENCE_KEY } from "../public/skins.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FRAMES = [
  ".toolbar",
  "#autoRefreshStatus",
  ".auto-refresh-heading",
  ".auto-refresh-well",
  ".auto-refresh-info",
  "#dateRangeButton",
  ".date-range-controls",
  ".range-controls",
];
const MATERIAL = [
  "background",
  "boxShadow",
  "border",
  "borderRadius",
  "padding",
  "gap",
  "fontFamily",
  "fontSize",
  "lineHeight",
  "fontWeight",
  "color",
];

async function geometry(page) {
  return page.evaluate(
    ({ frames, material }) =>
      Object.fromEntries(
        frames.map((selector) => {
          const el = document.querySelector(selector),
            rect = el.getBoundingClientRect(),
            css = getComputedStyle(el);
          return [
            selector,
            {
              box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              style: Object.fromEntries(material.map((prop) => [prop, css[prop]])),
            },
          ];
        }),
      ),
    { frames: FRAMES, material: MATERIAL },
  );
}

function compare(before, after, label) {
  let maxDelta = 0;
  for (const selector of FRAMES) {
    for (const dimension of ["x", "y", "width", "height"]) {
      const delta = Math.abs(before[selector].box[dimension] - after[selector].box[dimension]);
      maxDelta = Math.max(maxDelta, delta);
      assert.ok(delta <= 1, `${label} ${selector} ${dimension}: ${delta}px`);
    }
    assert.deepEqual(after[selector].style, before[selector].style, `${label} ${selector} material/type`);
  }
  return maxDelta;
}

async function runtimeDOM(page) {
  return page.evaluate(() => {
    const status = document.querySelector("#runtimeStatusText"),
      spinner = document.querySelector("#autoRefreshSpinner");
    return {
      text: status.textContent,
      title: status.title,
      statusHidden: status.hidden,
      last: document.querySelector("#lastSuccessfulCheck").textContent,
      busy: spinner.classList.contains("is-loading"),
      spinner: { x: spinner.getBoundingClientRect().x, y: spinner.getBoundingClientRect().y },
      animation: {
        name: getComputedStyle(spinner).animationName,
        duration: getComputedStyle(spinner).animationDuration,
        easing: getComputedStyle(spinner).animationTimingFunction,
      },
      spinnerAriaHidden: spinner.getAttribute("aria-hidden"),
      error: document.querySelector("#autoRefreshError").textContent,
      errorHidden: document.querySelector("#autoRefreshError").hidden,
      pressed: document.querySelector("#autoRefreshToggle").getAttribute("aria-pressed"),
    };
  });
}

test("runtime status preserves real dashboard frames, live feedback and keyboard interactions", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    t.skip("No local browser runtime");
    return;
  }
  const evidence = process.env.RUNTIME_STATUS_EVIDENCE_DIR;
  const baselineDir = process.env.RUNTIME_STATUS_BASELINE_DIR;
  const fixture = await createPaletteFixture();
  const server = createUsageServer({ ...createPaletteServerOptions(fixture), executorIdleTimeoutMs: 60_000 });
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  });
  const snapshots = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  const files = [
    "public/index.html",
    "public/styles.css",
    "public/app.js",
    "public/app-state.js",
    "public/i18n.js",
    "src/server.js",
    "src/usage-executor.js",
    "scripts/skin-palette/roles.mjs",
    "scripts/skin-palette/browser-measure.mjs",
  ];
  const hashes = await Promise.all(
    files.map(async (file) => ({
      file,
      sha256: createHash("sha256")
        .update(await readFile(path.join(ROOT, file)))
        .digest("hex"),
    })),
  );
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({
    executablePath: runtime.executablePath,
    headless: true,
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const capture = async (page, key) => {
    if (!evidence) return;
    await page.screenshot({ path: path.join(evidence, `${key}.png`) });
    await page.locator(".toolbar").screenshot({ path: path.join(evidence, `${key}-toolbar.png`) });
  };
  const session = async (viewport, locale, theme, skin, before = false) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: "Asia/Shanghai" });
    await context.addInitScript(
      ({ locale, theme, skin, skinKey }) => {
        localStorage.setItem("codexUsageLocale", locale);
        localStorage.setItem("codexUsageTheme", theme);
        localStorage.setItem("codexUsageAutoRefresh", "off");
        localStorage.setItem(skinKey, JSON.stringify({ version: 1, skinId: skin, showCharacters: true, opacity: 0.5 }));
        window.__visualActivity = [];
        const NativeEventSource = window.EventSource;
        window.EventSource = class extends NativeEventSource {
          constructor(url, options) {
            super(url, options);
            this.addEventListener("activity-state", (event) =>
              window.__visualActivity.push({ url: String(url), snapshot: JSON.parse(event.data) }),
            );
          }
        };
      },
      { locale, theme, skin, skinKey: SKIN_PREFERENCE_KEY },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (before)
      await page.route("**/*", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const file = pathname === "/" ? "index.html" : pathname.slice(1);
        if (!file.includes("/") && /\.(html|css|js)$/.test(file)) {
          const contentType = file.endsWith(".html")
            ? "text/html"
            : file.endsWith(".css")
              ? "text/css"
              : "text/javascript";
          return route.fulfill({ body: await readFile(path.join(baselineDir, "public", file)), contentType });
        }
        return route.continue();
      });
    const initialPricing = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/pricing/refresh",
    );
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // Initial pricing starts after boot has bound the dashboard controls.
    await initialPricing;
    assert.equal(await page.locator("html").getAttribute("data-skin"), skin);
    await page.locator('#presetButtons button[data-preset="all"]').click();
    await page.waitForFunction(() => Number.parseFloat(document.querySelector("#totalTokens")?.textContent) > 0);
    await page.waitForFunction(async () => !(await import("/app-state.js")).state.runtimeTasks?.length);
    await page.locator("#autoRefreshSpinner.is-loading").waitFor({ state: "hidden" });
    await page.evaluate(() => document.fonts.ready);
    return { context, page, errors };
  };

  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 960, height: 1080 },
  ]) {
    for (const locale of ["zh-CN", "en-US"])
      for (const theme of ["light", "dark"])
        for (const skin of ["classic", "chatgpt"]) {
          await t.test(`${viewport.width} ${locale} ${theme} ${skin}`, async () => {
            const key = `${viewport.width}x${viewport.height}-${locale}-${theme}-${skin}`;
            let before;
            if (baselineDir) {
              const baseline = await session(viewport, locale, theme, skin, true);
              try {
                before = await geometry(baseline.page);
                await capture(baseline.page, `${key}-before`);
                assert.deepEqual(baseline.errors, []);
              } finally {
                await baseline.context.close();
              }
            }
            const current = await session(viewport, locale, theme, skin);
            const { page } = current;
            try {
              const normal = await geometry(page);
              const record = {
                key,
                viewport,
                locale,
                theme,
                skin,
                before,
                normal,
                states: [],
                maxDelta: before ? compare(before, normal, key) : 0,
              };
              snapshots.push(record);
              assert.equal(
                await page.locator("#autoRefreshToggle").textContent(),
                locale === "en-US" ? "Auto Refresh" : "自动刷新",
              );
              assert.match((await runtimeDOM(page)).text, locale === "en-US" ? /paused/i : /已暂停/);
              await capture(page, `${key}-after`);
              if (viewport.width === 960) await page.emulateMedia({ reducedMotion: "reduce" });
              const checked = async (label) => {
                const measured = await geometry(page);
                record.maxDelta = Math.max(record.maxDelta, compare(normal, measured, `${key} ${label}`));
                record.states.push({ label, geometry: measured, dom: await runtimeDOM(page) });
              };
              // Gate the real HTTP response; every payload still comes from the isolated production service.
              const release = Promise.withResolvers(),
                arrived = Promise.withResolvers();
              let requestFinished = Promise.resolve();
              await page.route(
                "**/api/usage?**",
                (route) => {
                  requestFinished = (async () => {
                    const response = await route.fetch();
                    arrived.resolve();
                    await release.promise;
                    await route.fulfill({ response });
                  })();
                  return requestFinished;
                },
                { times: 1 },
              );
              try {
                await page.locator('#presetButtons button[data-preset="today"]').click();
                const immediate = await runtimeDOM(page);
                assert.equal(immediate.busy, true, "filter must register busy before its HTTP response");
                assert.ok(immediate.text.trim());
                assert.deepEqual(immediate.animation, {
                  name: "auto-refresh-spin",
                  duration: "1s",
                  easing: "steps(3)",
                });
                await arrived.promise;
                await checked("busy-real-filter-response-held");
                if (viewport.width === 1920) await capture(page, `${key}-busy`);
              } finally {
                release.resolve();
                await requestFinished;
              }
              await page.locator("#autoRefreshSpinner.is-loading").waitFor({ state: "hidden" });
              await checked("filter-finished");
              assert.match((await runtimeDOM(page)).text, locale === "en-US" ? /paused/i : /已暂停/);
              assert.equal((await runtimeDOM(page)).errorHidden, true);
              await page.waitForFunction(() => window.__visualActivity.length > 0);
              record.activity = await page.evaluate(() => window.__visualActivity);
              assert.ok(
                record.activity.some((event) => event.url.includes("watch=0")),
                "paused page observes real SSE passively",
              );

              await page.evaluate(() => {
                const status = document.querySelector("#runtimeStatusText");
                status.textContent = "正在计算统计… Calculating statistics… ".repeat(12);
                status.title = status.textContent;
              });
              await checked("long-status");
              const overflow = await page.locator("#runtimeStatusText").evaluate((node) => ({
                overflow: getComputedStyle(node).textOverflow,
                right: node.getBoundingClientRect().right,
                zoneLeft: document.querySelector(".auto-refresh-well").getBoundingClientRect().right,
                title: node.title,
              }));
              assert.equal(overflow.overflow, "ellipsis");
              assert.ok(overflow.right <= overflow.zoneLeft, "long status remains inside the recessed refresh well");
              assert.ok(overflow.title.length > 200);
              const spinnerPosition = (await runtimeDOM(page)).spinner;
              for (const text of locale === "en-US"
                ? ["Last: never", "Last: just now", "Last: 59 min ago", "Last: 23 h ago", "Last: >1 day"]
                : ["上次：尚无", "上次：刚刚", "上次：59分钟前", "上次：23小时前", "上次：大于1天"]) {
                await page.locator("#lastSuccessfulCheck").evaluate((node, text) => {
                  node.textContent = text;
                }, text);
                assert.deepEqual(
                  (await runtimeDOM(page)).spinner,
                  spinnerPosition,
                  "relative time never moves the reserved spinner slot",
                );
                await checked(`relative-time:${text}`);
              }

              if (viewport.width === 1920 && skin === "classic") {
                await page.locator("#autoRefreshToggle").focus();
                await page.keyboard.press("Enter");
                await page.waitForFunction(
                  () => document.querySelector("#autoRefreshToggle").getAttribute("aria-pressed") === "true",
                );
                await page.locator("#autoRefreshSpinner.is-loading").waitFor({ state: "hidden" });
                await checked("ready-enabled");
                await page.keyboard.press("Space");
                await page.waitForFunction(
                  () => document.querySelector("#autoRefreshToggle").getAttribute("aria-pressed") === "false",
                );
                await page.locator("#autoRefreshSpinner.is-loading").waitFor({ state: "hidden" });
                assert.match(
                  await page
                    .locator("#autoRefreshToggle")
                    .evaluate((node) => getComputedStyle(node).textDecorationLine),
                  /line-through/,
                );
                await page.keyboard.press("Tab");
                assert.equal(
                  await page.evaluate(() => document.activeElement.closest("#timelineModes") !== null),
                  true,
                );
                await page.keyboard.press("Shift+Tab");
                assert.equal(await page.evaluate(() => document.activeElement.id), "autoRefreshToggle");
                await page.locator("#recentValue").focus();
                await page.keyboard.press("ArrowDown");
                assert.equal(await page.locator("#recentRangeMenu").isVisible(), true);
                await page.keyboard.press("Escape");
                assert.equal(await page.locator("#recentRangeMenu").isVisible(), false);
                assert.equal(await page.evaluate(() => document.activeElement.id), "recentValue");

                await current.context.setOffline(true);
                await page.locator('#presetButtons button[data-preset="all"]').click();
                await page.locator("#autoRefreshError.is-error").waitFor({ state: "visible" });
                await checked("real-network-error");
                await capture(page, `${key}-error`);
                await page.locator("#autoRefreshError").focus();
                await page.keyboard.press("Enter");
                await checked("error-details-open");
                await capture(page, `${key}-error-details`);
                assert.equal(await page.evaluate(() => document.activeElement.id), "autoRefreshErrorText");
                await page.locator("#autoRefreshErrorBack").click();
                assert.equal(await page.evaluate(() => document.activeElement.id), "autoRefreshError");
                await current.context.setOffline(false);
                await page.locator('#presetButtons button[data-preset="today"]').click();
                await page.locator("#autoRefreshSpinner.is-loading").waitFor({ state: "hidden" });
                assert.equal(await page.locator("#autoRefreshError").isVisible(), false);
                await checked("recovered");
              }
              assert.deepEqual(current.errors, []);
            } finally {
              await current.context.close();
            }
          });
        }
  }
  if (evidence) {
    await writeFile(path.join(evidence, "measurements.json"), `${JSON.stringify(snapshots, null, 2)}\n`);
    await writeFile(path.join(evidence, "source-hashes.json"), `${JSON.stringify(hashes, null, 2)}\n`);
  }
});
