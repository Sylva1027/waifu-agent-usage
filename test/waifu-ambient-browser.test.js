import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SKIN_PREFERENCE, SKIN_PREFERENCE_KEY } from "../public/skins.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

const artReady = {
  chatgpt: "#chatgpt-ambient .wing",
  claude: '#claude-ambient .claude-paper-left[style*="--breeze-atlas"]',
  deepseek: "#deepseek-ambient .deepseek-glint",
  gemini: '#gemini-ambient-wall[data-ready="true"]',
  glm: "#glm-ambient .glm-band",
  grok: "#grok-ambient .grok-stage",
  kimi: "#kimi-ambient .kimi-stamp",
  qwen: "#qwen-ambient:not([hidden])",
};
const layers = Object.keys(artReady)
  .map((skin) => `#${skin}-ambient`)
  .concat("#gemini-ambient-wall")
  .join(", ");
const sheets = 'link[rel="stylesheet"][href*="/skin-ambient/"]';
const controls = 'button, input, select, textarea, [role="button"], [tabindex="0"]';

async function chooseSkin(page, skin) {
  await page.locator("#skinToggle").click();
  await page.locator(skin === "classic" ? "#resetSkinClassicButton" : `#skinDialog [data-skin-id="${skin}"]`).click();
  await page.keyboard.press("Escape");
  await page.locator(`html[data-skin="${skin}"]`).waitFor({ state: "attached" });
}

test("the Waifu dashboard loads only the selected ambient skin and releases it on exit", async (t) => {
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const requests = [];
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/skin-ambient/") && response.status() >= 400) {
      failures.push(`${response.status()} ${url.pathname}`);
    }
  });
  await page.addInitScript(
    ([key, preference]) => {
      localStorage.setItem(key, JSON.stringify(preference));
      localStorage.setItem("codexUsageTheme", "light");
      localStorage.setItem("codexUsageAutoRefresh", "off");
    },
    [SKIN_PREFERENCE_KEY, DEFAULT_SKIN_PREFERENCE],
  );
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof window.__skinTestHook?.selectSkin === "function");
  assert.deepEqual(
    requests.filter((url) => url.startsWith("/skin-ambient/")),
    [],
  );

  // Finishing a delayed import must not attach an old scene after leaving the skin.
  const requested = Promise.withResolvers();
  const pending = Promise.withResolvers();
  const delayed = "**/skin-ambient/qwen/scene.js";
  await page.route(delayed, async (route) => {
    requested.resolve();
    await pending.promise;
    await route.continue();
  });
  try {
    await chooseSkin(page, "qwen");
    await requested.promise;
    await chooseSkin(page, "classic");
  } finally {
    pending.resolve();
  }
  await page.evaluate(() => import("/skin-ambient/qwen/scene.js").then(() => undefined));
  await page.unroute(delayed);
  assert.equal(await page.locator(layers).count(), 0);
  assert.equal(await page.locator(sheets).count(), 0);

  for (const [skin, ready] of Object.entries(artReady)) {
    const before = requests.length;
    await chooseSkin(page, skin);
    await page.locator(ready).first().waitFor({ state: "attached" });
    assert.equal(await page.locator(sheets).count(), 1, skin);
    assert.ok(await page.locator(`#${skin}-ambient`).isVisible(), skin);
    assert.equal(await page.locator(`#${skin}-ambient`).getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator(layers).locator(controls).count(), 0, skin);
    assert.match(await page.locator(sheets).getAttribute("href"), new RegExp(`/skin-ambient/${skin}/scene\\.css$`));
    assert.ok(
      requests
        .slice(before)
        .filter((url) => url.startsWith("/skin-ambient/"))
        .every((url) => url.startsWith(`/skin-ambient/${skin}/`)),
      `${skin} must not fetch a different skin’s artwork`,
    );

    const nextTheme = (await page.locator("html").getAttribute("data-theme")) === "light" ? "dark" : "light";
    await page.locator("#themeToggle").click();
    await page.locator(`html[data-theme="${nextTheme}"]:not([data-theme-transition])`).waitFor();
    await page.locator(ready).first().waitFor({ state: "attached" });
    assert.equal(await page.locator(sheets).count(), 1, skin);
    assert.ok(await page.locator(`#${skin}-ambient`).isVisible(), `${skin}/${nextTheme}`);
    assert.equal(await page.locator(layers).locator(controls).count(), 0, `${skin}/${nextTheme}`);

    await chooseSkin(page, "classic");
    await page.locator(layers).first().waitFor({ state: "detached" });
    assert.equal(await page.locator(sheets).count(), 0);
  }

  assert.deepEqual(
    requests.filter((url) => url.startsWith("/dev/")),
    [],
  );
  assert.deepEqual(failures, []);
});
