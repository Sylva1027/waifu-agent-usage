import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ACHIEVEMENT_CONTENT, categoryOrder } from "../public/achievement-content.js";
import { SKINS, SKIN_PREFERENCE_KEY } from "../public/skins.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { verifyHistoryBackup } from "../src/history-backup.js";
import { createAchievementUiFixture } from "../test-support/achievement-ui-fixture.mjs";

const exec = promisify(execFile);
const row = (snapshot, id) => snapshot.rows.find((entry) => entry.id === id);

async function setup(t) {
  const runtime = await resolveBrowserRuntime();
  assert.ok(runtime, "S10 integration acceptance requires a real desktop browser");
  const fixture = await createAchievementUiFixture();
  let browser;
  const errors = [];
  t.after(async () => {
    await browser?.close();
    await fixture.close();
    assert.deepEqual(errors, []);
  });
  await fixture.ready();
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((key) => {
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem("codexUsageLocale", "zh-CN");
    localStorage.setItem("codexUsageTheme", "dark");
    localStorage.setItem(key, JSON.stringify({ version: 1, skinId: "classic", showCharacters: false, opacity: 0.5 }));
  }, SKIN_PREFERENCE_KEY);
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/usage" && response.status() === 200),
    page.goto(fixture.url),
  ]);
  await page.waitForFunction(() => document.querySelector("#totalTokens").textContent !== "-");
  assert.equal(await page.locator("html").getAttribute("data-skin"), "classic");
  const output = path.join("output", "playwright");
  await mkdir(output, { recursive: true });
  const screenshots = await mkdtemp(path.join(output, "achievement-integration-"));
  return { fixture, page, screenshots };
}

async function open(page) {
  await page.locator("#achievementToggle").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#achievementDialog").open && document.querySelector("#achievementDetail .detail-panel"),
  );
}

async function select(page, id) {
  const content = ACHIEVEMENT_CONTENT.find((entry) => entry.id === id);
  await page.locator(`[data-category="${content.category}"]`).click();
  await page.locator(`[data-achievement="${id}"]`).click();
}

test("all 42 real achievement cards render approved bilingual content and all 96 badges decode in the production page", {
  timeout: 60_000,
}, async (t) => {
  const { fixture, page, screenshots } = await setup(t);
  const snapshot = await fixture.snapshot();
  assert.equal(snapshot.rows.length, 42);
  assert.deepEqual(snapshot.rows.map((entry) => entry.id).sort(), ACHIEVEMENT_CONTENT.map((entry) => entry.id).sort());
  let inspected = 0;
  for (const locale of ["zh", "en"]) {
    await open(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "achievementTitle");
    for (const category of categoryOrder) {
      await page.locator(`[data-category="${category}"]`).click();
      for (const content of ACHIEVEMENT_CONTENT.filter((entry) => entry.category === category)) {
        const button = page.locator(`[data-achievement="${content.id}"]`);
        await button.click();
        assert.equal(await button.locator("h3").textContent(), content[locale].name);
        assert.equal(await button.locator("p").textContent(), content[locale].description);
        assert.equal(await page.locator(".detail-panel h3").textContent(), content[locale].name);
        assert.equal(await page.locator(".detail-flavor").textContent(), content[locale].flavor);
        assert.equal(
          await page
            .locator("#achievementDetail .detail-panel")
            .evaluate((node) => node.classList.contains("is-locked")),
          row(snapshot, content.id).highestEarned === null,
        );
        const fits = await page.locator("#achievementDetail .detail-panel").evaluate((node) => {
          const detail = node.getBoundingClientRect();
          const dialog = document.querySelector("#achievementDialog").getBoundingClientRect();
          return (
            detail.top >= dialog.top && detail.bottom <= dialog.bottom && node.scrollHeight <= node.clientHeight + 1
          );
        });
        assert.equal(fits, true, `${locale}/${content.id} detail must fit the approved fixed window`);
        inspected++;
      }
    }
    await select(page, "A76");
    await page.screenshot({ path: path.join(screenshots, `sub2-${locale}-achievement-window.png`) });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#achievementDialog").open);
    if (locale === "zh") {
      await page.locator("#languageToggle").click();
      await page.locator("#themeToggle").click();
    }
  }
  const urls = ACHIEVEMENT_CONTENT.flatMap((content) =>
    (content.tiered ? ["bronze", "silver", "gold"] : ["stone"]).map(
      (tier) => `/assets/achievements/${content.id}/${tier}.webp`,
    ),
  );
  assert.equal(urls.length, 96);
  const decoded = await page.evaluate(
    (paths) =>
      Promise.all(
        paths.map(async (url) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          return { url, width: image.naturalWidth, height: image.naturalHeight };
        }),
      ),
    urls,
  );
  for (const image of decoded) assert.deepEqual([image.width, image.height], [256, 256], image.url);
  t.diagnostic(
    JSON.stringify({ inspectedCards: inspected, decodedBadges: decoded.length, profileId: snapshot.profileId }),
  );
});

test("actual picker, share download and CLI restore award A44/A43/A46 in the original profile and remain idempotent", {
  timeout: 60_000,
}, async (t) => {
  let stage = "starting isolated fixture";
  t.after(() => t.diagnostic(`Last integration stage: ${stage}`));
  const { fixture, page, screenshots } = await setup(t);
  const before = await fixture.snapshot();
  assert.equal(row(before, "A44").observedValue, "0");
  assert.equal(row(before, "A43").highestEarned, null);
  assert.equal(row(before, "A46").highestEarned, null);
  await page.locator("#skinToggle").click();
  const characters = SKINS.filter((skin) => !skin.isClassic);
  assert.equal(characters.length, 10);
  let selected;
  for (const [index, character] of characters.entries()) {
    stage = `applying actual picker ${character.id}`;
    const recorded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/achievements/operations" &&
        response.request().postDataJSON().characterId === character.id,
    );
    await page.locator(`.skin-card[data-skin-id="${character.id}"]`).click();
    const response = await recorded;
    assert.equal(response.status(), 200);
    // The product leaves this response body unread; verify committed state through the real snapshot API.
    selected = await fixture.waitForSnapshot((snapshot) => row(snapshot, "A44").observedValue === String(index + 1));
    assert.equal(await page.locator("html").getAttribute("data-skin"), character.id);
    assert.equal(row(selected, "A44").observedValue, String(index + 1));
    assert.equal(row(selected, "A44").highestEarned, index === 9 ? "stone" : null);
    if (index < 9) assert.equal(selected.awardRevision, before.awardRevision);
  }
  const skinDate = row(selected, "A44").earnedAt.stone;
  assert.ok(skinDate);
  stage = "replaying an applied skin";
  const repeated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/achievements/operations" &&
      response.request().postDataJSON().characterId === characters[0].id,
  );
  await page.locator(`.skin-card[data-skin-id="${characters[0].id}"]`).click();
  assert.equal((await repeated).status(), 200);
  const duplicate = await fixture.snapshot();
  assert.equal(row(duplicate, "A44").observedValue, "10");
  assert.equal(row(duplicate, "A44").earnedAt.stone, skinDate);
  assert.equal(duplicate.awardRevision, selected.awardRevision);
  await page.locator("#resetSkinClassicButton").click();
  assert.equal(await page.locator("html").getAttribute("data-skin"), "classic");
  await page.locator("#closeSkinDialogButton").click();

  stage = "opening actual share";
  await page.locator('[data-preset="all"]').click();
  await page.waitForFunction(() => !document.querySelector("#shareToggle").disabled);
  await page.locator("#shareToggle").click();
  await page.waitForFunction(() => !document.querySelector("#saveShareImage").disabled);
  const sharedRequest = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/achievements/operations" &&
      response.request().postDataJSON().kind === "share",
  );
  const downloaded = page.waitForEvent("download");
  await page.locator("#saveShareImage").click();
  const download = await downloaded;
  stage = "reading actual downloaded PNG";
  const png = await readFile(await download.path());
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.ok(download.suggestedFilename().endsWith(".png"));
  assert.equal((await sharedRequest).status(), 200);
  await fixture.waitForSnapshot((snapshot) => row(snapshot, "A43").highestEarned === "bronze");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#shareDialog").open);

  const cli = (args) =>
    exec(process.execPath, [path.resolve("src/cli.js"), "history", ...args, "--home-dir", fixture.homeDir], {
      timeout: 30_000,
    });
  const backup = path.join(fixture.homeDir, "s10-integration-backup.sqlite");
  const target = path.join(fixture.homeDir, "s10-restored.sqlite");
  stage = "CLI backup of live isolated profile";
  await cli(["backup", fixture.databaseFile, backup]);
  const verified = await verifyHistoryBackup(backup);
  assert.equal(verified.manifest.formatVersion, 2);
  assert.equal(verified.manifest.achievements.profileId, before.profileId);
  stage = "CLI restore from verified backup";
  const completed = await cli(["restore", backup, target]);
  assert.match(completed.stdout, /History backup restored\./);
  assert.match(completed.stdout, /Online service was not switched\./);
  assert.ok(existsSync(target));
  assert.equal(existsSync(`${target}.achievements.sqlite`), false);
  stage = "publishing restore operation via existing usage refresh";
  await fixture.ready();
  const restored = await fixture.waitForSnapshot((snapshot) => row(snapshot, "A46").highestEarned === "stone");
  assert.equal(restored.profileId, before.profileId);
  assert.equal(restored.enabledAt, before.enabledAt);
  assert.equal(row(restored, "A01").observedValue, row(before, "A01").observedValue);
  assert.equal(row(restored, "A44").earnedAt.stone, skinDate);
  assert.equal(row(restored, "A43").observedValue, "1");
  assert.equal(row(restored, "A46").observedValue, "1");
  stage = "displaying earned A46";
  await page.locator("#languageToggle").click();
  await open(page);
  await select(page, "A46");
  assert.equal(
    await page.locator(".detail-panel h3").textContent(),
    ACHIEVEMENT_CONTENT.find((content) => content.id === "A46").en.name,
  );
  assert.equal(await page.locator(".detail-panel > .badge").getAttribute("src"), "/assets/achievements/A46/stone.webp");
  assert.match(await page.locator(".detail-date").textContent(), /^Earned /);
  await page.screenshot({ path: path.join(screenshots, "sub2-real-restore-achievement.png") });
  stage = "replaying completed CLI restore";
  const replay = await cli(["restore", backup, target]);
  assert.match(replay.stdout, /Restore already completed/);
  await fixture.ready();
  const after = await fixture.snapshot();
  assert.equal(row(after, "A46").observedValue, "1");
  assert.equal(row(after, "A46").earnedAt.stone, row(restored, "A46").earnedAt.stone);
  assert.equal(after.awardRevision, restored.awardRevision);
  t.diagnostic(
    JSON.stringify({
      profileId: before.profileId,
      skinsApplied: characters.length,
      share: row(after, "A43").highestEarned,
      skin: row(after, "A44").highestEarned,
      restore: row(after, "A46").highestEarned,
    }),
  );
});
