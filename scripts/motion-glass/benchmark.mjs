// Run from the repository root: node scripts/motion-glass/benchmark.mjs [pre-Motion-Glass git revision]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { resolveBrowserRuntime } from "../skin-palette/capture.mjs";
import { createUsageServer } from "../../src/server.js";
import { listenOnFetchPort } from "../../test-support/fetch-port.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../../test-support/skin-palette-fixture.mjs";

const baseline = process.argv[2] ?? "270f906438f35b45527fe8133e75cc0964bd8d32";
const output = resolve("output/playwright/motion-glass-benchmark");
const samples = [];
const traces = [];
const referenceFiles = new Map(
  ["index.html", "app.js", "styles.css"].map((name) => [
    name,
    execFileSync("git", ["show", `${baseline}:public/${name}`], { maxBuffer: 4 * 1024 * 1024 }),
  ]),
);
const runtime = await resolveBrowserRuntime();
assert.ok(runtime, "Set AGENT_USAGE_PLAYWRIGHT_MODULE and AGENT_USAGE_EDGE_PATH to a local Chromium runtime.");
await mkdir(output, { recursive: true });
const variants = {};
for (const mode of ["A", "B"]) {
  // Freeze only the two optical outputs; mount, sizing, material and the production spring remain the same.
  const result = await build({
    entryPoints: ["scripts/motion-glass/glass.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    minify: true,
    legalComments: "inline",
    write: false,
    outdir: "unused",
    plugins: [
      {
        name: "benchmark-optics",
        setup(builder) {
          builder.onLoad({ filter: /liquid-glass\.ts$/ }, async ({ path }) => {
            const source = await readFile(path, "utf8");
            const method = "setOptics(multiplier: number, highlight: number) {";
            assert.equal(source.split(method).length, 2, "Verify the material adapter before running A/B.");
            return {
              loader: "ts",
              resolveDir: resolve("scripts/motion-glass/nordify"),
              contents: source.replace(
                method,
                method + (mode === "A" ? "multiplier = 1; highlight = 0;" : "multiplier = 1;"),
              ),
            };
          });
        },
      },
    ],
  });
  variants[mode] = result.outputFiles.find((file) => file.path.endsWith(".js")).contents;
}

const fixture = await createPaletteFixture();
const server = createUsageServer(createPaletteServerOptions(fixture));
let browser;
try {
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const browserCDP = await browser.newBrowserCDPSession();
  const { gpu } = await browserCDP.send("SystemInfo.getInfo");
  await browserCDP.detach();
  const environment = {
    browser: browser.version(),
    node: process.version,
    platform: process.platform,
    renderer: gpu.auxAttributes?.glRenderer,
    gpu: gpu.devices.map(({ vendorString, deviceString }) => ({ vendorString, deviceString })),
    viewport: { width: 1440, height: 900 },
    dpr: 1,
    headless: true,
  };
  const openPage = async (mode, idleProbe = false) => {
    const page = await browser.newPage({ viewport: environment.viewport, deviceScaleFactor: environment.dpr });
    if (mode === "baseline") {
      await page.route(/\/(?:index\.html|app\.js|styles\.css)?(?:\?|$)/, (route) => {
        const name = new URL(route.request().url()).pathname.slice(1) || "index.html";
        const body = referenceFiles.get(name);
        if (!body) return route.continue();
        const contentType = { "app.js": "text/javascript", "styles.css": "text/css", "index.html": "text/html" }[name];
        return route.fulfill({ body, contentType: `${contentType}; charset=utf-8` });
      });
    } else if (mode !== "C") {
      await page.route("**/waifu-liquid-glass.js", (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body:
            mode === "none"
              ? "export function mountGlass(){return {setVisible(){},setOptics(){},destroy(){}}}"
              : Buffer.from(variants[mode]),
        }),
      );
    }
    await page.addInitScript(() => localStorage.setItem("codexUsageAutoRefresh", "off"));
    if (idleProbe) {
      await page.addInitScript(() => {
        const request = window.requestAnimationFrame.bind(window);
        window.motionAuditRAF = { enabled: false, feature: 0, all: 0 };
        window.requestAnimationFrame = (fn) => {
          const counts = window.motionAuditRAF;
          if (counts.enabled) {
            counts.all++;
            if (/waifu-(?:motion-controls|liquid-glass)\.js/.test(new Error().stack)) counts.feature++;
          }
          return request(fn);
        };
      });
    }
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => !!window.__skinTestHook && document.querySelector("#homeList .home-row"));
    await page.evaluate(() => document.fonts.ready);
    if (mode !== "baseline") await page.waitForSelector("#timelineModes[data-motion-ready]", { state: "attached" });
    if (mode === "none")
      await page.addStyleTag({ content: "#skinToggle > [data-glass-surface]{display:none!important}" });
    else if (mode !== "baseline") {
      await page.waitForFunction(() => document.querySelector(".lg-pane")?.style.backdropFilter.includes("-baked"));
    }
    await page.waitForTimeout(1100);
    return page;
  };

  // Synthetic primary pointer down/up isolates the production press handlers from the skin dialog's click.
  const trajectory = (page) =>
    page.evaluate(async () => {
      const button = document.querySelector("#skinToggle");
      const intervals = [],
        scales = new Set(),
        highlights = new Set(),
        longTasks = [],
        longFrames = [];
      let last, raf;
      function frame(time) {
        if (last !== undefined) intervals.push(time - last);
        last = time;
        raf = requestAnimationFrame(frame);
      }
      const optics = new MutationObserver((records) => {
        for (const { target, attributeName } of records) {
          if (attributeName === "scale" && target.closest("filter")?.id.startsWith("lg-refract"))
            scales.add(target.getAttribute("scale"));
          if (target.matches(".lg-cover")) highlights.add(target.style.getPropertyValue("--lg-press-highlight"));
        }
      });
      optics.observe(button, { subtree: true, attributes: true, attributeFilter: ["scale", "style"] });
      const observers = [];
      for (const [type, target] of [
        ["longtask", longTasks],
        ["long-animation-frame", longFrames],
      ]) {
        if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
        const observer = new PerformanceObserver((list) => target.push(...list.getEntries().map((e) => e.duration)));
        observer.observe({ type });
        observers.push(observer);
      }
      raf = requestAnimationFrame(frame);
      const start = performance.now();
      const waitUntil = (ms) =>
        new Promise((resolve) => setTimeout(resolve, Math.max(0, start + ms - performance.now())));
      for (let n = 0; n < 8; n++) {
        for (const [type, offset] of [
          ["pointerdown", 150],
          ["pointerup", 315],
        ]) {
          await waitUntil(n * 600 + offset);
          button.dispatchEvent(
            new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 1, pointerType: "mouse", button: 0 }),
          );
        }
      }
      await waitUntil(5000);
      cancelAnimationFrame(raf);
      optics.disconnect();
      for (const observer of observers) observer.disconnect();
      return { intervals, longTasks, longFrames, distinctScales: scales.size, distinctHighlights: highlights.size };
    });

  const orders = [
    ["baseline", "none", "A", "B", "C"],
    ["B", "C", "baseline", "none", "A"],
    ["A", "B", "C", "none", "baseline"],
  ];
  for (const [round, order] of orders.entries())
    for (const mode of order) {
      const page = await openPage(mode);
      try {
        const sample = await trajectory(page);
        assert.equal(sample.distinctScales > 1, mode === "C", `${mode} refraction path`);
        assert.equal(sample.distinctHighlights > 1, ["B", "C"].includes(mode), `${mode} highlight path`);
        const sorted = [...sample.intervals].sort((a, b) => a - b);
        assert.ok(sorted.length > 1);
        samples.push({
          mode,
          round: round + 1,
          ...sample,
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          max: sorted.at(-1),
        });
        console.log(mode, round + 1, "P95 ms", samples.at(-1).p95);
      } finally {
        await page.close();
      }
    }

  // Trace separate runs so Chrome tracing never affects the untraced comparisons.
  for (const mode of ["baseline", "none", "A", "B", "C"]) {
    const page = await openPage(mode);
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Tracing.start", {
        categories: "devtools.timeline,cc,viz,gpu,benchmark",
        transferMode: "ReturnAsStream",
      });
      await trajectory(page);
      const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
      await cdp.send("Tracing.end");
      const { stream } = await done;
      const name = `trace-${mode}.json`,
        file = await open(resolve(output, name), "w");
      try {
        let chunk;
        do {
          chunk = await cdp.send("IO.read", { handle: stream });
          await file.writeFile(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
        } while (!chunk.eof);
      } finally {
        await file.close();
        await cdp.send("IO.close", { handle: stream });
      }
      traces.push(name);
    } finally {
      await page.close();
    }
  }

  const page = await openPage("C", true);
  await page.evaluate(() => {
    window.motionAuditRAF.enabled = true;
  });
  await trajectory(page);
  await page.waitForTimeout(1200);
  const idle = await page.evaluate(async () => {
    const counts = window.motionAuditRAF;
    const positiveControl = counts.feature;
    counts.feature = counts.all = 0;
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    for (const node of document.querySelectorAll("#skinToggle, [data-motion-indicator], .lg-cover, .lg-tick"))
      observer.observe(node, { subtree: true, childList: true, attributes: true });
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    observer.disconnect();
    counts.enabled = false;
    return {
      durationMs: performance.now() - start,
      featureRafRequests: counts.feature,
      pageRafRequests: counts.all,
      mutations,
      positiveControl,
    };
  });
  await page.close();
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify({ baseline, environment, orders, samples, traces, idle }, null, 2),
  );
  console.log(JSON.stringify({ environment, idle, traces, output }));
  assert.ok(idle.positiveControl > 0, "Idle rAF attribution must first detect real spring requests.");
  assert.equal(idle.featureRafRequests, 0);
  assert.equal(idle.mutations, 0);
} finally {
  await browser?.close();
  if (server.listening) await server.close();
  await fixture.close();
}
