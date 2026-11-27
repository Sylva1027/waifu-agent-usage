// From the repo root: node scripts/motion-glass/dashboard-benchmark.mjs [--output=output/playwright/dashboard-glass]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveBrowserRuntime } from "../skin-palette/capture.mjs";
import { createUsageServer } from "../../src/server.js";
import { listenOnFetchPort } from "../../test-support/fetch-port.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../../test-support/skin-palette-fixture.mjs";
import { recordTrace, summarizeTrace } from "./trace.mjs";

const baseline = "8410bc0f88bf1174f53e7e91a8439c0849fd30f5";
const { values } = parseArgs({ options: { output: { type: "string" } } });
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
const output = resolve(values.output ?? `output/playwright/dashboard-glass/${runId}`);
const frameSelector = "[data-glass-frame], [data-glass-frame-list] > .comparison-item";
const tracked = new Set(
  execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", baseline, "public"], { encoding: "utf8" }).split("\0"),
);
const cached = new Map();
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".json": "application/json",
};

async function originalFrontend(route) {
  const path = decodeURIComponent(new URL(route.request().url()).pathname);
  if (path.startsWith("/api/")) return route.continue();
  const file = path === "/" ? "public/index.html" : `public${path}`;
  if (!tracked.has(file)) return route.fulfill({ status: 404, body: "Not found" });
  if (!cached.has(file))
    cached.set(file, execFileSync("git", ["show", `${baseline}:${file}`], { maxBuffer: 64 * 1024 * 1024 }));
  return route.fulfill({ body: cached.get(file), contentType: mime[extname(file)] || "application/octet-stream" });
}

const runtime = await resolveBrowserRuntime();
assert.ok(runtime, "A local Chromium runtime is required.");
await mkdir(output, { recursive: true });
// Reserve the evidence set before any trace opens, including when two launches race.
const resultsFile = resolve(output, "results.json");
try {
  await writeFile(resultsFile, JSON.stringify({ status: "recording", baseline }), { flag: "wx" });
} catch (error) {
  if (values.output && error.code === "EEXIST")
    throw new Error(`Results already exist in ${output}. Choose another --output directory.`, { cause: error });
  throw error;
}
const fixture = await createPaletteFixture();
const server = createUsageServer(createPaletteServerOptions(fixture));
let browser;
try {
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const cdp = await browser.newBrowserCDPSession();
  const { gpu } = await cdp.send("SystemInfo.getInfo");
  await cdp.detach();
  const viewport = { width: 1440, height: 900 };
  const environment = {
    browser: browser.version(),
    gpu: gpu.auxAttributes?.glRenderer,
    viewport,
    deviceScaleFactor: 1,
    headless: true,
  };
  const openPage = async (mode, idle = false) => {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    if (mode === "previous") await page.route("**/*", originalFrontend);
    else await page.route("**/*", (route) => route.continue());
    await page.addInitScript((idle) => {
      localStorage.setItem("codexUsageAutoRefresh", "off");
      localStorage.setItem("codexUsageTheme", "light");
      if (idle) {
        const raf = window.requestAnimationFrame.bind(window);
        window.audit = { feature: 0, all: 0, enabled: false };
        window.requestAnimationFrame = (cb) => {
          if (window.audit.enabled) {
            window.audit.all++;
            if (/waifu-(?:motion|liquid-glass|frame-glass)[^/]*\.js/.test(new Error().stack)) window.audit.feature++;
          }
          return raf(cb);
        };
      }
    }, idle);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(
      () =>
        window.__skinTestHook &&
        document.querySelector("#homeList .home-row") &&
        document.querySelector("#skinToggle .lg-pane")?.style.backdropFilter.includes("-baked"),
    );
    await page.evaluate(() => document.fonts.ready);
    assert.equal((await page.locator(frameSelector).count()) > 0, mode === "dashboard", `${mode} frontend identity`);
    if (mode === "dashboard") await page.waitForSelector("html[data-frame-refraction]", { state: "attached" });
    await page.waitForTimeout(1100);
    return page;
  };

  async function scroll(page) {
    const distance = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    assert.ok(distance > 0);
    const session = await page.context().newCDPSession(page);
    try {
      const gesture = (yDistance) =>
        session.send("Input.synthesizeScrollGesture", {
          x: 5,
          y: 400,
          yDistance,
          speed: 1400,
          preventFling: true,
          gestureSourceType: "mouse",
        });
      await gesture(-distance - 4);
      const bottom = await page.evaluate(() => scrollY);
      assert.ok(bottom >= distance - 4, `Scroll must expose the bottom panels (${bottom}/${distance}).`);
      await gesture(distance + 4);
      await page.waitForFunction(() => scrollY < 2);
      return { distance, bottom };
    } finally {
      await session.detach();
    }
  }

  async function refresh(page) {
    const totals = [];
    for (const preset of ["all", "today"]) {
      const previous = await page.locator("#totalTokens").textContent();
      const requested = page.waitForResponse((response) => {
        const u = new URL(response.url());
        return u.pathname === "/api/usage" && u.searchParams.get("preset") === preset;
      });
      await page.locator(`#presetButtons [data-preset="${preset}"]`).click();
      assert.ok((await requested).ok());
      await page.waitForFunction((previous) => {
        const text = document.querySelector("#totalTokens").textContent;
        return text !== previous && text !== "-";
      }, previous);
      totals.push(await page.locator("#totalTokens").textContent());
    }
    return { totals };
  }

  const runs = [];
  for (const [round, order] of [
    ["previous", "dashboard"],
    ["dashboard", "previous"],
    ["previous", "dashboard"],
  ].entries()) {
    for (const mode of order) {
      const page = await openPage(mode);
      try {
        for (const [name, action] of [
          ["scroll", scroll],
          ["refresh", refresh],
        ]) {
          const file = `trace-${round + 1}-${mode}-${name}.json`;
          const detail = await recordTrace(page, resolve(output, file), async () => {
            await page.evaluate(() => {
              let last;
              window.frameSample = [];
              const frame = (t) => {
                if (last !== undefined) window.frameSample.push(t - last);
                last = t;
                window.sampleId = requestAnimationFrame(frame);
              };
              window.sampleId = requestAnimationFrame(frame);
            });
            const data = await action(page);
            const intervals = await page.evaluate(() => {
              cancelAnimationFrame(window.sampleId);
              return window.frameSample;
            });
            return { ...data, intervals };
          });
          const sorted = [...detail.intervals].sort((a, b) => a - b);
          assert.ok(sorted.length > 0);
          runs.push({ mode, round: round + 1, name, file, ...detail, p95: sorted[Math.floor(sorted.length * 0.95)] });
        }
      } finally {
        await page.close();
      }
    }
  }
  const idles = {};
  for (const mode of ["previous", "dashboard"]) {
    const page = await openPage(mode, true);
    try {
      await page.evaluate(() => {
        window.audit.enabled = true;
      });
      await page.locator("#skinToggle").dispatchEvent("pointerdown", { isPrimary: true, pointerId: 1, button: 0 });
      await page.waitForTimeout(90);
      await page.locator("#skinToggle").dispatchEvent("pointercancel", { isPrimary: true, pointerId: 1 });
      await page.waitForTimeout(1200);
      idles[mode] = await page.evaluate(async (frameSelector) => {
        const positiveControl = window.audit.feature;
        window.audit.feature = window.audit.all = 0;
        let writes = 0;
        // Direct frame attributes plus the feature's decorative nodes. Business content can keep updating.
        const observer = new MutationObserver((records) => {
          writes += records.length;
        });
        for (const node of document.querySelectorAll(frameSelector)) observer.observe(node, { attributes: true });
        for (const node of document.querySelectorAll(
          "[data-glass-surface], [data-motion-indicator], .lg-cover, .lg-tick, #mg-frame-static, #mg-frame-active",
        ))
          observer.observe(node, { subtree: true, attributes: true, childList: true });
        const start = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        observer.disconnect();
        window.audit.enabled = false;
        return {
          positiveControl,
          featureRafs: window.audit.feature,
          pageRafs: window.audit.all,
          writes,
          duration: performance.now() - start,
        };
      }, frameSelector);
    } finally {
      await page.close();
    }
  }
  for (const run of runs) run.pipeline = await summarizeTrace(resolve(output, run.file));
  await writeFile(resultsFile, JSON.stringify({ baseline, environment, runs, idles }, null, 2));
  console.log(JSON.stringify({ output, idles }));
  for (const idle of Object.values(idles)) {
    assert.ok(idle.positiveControl > 0, "The idle probe must observe a real spring before timing starts.");
    assert.equal(idle.featureRafs, 0);
    assert.equal(idle.writes, 0);
  }
} finally {
  await browser?.close();
  if (server.listening) await server.close();
  await fixture.close();
}
