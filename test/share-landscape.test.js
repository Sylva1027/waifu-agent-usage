import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { compactCurrency, groupTrend, landscapeCardHtml } from "../public/share-landscape.js";
import { shareMetricParts } from "../public/share-metrics.js";
import { SKIN_PREFERENCE_KEY, skinAssetUrl } from "../public/skins.js";
import { createUsageServer } from "../src/server.js";
import { createShareRangeFixture } from "../test-support/share-range-fixture.mjs";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";

test("landscape aggregation preserves every bucket and currency rounding promotes units", () => {
  for (const length of [0, 1, 7, 8, 24, 31, 168, 365]) {
    const rows = Array.from({ length }, (_, i) => ({ key: String(i), total: i * 3 }));
    const before = structuredClone(rows),
      grouped = groupTrend(rows);
    assert.ok(grouped.length <= 7);
    assert.equal(
      grouped.reduce((sum, row) => sum + row.total, 0),
      rows.reduce((sum, row) => sum + row.total, 0),
    );
    if (length) {
      assert.equal(grouped[0].key, rows[0].key);
      assert.equal(grouped.at(-1).endKey, rows.at(-1).key);
    }
    if (length === 24) assert.equal(grouped.length, 6);
    assert.deepEqual(rows, before);
  }
  for (const [value, expected] of [
    [0, "$0"],
    [0.49, "$0"],
    [0.5, "$1"],
    [100.49, "$100"],
    [100.5, "$101"],
    [100.76, "$101"],
    [999.49, "$999"],
    [999.5, "$1.00K"],
    [999.999, "$1.00K"],
    [1234.56, "$1.23K"],
    [999999.999, "$1.00M"],
    [1e9, "$1.00B"],
    [1e12, "$1.00T"],
    [null, "—"],
  ])
    assert.equal(compactCurrency(value, "USD"), expected);
  assert.equal(compactCurrency(99999999, "CNY"), "¥100.00M");
  assert.equal(compactCurrency(100.76, "CNY"), "¥101");
  assert.deepEqual(shareMetricParts("review", { review: 999990000 }), ["999.99", "M"]);
  assert.deepEqual(shareMetricParts("cacheHit", { cacheHit: null }), ["—", ""]);
});

test("trend labels preserve calendar hours and decode real quota millisecond keys", () => {
  const html = (keys, calendarZone) =>
    landscapeCardHtml({
      data: {
        totals: { total: 100 },
        models: [],
        metricValues: {},
        range: { preset: "all", calendarZone },
        charts: { trend: keys.map((key) => ({ key, total: 50 })) },
      },
      english: true,
      theme: "light",
      metrics: [],
      showCost: false,
      colours: "",
      artwork: "",
      chart: "trend",
    });
  assert.match(html(["2026-11-15 13:00", "2026-11-15 17:00"], "local"), />13:00<.*>17:00</);
  const start = Date.parse("2026-11-15T11:00:00Z"),
    end = start + 4.5 * 3600000;
  assert.match(html([String(start), String(end)], "utc"), />11:00<.*>15:30</);
  const local = new Date(start),
    expected = `${String(local.getHours()).padStart(2, "0")}:00`;
  assert.ok(html([String(start)], "local").includes(`>${expected}</text>`));
});

test("formal share window keeps layout preferences, snapshot and latest PNG across races", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser");
    return t.skip("No browser runtime");
  }
  const fixture = await createShareRangeFixture(),
    server = createUsageServer(fixture.options);
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await fixture.close();
  });
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((skinKey) => {
    window.EventSource = undefined;
    window.addEventListener("resize", () => {
      window.shareViewportSize = `${innerWidth}x${innerHeight}`;
    });
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem(
      skinKey,
      JSON.stringify({ version: 1, skinId: "deepseek", showCharacters: true, opacity: 0.5 }),
    );
    if (!localStorage.getItem("codexUsageShareMetrics"))
      localStorage.setItem("codexUsageShareMetrics", '["sessions","input"]');
    navigator.clipboard.write = async (items) => {
      const blob = await items[0].getType("image/png");
      window.copiedHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    };
    const decode = Image.prototype.decode;
    Image.prototype.decode = async function () {
      await decode.call(this);
      if (
        window.holdLandscape &&
        this.src.startsWith("data:image/svg+xml") &&
        decodeURIComponent(this.src).includes('width="1440" height="1080"')
      ) {
        window.holdLandscape = false;
        window.renderHeld = true;
        await new Promise((resolve) => {
          window.releaseRender = resolve;
        });
        window.renderReleased = true;
      }
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
      if (image.src?.startsWith("data:image/svg+xml"))
        window.lastShareSvg = decodeURIComponent(image.src.slice(image.src.indexOf(",") + 1));
      return draw.call(this, image, ...args);
    };
  }, SKIN_PREFERENCE_KEY);
  const usageReady = () => page.evaluate(async () => await (await import("/app.js")).activeUsageLoadDone);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await usageReady();
  await page.locator('[data-preset="all"]').click();
  await usageReady();
  const ready = async () => {
    try {
      await page.waitForFunction(
        () => !document.querySelector("#saveShareImage").disabled || document.querySelector("#shareStatus").textContent,
      );
    } catch (error) {
      console.error(
        await page.evaluate(async () => ({
          preset: (await import("/app-state.js")).state.preset,
          summary: Boolean((await import("/app-state.js")).state.summary),
          dialog: document.querySelector("#shareDialog").open,
          status: document.querySelector("#autoRefreshErrorText").textContent,
          image: document.querySelector("#shareImage").getAttribute("src"),
        })),
        errors,
      );
      throw error;
    }
    assert.equal(await page.locator("#shareStatus").textContent(), "", JSON.stringify(errors));
    return page.locator("#shareImage").evaluate(async (image) => {
      await image.decode();
      const bytes = await fetch(image.src).then((r) => r.arrayBuffer());
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const doc = new DOMParser().parseFromString(window.lastShareSvg, "image/svg+xml");
      const artwork = doc.querySelector(".p-character,.s-character")?.getAttribute("src");
      return {
        dimensions: [image.naturalWidth, image.naturalHeight],
        hash,
        metrics: [...doc.querySelectorAll(".p-label,.s-label")].map((n) => n.textContent),
        total: doc.querySelector(".p-number,.s-total")?.textContent,
        title: doc.querySelector(".s-chart-title")?.textContent,
        theme: doc.querySelector(".skin-preview-scope").getAttribute("data-preview-theme"),
        watermark: doc.querySelector(".share-watermark")?.textContent,
        watermarkCount: doc.querySelectorAll(".share-watermark").length,
        artwork: artwork
          ? Array.from(
              new Uint8Array(await crypto.subtle.digest("SHA-256", await fetch(artwork).then((r) => r.arrayBuffer()))),
            )
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")
          : null,
      };
    });
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await page.locator("#shareDialog").waitFor({ state: "hidden" });
  };
  const open = async () => {
    await page.locator("#shareToggle").click();
    return ready();
  };
  const selectLayout = async (layout) => {
    if ((await page.locator("#shareDialog").getAttribute("data-layout")) !== layout) {
      await page.locator("#shareLayout").click();
      await page.locator(`[data-share-layout="${layout}"]`).click();
    }
  };
  const choose = async (layout) => {
    await selectLayout(layout);
    return ready();
  };
  const portrait = await open();
  assert.deepEqual(portrait.dimensions, [1080, 1440]);
  assert.equal(portrait.watermark, "waifu-agent-usage");
  assert.equal(portrait.watermarkCount, 1);
  const expectedArtwork = async (view, theme) =>
    createHash("sha256")
      .update(await readFile(new URL(`../public${skinAssetUrl("deepseek", theme, view)}`, import.meta.url)))
      .digest("hex");
  assert.equal(portrait.artwork, await expectedArtwork("front", portrait.theme));
  assert.equal(await page.locator("#shareLayout").getAttribute("role"), "combobox");
  assert.equal(await page.locator(".dialog-heading #shareLayout").count(), 0);
  assert.equal(await page.locator(".share-customize > .share-layout #shareLayout").count(), 1);
  assert.equal(await page.locator('[data-share-layout="portrait"]').textContent(), "竖版");
  assert.equal(await page.locator('[data-share-layout="landscape"]').textContent(), "横版");
  const controlPlacement = () =>
    page.evaluate(() => {
      const preview = document.querySelector(".share-preview-well").getBoundingClientRect();
      const controls = document.querySelector(".share-customize").getBoundingClientRect();
      return { right: controls.left >= preview.right, below: controls.top >= preview.bottom };
    });
  assert.equal((await controlPlacement()).below, true);
  const roundedPreview = () =>
    page.evaluate(() => {
      const radii = ["#shareDialog", ".share-preview-well", "#shareImage"].map(
        (selector) => getComputedStyle(document.querySelector(selector)).borderRadius,
      );
      const image = document.querySelector("#shareImage"),
        r = image.getBoundingClientRect();
      return (
        radii.every((radius) => radius === radii[0] && radius !== "0px") &&
        Math.abs(r.width / r.height - image.naturalWidth / image.naturalHeight) < 0.001
      );
    });
  assert.ok(await roundedPreview(), "Portrait image itself has the shared radius and its natural aspect ratio");
  assert.deepEqual(portrait.metrics, ["会话", "输入"], "Old portrait preferences survive migration");
  let requests = 0;
  page.on("request", (request) => {
    if (/\/api\/(usage|summary)(?:\?|$)/.test(request.url())) requests++;
  });
  const landscape = await choose("landscape");
  assert.equal(landscape.watermark, "waifu-agent-usage");
  assert.equal(landscape.watermarkCount, 1);
  assert.equal(landscape.artwork, await expectedArtwork("side", landscape.theme));
  assert.notEqual(landscape.artwork, portrait.artwork);
  const summaryTemplate = await page.evaluate(async () =>
    structuredClone((await import("/app-state.js")).state.summary),
  );
  assert.deepEqual(landscape.dimensions, [1440, 1080]);
  assert.equal((await controlPlacement()).right, true);
  assert.equal(await page.locator("#shareLayoutValue").textContent(), "横版");
  assert.ok(await roundedPreview(), "Landscape image itself has the shared radius and its natural aspect ratio");
  assert.equal(await page.locator(".dialog-heading #shareChart").count(), 0);
  assert.deepEqual(
    await page.evaluate(() =>
      ["#shareLayout", "#shareChart", "#shareMetricFirst"].map((selector) => {
        const css = getComputedStyle(document.querySelector(selector));
        return [css.height, css.borderRadius, css.background, css.boxShadow, css.fontSize];
      }),
    ),
    await page.evaluate(() => {
      const css = getComputedStyle(document.querySelector("#shareMetricFirst"));
      return Array.from({ length: 3 }, () => [
        css.height,
        css.borderRadius,
        css.background,
        css.boxShadow,
        css.fontSize,
      ]);
    }),
  );
  assert.equal(landscape.total, portrait.total);
  assert.deepEqual(landscape.metrics, ["缓存读取", "输出", "输入", "缓存命中"]);
  assert.ok(
    await page
      .locator(".share-cost-toggle")
      .evaluate(
        (node) =>
          Math.abs(
            node.getBoundingClientRect().right -
              document.querySelector(".share-customize").getBoundingClientRect().right,
          ) < 1,
      ),
    "Landscape cost toggle aligns to the sidebar's right edge",
  );
  await page.locator("#shareMetricFirst").click();
  assert.equal(
    await page.locator("#shareMetricFirstMenu").evaluate((menu) => getComputedStyle(menu).scrollbarWidth),
    "none",
  );
  await page.keyboard.press("End");
  await page.waitForFunction(
    () => document.querySelector("#shareMetricFirstMenu").style.getPropertyValue("--fade-bottom") === "0px",
  );
  assert.equal(
    await page.locator("#shareMetricFirstMenu").evaluate((menu) => menu.style.getPropertyValue("--fade-top")),
    "18px",
  );
  await page.keyboard.press("Home");
  await page.waitForFunction(
    () => document.querySelector("#shareMetricFirstMenu").style.getPropertyValue("--fade-top") === "0px",
  );
  assert.equal(
    await page.locator("#shareMetricFirstMenu").evaluate((menu) => menu.style.getPropertyValue("--fade-bottom")),
    "18px",
  );
  assert.equal(await page.locator('#shareMetricFirstMenu [data-metric="output"]').count(), 0);
  await page.locator('#shareMetricFirstMenu [data-metric="sessions"]').click();
  await ready();
  await page.locator("#shareChart").click();
  await page.locator('#shareChartMenu [data-chart="harnesses"]').click();
  const harness = await ready();
  assert.equal(harness.title, "Harness");
  const returnedPortrait = await choose("portrait");
  assert.deepEqual(returnedPortrait.metrics, portrait.metrics);
  assert.equal(returnedPortrait.artwork, portrait.artwork, "Switching back restores the captured front view");
  assert.deepEqual((await choose("landscape")).metrics, ["会话", "输出", "输入", "缓存命中"]);
  await page.locator("#shareShowCost").check();
  const withCost = await ready();
  await page.locator("#copyShareImage").click();
  await page.waitForFunction(() => window.copiedHash);
  assert.equal(await page.evaluate(() => window.copiedHash), withCost.hash);
  const downloading = page.waitForEvent("download");
  await page.locator("#saveShareImage").click();
  const download = await downloading,
    png = await readFile(await download.path());
  assert.equal(createHash("sha256").update(png).digest("hex"), withCost.hash);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1440, 1080]);
  await page.locator("#openShareImage").click();
  await page.locator("#shareOriginalDialog").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#shareOriginalDialog img").hasAttribute("src"));
  assert.equal(await page.locator("#shareDialog").isVisible(), true);
  for (const viewport of [
    { width: 900, height: 700 },
    { width: 720, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    // The app closes open pickers when the browser dispatches resize.
    await page.waitForFunction((size) => window.shareViewportSize === size, `${viewport.width}x${viewport.height}`);
    assert.equal(await page.locator("#shareDialog").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal((await controlPlacement()).right, true);
    assert.ok(await roundedPreview(), `Preview remains rounded at ${viewport.width}px`);
    for (const id of ["shareLayout", "shareChart", "shareMetricFirst", "shareMetricFourth"]) {
      await page.locator(`#${id}`).press("End");
      const contained = await page.locator(`#${id}Menu`).evaluate((menu) => {
        const r = menu.getBoundingClientRect(),
          d = document.querySelector("#shareDialog").getBoundingClientRect();
        const option = document.activeElement.getBoundingClientRect();
        return (
          r.top >= d.top &&
          r.bottom <= d.bottom &&
          r.left >= d.left &&
          r.right <= d.right &&
          option.top >= r.top &&
          option.bottom <= r.bottom
        );
      });
      assert.ok(contained, `${id} fits ${viewport.width}px and reveals its last keyboard option`);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#shareDialog").isVisible(), true, `Escape from ${id} at ${viewport.width}px`);
    }
  }
  await mkdir("output/share-landscape", { recursive: true });
  await page.locator("#shareDialog").screenshot({ path: "output/share-landscape/dialog.png" });
  assert.equal(requests, 0, "Share controls must reuse the captured data");
  await close();
  await page.reload();
  await usageReady();
  const remembered = await open();
  assert.deepEqual(remembered.dimensions, [1440, 1080]);
  assert.deepEqual(remembered.metrics, ["会话", "输出", "输入", "缓存命中"]);
  assert.equal(remembered.title, "Harness");
  assert.ok(await page.locator("#shareShowCost").isChecked());
  await choose("portrait");
  await page.evaluate(() => {
    window.holdLandscape = true;
    window.renderHeld = false;
    window.renderReleased = false;
  });
  await selectLayout("landscape");
  await page.waitForFunction(() => window.renderHeld);
  const latest = await choose("portrait");
  await page.evaluate(() => window.releaseRender());
  await page.waitForFunction(() => window.renderReleased);
  await page.waitForTimeout(100);
  const currentHash = await page.locator("#shareImage").evaluate(async (image) => {
    const bytes = await fetch(image.src).then((r) => r.arrayBuffer());
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });
  assert.equal(currentHash, latest.hash, "A delayed landscape must not replace the latest portrait");
  await page.evaluate(() => {
    window.holdLandscape = true;
    window.renderHeld = false;
    window.renderReleased = false;
  });
  await selectLayout("landscape");
  await page.waitForFunction(() => window.renderHeld);
  await close();
  await page.evaluate(() => window.releaseRender());
  await page.waitForFunction(() => window.renderReleased);
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#shareImage").getAttribute("src"), null, "Closing prevents a delayed preview write");
  for (const [layoutValue, savedMetrics, savedChart] of [
    ["bogus", '["sessions","sessions"]', "old-chart"],
    ["landscape", "invalid JSON", "old-chart"],
  ]) {
    await page.evaluate(
      ({ layoutValue, savedMetrics, savedChart }) => {
        localStorage.setItem("codexUsageShareLayout", layoutValue);
        localStorage.setItem("codexUsageShareLandscapeMetrics", savedMetrics);
        localStorage.setItem("codexUsageShareLandscapeChart", savedChart);
      },
      { layoutValue, savedMetrics, savedChart },
    );
    await page.reload();
    await usageReady();
    const image = await open();
    assert.deepEqual(image.dimensions, layoutValue === "landscape" ? [1440, 1080] : [1080, 1440]);
    if (layoutValue === "landscape") {
      assert.equal(image.title, "趋势");
      assert.deepEqual(image.metrics, ["缓存读取", "输出", "输入", "缓存命中"]);
    }
    await close();
  }
  await page.evaluate(() => {
    localStorage.setItem("codexUsageShareMetrics", '["previous","output"]');
    localStorage.setItem("codexUsageShareLandscapeMetrics", '["review","dailyAverage","previous","output"]');
  });
  await page.reload();
  await usageReady();
  const openRange = async (kind, previousEventCount = 0) => {
    await page.evaluate(
      async ({ kind, previousEventCount, summary }) => {
        const { openShareDialog } = await import("/share-dialog.js");
        summary.range = {
          preset: kind === "day" ? "today" : "recent",
          recentValue: kind === "day" ? null : "今年",
          start: kind === "day" ? "2026-11-15T00:00Z" : "2026-01-01T00:00Z",
          end: "2026-11-15T23:59:59.999Z",
          asOf: "2026-11-15T12:00Z",
          calendarZone: "utc",
        };
        summary.comparison = {
          previousRange: { start: "2025-01-01", end: "2025-11-15" },
          previousEventCount,
          previousTotals: { total: 100 },
        };
        if (kind === "sparse") {
          delete summary.rangeMetrics;
          delete summary.details;
          summary.costEstimate.cacheHitRate = null;
          for (const key of ["input", "cached", "output", "reasoning"]) summary.totals[key] = null;
        }
        openShareDialog({ summary, theme: "dark", locale: "zh-CN" });
      },
      { kind, previousEventCount, summary: summaryTemplate },
    );
    return ready();
  };
  for (const kind of ["year", "day"]) {
    await openRange(kind);
    for (const orientation of ["portrait", "landscape"]) {
      const image = await choose(orientation);
      assert.ok(!image.metrics.includes("上期用量") && !image.metrics.includes("审核用量"));
      if (kind === "day") assert.ok(!image.metrics.includes("日均用量"));
      assert.equal(new Set(image.metrics).size, image.metrics.length);
      await page.locator("#shareMetricFirst").click();
      const hidden = ["topModel", "topThree", "free", "freeShare", "review", "previous", "delta", "growth"];
      if (kind === "day") hidden.push("activeDays", "dailyAverage", "activeAverage", "peakDay");
      for (const id of hidden)
        assert.equal(await page.locator(`#shareMetricFirstMenu [data-metric="${id}"]`).count(), 0);
      await page.keyboard.press("Escape");
    }
    await close();
  }
  await openRange("year", 1);
  assert.deepEqual((await choose("portrait")).metrics, ["上期用量", "输出"]);
  assert.deepEqual((await choose("landscape")).metrics, ["缓存读取", "日均用量", "上期用量", "输出"]);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("codexUsageShareLandscapeMetrics")),
    '["review","dailyAverage","previous","output"]',
    "Temporary range fallbacks do not overwrite saved choices",
  );
  await close();
  await openRange("sparse");
  assert.deepEqual((await choose("landscape")).metrics, ["会话", "模型数量", "模型厂商"]);
  assert.ok(
    await page.locator("#shareMetricFourth").isHidden(),
    "Missing metrics do not force an unavailable fourth choice",
  );
  await close();
  assert.deepEqual(errors, []);
});
