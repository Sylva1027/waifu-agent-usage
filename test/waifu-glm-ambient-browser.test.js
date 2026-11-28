import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SKIN_PREFERENCE, SKIN_PREFERENCE_KEY } from "../public/skins.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

async function switchTheme(page, theme) {
  await page.locator("#themeToggle").click();
  await page.locator('html[data-theme="' + theme + '"]:not([data-theme-transition])').waitFor();
}

async function waitForBandMotion(page) {
  await page.waitForFunction(
    () =>
      document
        .querySelector("#glm-ambient .glm-running-thread")
        ?.getAnimations()
        .some((animation) => animation.playState === "running"),
    null,
    { timeout: 5000 },
  );
}

test("GLM replays the woven lights after either dashboard theme change", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    return t.skip("No local browser runtime");
  }

  const fixture = await createPaletteFixture();
  const server = createUsageServer(createPaletteServerOptions(fixture));
  let browser;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await server.close();
      } finally {
        await fixture.close();
      }
    }
  });
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  await page.addInitScript(
    ([key, preference]) => {
      localStorage.setItem(key, JSON.stringify(preference));
      localStorage.setItem("codexUsageTheme", "light");
      localStorage.setItem("codexUsageAutoRefresh", "off");
    },
    [SKIN_PREFERENCE_KEY, DEFAULT_SKIN_PREFERENCE],
  );
  const devRequests = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/dev/")) devRequests.push(pathname);
  });
  await page.goto("http://127.0.0.1:" + server.address().port + "/");
  const layer = page.locator("#glm-ambient");
  assert.equal(await layer.count(), 0);
  await page.locator("#skinToggle").click();
  await page.locator('#skinDialog [data-skin-id="glm"]').click();
  await page.keyboard.press("Escape");
  await waitForBandMotion(page);

  for (const theme of ["dark", "light"]) {
    await layer.evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true })) animation.finish();
    });
    await switchTheme(page, theme);
    await waitForBandMotion(page);
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await switchTheme(page, "dark");
  assert.equal(await layer.evaluate((element) => element.getAnimations({ subtree: true }).length), 0);

  await page.locator("#skinToggle").click();
  await page.locator("#resetSkinClassicButton").click();
  await page.keyboard.press("Escape");
  await layer.waitFor({ state: "detached" });
  assert.deepEqual(devRequests, []);
});
