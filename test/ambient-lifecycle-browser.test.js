import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SKIN_PREFERENCE, SKIN_PREFERENCE_KEY } from "../public/skins.js";
import { startChatgptAmbientPreview } from "../scripts/chatgpt-ambient-preview.mjs";
import { startGlmAmbientPreview } from "../scripts/glm-ambient-preview.mjs";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";

async function openPreview(t, start) {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    t.skip("No local browser runtime");
    return;
  }
  const preview = await start(0);
  let browser;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      await preview.close();
    }
  });
  browser = await runtime.chromium.launch({
    executablePath: runtime.executablePath,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  return { page: await browser.newPage(), url: preview.url };
}

async function chooseSkin(page, skin) {
  await page.locator("#skinToggle").click();
  await page.locator(skin === "classic" ? "#resetSkinClassicButton" : `#skinDialog [data-skin-id="${skin}"]`).click();
  await page.keyboard.press("Escape");
}

test("ChatGPT keeps the current static plate through context loss and restores its renderer", async (t) => {
  const preview = await openPreview(t, startChatgptAmbientPreview);
  if (!preview) return;
  const { page, url } = preview;
  await page.goto(`${url}?theme=dark`, { waitUntil: "domcontentloaded" });
  const wing = page.locator("#chatgpt-ambient .wing.left");
  await page.waitForSelector('#chatgpt-ambient .left[data-silk="ready"]', { state: "attached" });
  const loss = await wing
    .locator("canvas")
    .evaluateHandle((canvas) => canvas.getContext("webgl").getExtension("WEBGL_lose_context"));
  await loss.evaluate((extension) => extension.loseContext());
  await page.waitForFunction(() => !document.querySelector("#chatgpt-ambient .left").dataset.silk);
  await page.locator("#themeToggle").click();
  await page.waitForSelector('html[data-theme="light"]:not([data-theme-transition])');
  const fallback = await wing.locator(".surface").evaluate((surface) => ({
    background: getComputedStyle(surface).backgroundImage,
    canvasHidden: surface.querySelector("canvas").hidden,
    reflection: getComputedStyle(surface.querySelector(".lip")).opacity,
  }));
  assert.match(fallback.background, /background-light\.webp/);
  assert.equal(fallback.canvasHidden, true);
  assert.equal(fallback.reflection, "1");

  await loss.evaluate((extension) => extension.restoreContext());
  await page.waitForSelector('#chatgpt-ambient .left[data-silk="ready"]', { state: "attached" });
  assert.ok(
    await wing.locator("canvas").evaluate((canvas) => {
      const gl = canvas.getContext("webgl");
      return !gl.isContextLost() && !!gl.getParameter(gl.CURRENT_PROGRAM);
    }),
  );
  await chooseSkin(page, "classic");
  assert.equal(await page.locator("#chatgpt-ambient canvas").count(), 0);
  await chooseSkin(page, "chatgpt");
  await page.waitForFunction(() => document.querySelectorAll('#chatgpt-ambient .wing[data-silk="ready"]').length === 2);
});

test("GLM loads its woven bands on entry and removes them on exit", async (t) => {
  const preview = await openPreview(t, startGlmAmbientPreview);
  if (!preview) return;
  const { page, url } = preview;
  const artwork = new Set();
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (/\/glm-ambient\/[^/]+\.webp$/.test(pathname)) artwork.add(pathname);
  });
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, JSON.stringify(value)),
    [SKIN_PREFERENCE_KEY, DEFAULT_SKIN_PREFERENCE],
  );
  await page.goto(url + "?theme=preserve");
  await page.evaluate(() => import("/dev/waifu-visuals/glm-ambient/preview.js").then(() => undefined));
  assert.equal(artwork.size, 0);
  assert.equal(await page.locator(".glm-band").count(), 0);
  await chooseSkin(page, "glm");
  await page.waitForFunction(() => document.querySelectorAll(".glm-band").length === 6);
  assert.ok([...artwork].some((path) => path.endsWith("/occlusion-front.webp")));
  await chooseSkin(page, "classic");
  assert.equal(await page.locator(".glm-band").count(), 0);
});
