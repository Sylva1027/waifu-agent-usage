import assert from "node:assert/strict";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createUsageServer } from "../src/server.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

test("detail growth, uncut quota control and theme transitions work in the real dashboard", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    return t.skip("No local browser runtime");
  }
  const fixture = await createPaletteFixture();
  const imports = JSON.parse(await readFile(fixture.importStoreFile, "utf8"));
  const log = `${imports.imports[0].path}/.codex-usage/usage.jsonl`;
  const seed = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]);
  await appendFile(
    log,
    `${Array.from({ length: 80 }, (_, index) =>
      JSON.stringify({
        ...seed,
        model: `overflow-model-${index}`,
        session_id: `overflow-${index}`,
        request_id: `overflow-${index}`,
      }),
    ).join("\n")}\n`,
  );
  const server = createUsageServer(createPaletteServerOptions(fixture));
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  });
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(() => {
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem("codexUsageTheme", "light");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__skinTestHook);
  await page.locator('#presetButtons button[data-preset="all"]').click();
  await page.waitForSelector("#detailList .bar-row");
  const height = () => page.locator("#detailPanel").evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(Math.abs((await height()) - 384) < 1);
  await page.locator('#timelineModes [data-timeline-mode="model"]').click();
  await page.waitForFunction(() => document.getElementById("detailPanel").getBoundingClientRect().height > 700);
  const geometry = await page.evaluate(() => {
    const detail = document.getElementById("detailPanel");
    const list = document.querySelector("#detailList");
    return {
      height: detail.getBoundingClientRect().height,
      chartHeight: document.querySelector(".chart-panel").getBoundingClientRect().height,
      scrolls: list.scrollHeight > list.clientHeight,
      thumb: getComputedStyle(list, "::-webkit-scrollbar").width,
      quotaClip: getComputedStyle(document.querySelector(".quota-preset-mode"), "::before").clipPath,
    };
  });
  assert.ok(geometry.height <= 769 && geometry.height >= 767, JSON.stringify(geometry));
  assert.equal(geometry.height, geometry.chartHeight);
  assert.equal(geometry.scrolls, true);
  assert.equal(geometry.thumb, "8px");
  assert.equal(geometry.quotaClip, "none");
  await mkdir(new URL("../output/additions-ui/", import.meta.url), { recursive: true });
  await page.screenshot({
    path: fileURLToPath(new URL("../output/additions-ui/layout.png", import.meta.url)),
    fullPage: true,
  });

  for (const fallback of [false, true]) {
    const before = await page.locator("html").getAttribute("data-theme");
    await page.evaluate((fallback) => {
      window.themeFadeAnimations = null;
      const capture = (animations) => {
        for (const animation of animations) animation.pause();
        window.themeFadeAnimations = animations;
      };
      // Pause as soon as the browser creates the fade, before test-runner scheduling can miss it.
      if (fallback) {
        document.startViewTransition = undefined;
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
          const animation = animate.apply(this, args);
          if (this.parentElement === document.body && this.inert && this.getAttribute("aria-hidden") === "true") {
            Element.prototype.animate = animate;
            capture([animation]);
          }
          return animation;
        };
      } else {
        const start = document.startViewTransition;
        document.startViewTransition = function (...args) {
          document.startViewTransition = start;
          const transition = start.apply(this, args);
          transition.ready.then(() => {
            capture(document.getAnimations().filter((a) => a.effect?.pseudoElement?.startsWith("::view-transition")));
          });
          return transition;
        };
      }
      document.querySelector("#themeToggle").click();
    }, fallback);
    await page.waitForFunction(() => window.themeFadeAnimations?.length);
    assert.equal(await page.locator("html").getAttribute("data-theme-transition"), "running");
    assert.equal(await page.locator("#themeToggle").isDisabled(), true);
    const { duration, opacity } = await page.evaluate((fallback) => {
      const animations = window.themeFadeAnimations;
      const fade = fallback
        ? animations[0]
        : animations.find((animation) => animation.effect.pseudoElement === "::view-transition-new(root)");
      const duration = fade.effect.getTiming().duration;
      for (const animation of animations) animation.currentTime = duration / 2;
      const opacity = Number(
        getComputedStyle(
          fallback ? fade.effect.target : document.documentElement,
          fallback ? null : "::view-transition-new(root)",
        ).opacity,
      );
      return { duration, opacity };
    }, fallback);
    assert.equal(duration, 1000, "theme transition must last one second");
    assert.ok(opacity > 0 && opacity < 1, `intermediate opacity: ${opacity}`);
    await page.evaluate(() => {
      document.querySelector("#themeToggle").click();
      for (const animation of window.themeFadeAnimations) animation.finish();
    });
    await page.waitForFunction(() => !document.documentElement.dataset.themeTransition);
    assert.equal(await page.locator("html").getAttribute("data-theme"), before === "light" ? "dark" : "light");
    assert.equal(await page.locator("#themeToggle").isEnabled(), true);
  }
  assert.deepEqual(errors, []);
});
