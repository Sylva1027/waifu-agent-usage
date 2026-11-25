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
const frameSelector = "[data-glass-frame], [data-glass-frame-list] > .comparison-item";

async function assertPaintChanges(page, before, after, label) {
  const changed = await page.evaluate(
    async ([a, b]) => {
      async function decode(png) {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return new Uint32Array(ctx.getImageData(0, 0, img.width, img.height).data.buffer);
      }
      const [first, second] = await Promise.all([decode(a), decode(b)]);
      return first.reduce((count, color, i) => count + Number(color !== second[i]), 0);
    },
    [before.toString("base64"), after.toString("base64")],
  );
  assert.ok(changed > 0, label);
}

async function checkDashboardFrames(page, scenario) {
  const supported = scenario !== "fallback";
  if (supported) await page.locator("html[data-frame-refraction]").waitFor({ state: "attached" });
  await page.waitForSelector("#homeList .home-row");
  const frames = await page.evaluate((selector) => {
    const areas = [
      ".topbar",
      ".toolbar > .control-group",
      ".metrics > .metric",
      "#comparisonSummary > .comparison-item",
      ".shell .panel",
    ];
    return areas.map((area) =>
      [...document.querySelectorAll(area)].map((node) => ({
        marked: node.matches(selector),
        edge: getComputedStyle(node, "::before").backdropFilter,
      })),
    );
  }, frameSelector);
  assert.deepEqual([frames[0].length, frames[1].length, frames[2].length, frames[4].length], [1, 3, 12, 6]);
  assert.ok(frames[3].length > 0, "fixture renders comparison cards");
  for (const part of frames.flat()) {
    assert.ok(part.marked);
    assert.equal(part.edge.includes("#mg-frame-"), supported);
  }
  assert.equal(await page.locator("#mg-frame-active, #mg-frame-static").count(), supported ? 2 : 0);
  const title = page.getByRole("heading", { name: "Agent Usage", exact: true });
  const assertTitle = async () => {
    const [face, surface, stroke, shade] = await title.evaluate((node) => {
      const style = getComputedStyle(node);
      const color = style.color;
      node.style.color = "var(--neo-surface)";
      const surfaceColor = style.color;
      node.style.removeProperty("color");
      return [color, surfaceColor, style.webkitTextStrokeWidth, style.textShadow];
    });
    assert.equal(face, surface);
    assert.equal(parseFloat(stroke), 0);
    assert.match(shade, /-1px -1px 1px/);
    assert.match(shade, /(?:^| )1px 1px 1px/);
  };
  await assertTitle();
  if (scenario === "classic") {
    const recessed = await title.screenshot();
    await title.evaluate((n) => {
      n.style.textShadow = "none";
    });
    const flat = await title.screenshot();
    await title.evaluate((n) => {
      n.style.removeProperty("text-shadow");
    });
    await assertPaintChanges(page, recessed, flat, "directional light must change the painted face of the lettering");
    await page.locator("#themeToggle").click();
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark" && !document.documentElement.dataset.themeTransition,
    );
    await assertTitle();
    await page.locator("#themeToggle").click();
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "light" && !document.documentElement.dataset.themeTransition,
    );
  }
  const first = page.locator(".metrics .metric").first();
  const second = page.locator(".metrics .metric").nth(1);
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector("[data-glass-frame-active]"));
  // Compare the browser's actual composited rim, excluding text, badges and the mouse cursor.
  const bounds = await first.boundingBox();
  const clip = {
    x: Math.ceil(bounds.x + 13),
    y: Math.ceil(bounds.y + 1),
    width: Math.floor(bounds.width - 26),
    height: 12,
  };
  const before = await page.screenshot({ clip });
  if (scenario === "classic") {
    const staticScale = page.locator("#mg-frame-static feDisplacementMap");
    const original = await staticScale.getAttribute("scale");
    await staticScale.evaluate((node) => node.setAttribute("scale", "0"));
    const withoutBend = await page.screenshot({ clip });
    await staticScale.evaluate((node, scale) => node.setAttribute("scale", scale), original);
    await assertPaintChanges(page, before, withoutBend, "static displacement must bend actual dashboard pixels");
  }
  await first.hover();
  if (scenario === "reduced" || !supported) {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(await page.locator("[data-glass-frame-active]").count(), 0);
  } else {
    await page.waitForFunction(() =>
      document.querySelector(".metrics .metric")?.hasAttribute("data-glass-frame-active"),
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#mg-frame-active feDisplacementMap")?.getAttribute("scale") !==
        document.querySelector("#mg-frame-static feDisplacementMap")?.getAttribute("scale"),
    );
    await assertPaintChanges(
      page,
      before,
      await page.screenshot({ clip }),
      "hover must visibly change the composited rim",
    );
    if (scenario === "classic") {
      await page.mouse.down();
      await page.waitForTimeout(650);
      const pressed = await page.screenshot({ clip });
      const activeScale = page.locator("#mg-frame-active feDisplacementMap");
      const original = await activeScale.getAttribute("scale");
      const neutral = await page.locator("#mg-frame-static feDisplacementMap").getAttribute("scale");
      assert.notEqual(original, neutral);
      // Hold the highlight and the real press still. Only neutralize the displacement amplitude.
      await activeScale.evaluate((node, scale) => node.setAttribute("scale", scale), neutral);
      const fixedScale = await page.screenshot({ clip });
      await activeScale.evaluate((node, scale) => node.setAttribute("scale", scale), original);
      await page.mouse.up();
      await assertPaintChanges(
        page,
        pressed,
        fixedScale,
        "press refraction must contribute visible pixels beyond highlight",
      );
    }
    await second.hover();
    await page.waitForFunction(() =>
      document.querySelectorAll(".metrics .metric")[1].hasAttribute("data-glass-frame-active"),
    );
    assert.equal(await page.locator("[data-glass-frame-active]").count(), 1);
    assert.match(await first.evaluate((n) => getComputedStyle(n, "::before").backdropFilter), /#mg-frame-static/);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(() => {
      const card = document.querySelectorAll(".metrics .metric")[1];
      return card.getBoundingClientRect().bottom < 0 && !card.hasAttribute("data-glass-frame-active");
    });
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector("[data-glass-frame-active]"));
  if (scenario === "classic") {
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/usage" && new URL(r.url()).searchParams.get("preset") === "all",
    );
    await page.locator('#presetButtons [data-preset="all"]').click();
    assert.ok((await response).ok());
    await page.waitForSelector("#detailList .bar-row");
    const cards = page.locator("[data-glass-frame-list] > .comparison-item");
    assert.ok(await cards.count());
    assert.ok(
      await cards.evaluateAll((nodes) =>
        nodes.every((n) => getComputedStyle(n, "::before").backdropFilter.includes("#mg-frame-static")),
      ),
    );
    await page.locator('#presetButtons [data-preset="today"]').click();
    await page.mouse.move(0, 0);
  }
}

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
          localStorage.setItem("codexUsageTheme", "light");
          if (scenario === "fallback") delete Navigator.prototype.userAgentData;
          if (scenario === "character")
            localStorage.setItem("codexUsageSkinV1", JSON.stringify({ version: 1, skinId: "deepseek" }));
        }, scenario);
        await page.goto(url);
        await page.waitForFunction(() => !!window.__skinTestHook);
        const button = page.locator("#skinToggle");
        if (scenario !== "reduced") await page.locator(ready).waitFor({ state: "attached" });
        await checkDashboardFrames(page, scenario);
        assert.equal(
          requests.some((address) => address.includes("/waifu-frame-glass.js")),
          scenario !== "fallback",
        );
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
            await page.locator("[data-glass-frame-active]").count(),
            0,
            "background frame pauses while the dialog owns focus",
          );
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
        await model.hover();
        const hover = await model.evaluate((node) => {
          const style = getComputedStyle(node);
          return { border: style.borderColor, glow: style.textShadow };
        });
        assert.equal(hover.border, "rgba(0, 0, 0, 0)");
        assert.notEqual(hover.glow, "none");
        await model.press("Enter");
        assert.equal(await model.getAttribute("aria-pressed"), "true");
        await page.keyboard.press("Tab");
        const cost = page.locator('#timelineModes [data-timeline-mode="cost"]');
        assert.ok(
          await cost.evaluate(
            (node) => node.matches(":focus-visible") && getComputedStyle(node).outlineStyle === "solid",
          ),
        );
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
      assert.equal(
        requests.some((address) => address.includes("/waifu-frame-glass")),
        false,
      );
      assert.equal(
        await page
          .locator(`${frameSelector}, #mg-frame-static, [data-glass-surface], [data-motion-indicator], .lg-defs`)
          .count(),
        0,
      );
    } finally {
      await page.close();
      if (liteServer.listening) await new Promise((resolve) => liteServer.close(resolve));
      lite.close();
    }
  });
});
