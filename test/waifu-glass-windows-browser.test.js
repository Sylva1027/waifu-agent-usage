import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

test("Classic window rims remain static through real dashboard dialogs and menus", async (t) => {
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem("codexUsageTheme", "light");
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector("html[data-frame-refraction]", { state: "attached" });
  await page.locator('#presetButtons [data-preset="all"]').click();
  await page.waitForSelector("#detailList .bar-row");

  const selector = (id) => `#${id}[data-glass-window], #${id} > [data-glass-window]`;
  async function optics(window) {
    return window.evaluate((node) => {
      const style = getComputedStyle(node, "::before");
      return [style.backdropFilter, style.backgroundImage, style.opacity, node.hasAttribute("data-glass-frame-active")];
    });
  }

  async function open(opener, id) {
    await page.locator(opener).first().click();
    const window = page.locator(selector(id));
    await window.waitFor({ state: "visible" });
    const initial = await optics(window);
    assert.match(initial[0], /#mg-frame-static/, `${id} must use the static optical material`);
    assert.equal(initial[3], false);
    const box = await window.boundingBox();
    await window.hover({ position: { x: Math.floor(box.width / 2), y: 7 } });
    assert.deepEqual(await optics(window), initial, `${id} must have a stable rim on hover`);
    return window;
  }
  async function close(id, button) {
    if (button) await page.locator(button).click();
    else await page.keyboard.press("Escape");
    await page.locator(`#${id}`).waitFor({ state: "hidden" });
    await page.waitForFunction(
      (sel) => !document.querySelector(sel)?.hasAttribute("data-glass-frame-active"),
      selector(id),
    );
  }

  await open("#recentMenuButton", "recentRangeMenu");
  await close("recentRangeMenu");
  assert.equal(await page.locator("#recentValue").getAttribute("aria-expanded"), "false");
  const calendar = await open("#dateRangeButton", "dateRangePicker");
  const box = await calendar.boundingBox();
  const clip = { x: Math.ceil(box.x + 16), y: Math.ceil(box.y + 1), width: Math.floor(box.width - 32), height: 12 };
  const sample = () => page.screenshot({ clip });
  const withGlass = await sample();
  const override = await page.addStyleTag({ content: "#dateRangePicker::before{backdrop-filter:none!important}" });
  const blocked = await sample();
  await override.evaluate((node) => node.remove());
  assert.ok(!withGlass.equals(blocked), "the calendar's optical rim must change real pixels");
  assert.ok(withGlass.equals(await sample()), "restoring the filter must reproduce the same pixels");
  await close("dateRangePicker");
  assert.ok(await page.locator("#dateRangeButton").evaluate((node) => node === document.activeElement));

  await open("#addImportButton", "importDialog");
  const importWindow = page.locator(selector("importDialog"));
  const [ridge, ridgeHeight, ridgeShadow] = await importWindow
    .locator(".source-option")
    .nth(1)
    .evaluate((node) => {
      const { backgroundImage, height, boxShadow } = getComputedStyle(node, "::before");
      return [backgroundImage, height, boxShadow];
    });
  assert.match(ridge, /linear-gradient\(to right/);
  assert.equal(ridgeHeight, "1px");
  assert.equal(ridgeShadow, "none");
  await close("importDialog", "#cancelImportButton");
  const pricing = await open("#updatePricingButton", "pricingDialog");
  const initial = await optics(pricing);
  await page.locator("#pricingSearch").focus();
  await page.keyboard.press("Tab");
  assert.deepEqual(await optics(pricing), initial, "focusing pricing fields must leave the rim static");
  await page.evaluate(() => document.documentElement.removeAttribute("data-frame-refraction"));
  const fallback = await optics(pricing);
  assert.equal(fallback[0], "none");
  const pricingBox = await pricing.boundingBox();
  await page.mouse.move(pricingBox.x + 5, pricingBox.y + 25);
  await page.mouse.down();
  assert.deepEqual(await optics(pricing), fallback, "the CSS-only rim must also remain static while pressed");
  await page.mouse.up();
  await page.evaluate(() => document.documentElement.setAttribute("data-frame-refraction", ""));
  const provider = await open("[data-pricing-provider]", "providerPricingDialog");
  const providerBox = await provider.boundingBox();
  await page.mouse.click(providerBox.x + 5, providerBox.y + Math.round(providerBox.height / 2));
  assert.equal(await provider.isVisible(), true, "padding is inside the provider window");
  const model = await open("[data-pricing-model]", "modelPricingDialog");
  const [modelRidge, modelHeight, modelShadow] = await model
    .locator(".pricing-mode-heading")
    .first()
    .evaluate((node) => {
      const { backgroundImage, height, boxShadow } = getComputedStyle(node, "::after");
      return [backgroundImage, height, boxShadow];
    });
  assert.deepEqual([modelRidge, modelHeight, modelShadow], [ridge, ridgeHeight, ridgeShadow]);
  const modelBox = await model.boundingBox();
  const modelOptics = await optics(model);
  await page.mouse.move(modelBox.x + 5, modelBox.y + Math.round(modelBox.height / 2));
  await page.mouse.down();
  assert.deepEqual(await optics(model), modelOptics);
  await page.mouse.move(modelBox.x - 10, modelBox.y + Math.round(modelBox.height / 2));
  await page.mouse.up();
  assert.equal(await model.isVisible(), true, "a press beginning inside may end on the backdrop");
  await page.mouse.click(modelBox.x - 10, modelBox.y + Math.round(modelBox.height / 2));
  await model.waitFor({ state: "hidden" });
  assert.ok(await page.locator("[data-pricing-model]:focus").count());
  await close("providerPricingDialog", "#closeProviderPricingButton");
  assert.ok(await page.locator("[data-pricing-provider]:focus").count());
  await close("pricingDialog", "#cancelPricingButton");

  await open("#achievementToggle", "achievementDialog");
  await open("#achievementStatusFilter", "achievementStatusMenu");
  await close("achievementStatusMenu");
  await close("achievementDialog");
  await open("#shareToggle", "shareDialog");
  await open("#shareLayout", "shareLayoutMenu");
  await close("shareLayoutMenu");
  await open("#openShareImage", "shareOriginalDialog");
  assert.deepEqual(
    await page.locator("#shareOriginalDialog img").evaluate((img) => {
      const style = getComputedStyle(img);
      return [style.filter, style.backdropFilter];
    }),
    ["none", "none"],
    "the glass belongs to the original-image window, preserving the image itself",
  );
  await close("shareOriginalDialog");
  assert.ok(await page.locator("#openShareImage").evaluate((node) => node === document.activeElement));
  await close("shareDialog");

  const picker = await open("#skinToggle", "skinDialog");
  await page.locator('#skinGrid [data-skin-id="deepseek"]').click();
  await page.waitForSelector('html[data-skin="deepseek"]:not([data-frame-refraction])');
  await picker.hover();
  assert.doesNotMatch(await picker.evaluate((n) => getComputedStyle(n, "::before").backdropFilter), /#mg-frame-/);
  assert.equal(await page.locator("[data-glass-frame-active], #mg-frame-active").count(), 0);
  await close("skinDialog", "#closeSkinDialogButton");
  assert.deepEqual(errors, []);
});
