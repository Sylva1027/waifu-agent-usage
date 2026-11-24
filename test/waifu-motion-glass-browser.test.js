import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server.js";
import { createUsageServer as createLiteServer } from "../src/server-lite.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

const host = "#skinToggle [data-glass-surface].lg-host";
const ready = "#timelineModes[data-motion-ready]";
const glassRequest = /\/waifu-liquid-glass\.(?:js|css)(?:\?|$)/;

test("Waifu motion follows native input and classic glass owns the active filter", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    return t.skip("No local browser runtime");
  }
  const fixture = await createPaletteFixture();
  const server = createUsageServer(createPaletteServerOptions(fixture));
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  });
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const scenario of ["classic", "character", "fallback", "reduced"]) {
    await t.test(scenario, async () => {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        reducedMotion: scenario === "reduced" ? "reduce" : "no-preference",
      });
      const requests = [];
      const errors = [];
      page.on("request", (request) => requests.push(request.url()));
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.addInitScript((scenario) => {
          localStorage.setItem("codexUsageAutoRefresh", "off");
          if (scenario === "fallback") delete Navigator.prototype.userAgentData;
          if (scenario === "character")
            localStorage.setItem("codexUsageSkinV1", JSON.stringify({ version: 1, skinId: "deepseek" }));
        }, scenario);
        await page.goto(url);
        await page.waitForFunction(() => !!window.__skinTestHook);
        const button = page.locator("#skinToggle");
        if (scenario !== "reduced") await page.locator(ready).waitFor({ state: "attached" });
        if (scenario === "classic") {
          const active = await page.waitForFunction(() => {
            const pane = document.querySelector(".lg-pane");
            const id = pane && getComputedStyle(pane).backdropFilter.match(/#(lg-refract-[\w-]+-baked)/)?.[1];
            const node = id && document.getElementById(id)?.querySelector("feDisplacementMap");
            return node && { id, scale: node.getAttribute("scale") };
          });
          const { id, scale } = await active.jsonValue();
          await button.focus();
          await page.keyboard.down("Space");
          await page.waitForFunction(
            ({ id, scale }) =>
              document.getElementById(id).querySelector("feDisplacementMap").getAttribute("scale") !== scale &&
              Number(document.querySelector(".lg-cover").style.getPropertyValue("--lg-press-highlight")) > 0,
            { id, scale },
          );
          // Install at the real click so a few early release frames cannot slip past the assertion.
          await button.evaluate((node, id) => {
            window.dialogOpticalWrites = new Promise((done) =>
              node.addEventListener(
                "click",
                () => {
                  const displacement = document.getElementById(id).querySelector("feDisplacementMap");
                  const cover = node.querySelector(".lg-cover");
                  let writes = 0;
                  let highlight = cover.style.getPropertyValue("--lg-press-highlight");
                  const observer = new MutationObserver((records) => {
                    writes += records.filter((record) => record.target === displacement).length;
                    const current = cover.style.getPropertyValue("--lg-press-highlight");
                    if (current !== highlight) {
                      writes++;
                      highlight = current;
                    }
                  });
                  observer.observe(displacement, { attributes: true, attributeFilter: ["scale"] });
                  observer.observe(cover, { attributes: true, attributeFilter: ["style"] });
                  setTimeout(() => {
                    observer.disconnect();
                    done(writes);
                  }, 500);
                },
                { once: true },
              ),
            );
          }, id);
          await page.keyboard.up("Space");
          await page.waitForSelector("#skinDialog:not([hidden])");
          assert.equal(
            await page.evaluate(() => window.dialogOpticalWrites),
            0,
            "covered glass must pause release optics",
          );
          await page.keyboard.press("Escape");
          await page.waitForFunction(
            ({ id, scale }) =>
              document.getElementById(id)?.querySelector("feDisplacementMap")?.getAttribute("scale") === scale &&
              !Number(document.querySelector(".lg-cover")?.style.getPropertyValue("--lg-press-highlight")),
            { id, scale },
          );
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForFunction(() => document.querySelector("#skinToggle").getBoundingClientRect().bottom < 0);
          await page.evaluate(
            () =>
              new Promise((done) => {
                const observation = new IntersectionObserver(([entry]) => {
                  if (!entry.isIntersecting) {
                    observation.disconnect();
                    done();
                  }
                });
                observation.observe(document.querySelector("#skinToggle"));
              }),
          );
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForFunction(
            (id) =>
              !!document.getElementById(id) && document.querySelector("#skinToggle").getBoundingClientRect().top >= 0,
            id,
          );
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.locator(ready).waitFor({ state: "detached" });
          await page.emulateMedia({ reducedMotion: "no-preference" });
          await page.locator(ready).waitFor({ state: "attached" });

          await button.dispatchEvent("pointerdown", { isPrimary: true, button: 0, pointerId: 21 });
          await page.waitForFunction(
            () => Number(document.querySelector(".lg-cover").style.getPropertyValue("--lg-press-highlight")) > 0,
          );
          await button.dispatchEvent("pointercancel", { isPrimary: true, pointerId: 21 });
          await page.waitForFunction(
            () => !Number(document.querySelector(".lg-cover").style.getPropertyValue("--lg-press-highlight")),
          );
          await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
          await page.locator(host).waitFor({ state: "detached" });
          await page.locator(ready).waitFor({ state: "detached" });
          await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
          await page.locator(host).waitFor({ state: "attached" });
          await page.locator(ready).waitFor({ state: "attached" });

          await page.evaluate(() => window.__skinTestHook.selectSkin("deepseek"));
          await page.locator(host).waitFor({ state: "detached" });
          assert.equal(await page.locator(".lg-cover, .lg-defs, .lg-tick").count(), 0);
          await page.evaluate(() => window.__skinTestHook.selectSkin("classic"));
          await page.locator(host).waitFor({ state: "attached" });
          await page.evaluate(() => {
            const surface = document.querySelector("#skinToggle [data-glass-surface]");
            const fresh = document.createElement("span");
            fresh.setAttribute("data-glass-surface", "");
            fresh.setAttribute("aria-hidden", "true");
            surface.replaceWith(fresh);
          });
          await page.locator(host).waitFor({ state: "attached" });
          assert.equal(await page.locator(".lg-defs").count(), 1);
        } else if (scenario === "reduced") {
          await page.locator(host).waitFor({ state: "attached" });
          assert.equal(
            requests.some((address) => address.includes("/waifu-motion-controls.js")),
            false,
          );
          assert.equal(await page.locator(ready).count(), 0);
          await button.press("Enter");
          await page.waitForSelector("#skinDialog:not([hidden])");
          await page.keyboard.press("Escape");
        } else {
          assert.equal(
            requests.some((address) => glassRequest.test(address)),
            false,
          );
          assert.equal(await page.locator(".lg-defs, .lg-cover").count(), 0);
          if (scenario === "fallback") {
            const filter = await page
              .locator("[data-glass-surface]")
              .evaluate((node) => getComputedStyle(node).backdropFilter);
            assert.match(filter, /blur\(/);
          }
        }
        const model = page.locator('#timelineModes [data-timeline-mode="model"]');
        await model.press("Enter");
        assert.equal(await model.getAttribute("aria-pressed"), "true");
        if (scenario !== "reduced") {
          await page.waitForFunction(() => {
            const indicator = document.querySelector("[data-motion-indicator]").getBoundingClientRect();
            const target = document.querySelector('#timelineModes [aria-pressed="true"]').getBoundingClientRect();
            return Math.abs(indicator.left - target.left) < 1 && Math.abs(indicator.width - target.width) < 1;
          });
        }
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }

  await t.test("Lite requests no Waifu motion or material assets", async () => {
    const lite = createLiteEditionFixture();
    const liteServer = createLiteServer(lite.options);
    const page = await browser.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    try {
      await listenOnFetchPort(liteServer);
      await page.goto(`http://127.0.0.1:${liteServer.address().port}`);
      await page.locator('[data-preset="all"]').click();
      await page.locator('[data-timeline-mode="model"]').press("Enter");
      assert.equal(
        requests.some((address) => /\/waifu-(?:motion|liquid-glass)/.test(address)),
        false,
      );
      assert.equal(await page.locator("[data-glass-surface], [data-motion-indicator], .lg-defs").count(), 0);
    } finally {
      await page.close();
      if (liteServer.listening) await new Promise((resolve) => liteServer.close(resolve));
      lite.close();
    }
  });
});
