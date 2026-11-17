import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createShareRangeFixture } from "../test-support/share-range-fixture.mjs";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createUsageServer } from "../src/server.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";

test("all twelve share ranges render portrait and landscape PNGs from dashboard aggregates", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) return t.skip("No browser runtime");
  const fixture = await createShareRangeFixture(),
    server = createUsageServer(fixture.options);
  let browser;
  try {
    await listenOnFetchPort(server);
    browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => await (await import("/app.js")).activeUsageLoadDone);
    const selections = [
      ...["today", "week", "month", "quota_5h", "quota_week"].map((preset) => ({ preset })),
      ...["上一个5h", "上周", "上个月", "今年", "去年"].map((recentValue) => ({ preset: "recent", recentValue })),
      { preset: "custom", startDate: "2025-01-01", endDate: "2026-12-31" },
      { preset: "all" },
    ];
    const out = path.resolve("output/share-ranges");
    await mkdir(out, { recursive: true });
    for (const [i, selection] of selections.entries()) {
      for (const layout of ["portrait", "landscape"]) {
        const result = await page.evaluate(
          async ({ selection, i, layout }) => {
            const query = new URLSearchParams({ ...selection, calendarZone: "utc", view: "dashboard" });
            const response = await fetch(`/api/usage?${query}`);
            if (!response.ok) throw Error(await response.text());
            const body = await response.json();
            const { createShareCardData, sharePeriodLabel } = await import("/share-card-data.js");
            const { renderShareCard } = await import("/share-card.js");
            const data = createShareCardData(body.summary, {
              ...selection,
              pricingModels: body.pricingCatalog?.models,
            });
            if (!data) throw Error("Missing data");
            const blob = await renderShareCard({
              data,
              layout,
              metrics:
                layout === "landscape"
                  ? ["cached", "output", "input", "cacheHit"]
                  : i === 11
                    ? ["freeShare", "activeDays"]
                    : ["cacheHit", "output"],
              locale: i % 2 ? "en-US" : "zh-CN",
              theme: i % 2 ? "dark" : "light",
            });
            const image = new Image();
            image.src = URL.createObjectURL(blob);
            await image.decode();
            URL.revokeObjectURL(image.src);
            return {
              width: image.naturalWidth,
              height: image.naturalHeight,
              total: data.totals.total,
              expected: body.summary.totals.total,
              free: data.metricValues.free,
              freeShare: data.metricValues.freeShare,
              review: data.metricValues.review,
              label: sharePeriodLabel(data, i % 2 === 1),
              filename: data.filename,
              png: await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(",")[1]);
                reader.readAsDataURL(blob);
              }),
              range: data.range,
            };
          },
          { selection, i, layout },
        );
        assert.deepEqual([result.width, result.height], layout === "landscape" ? [1440, 1080] : [1080, 1440]);
        assert.equal(result.total, result.expected);
        assert.ok(result.label);
        assert.ok(result.filename);
        if (i === 11) {
          assert.equal(result.free, 0);
          assert.equal(result.freeShare, 0);
          assert.equal(result.review, 3_000_000);
        }
        await writeFile(
          path.join(out, `${String(i + 1).padStart(2, "0")}-${layout}.png`),
          Buffer.from(result.png, "base64"),
        );
        delete result.png;
        await writeFile(
          path.join(out, `${String(i + 1).padStart(2, "0")}-${layout}.json`),
          JSON.stringify(result, null, 2),
        );
      }
    }
  } finally {
    await browser?.close();
    await server.close();
    await fixture.close();
  }
});
