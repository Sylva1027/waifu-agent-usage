import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import {
  createPaletteFixture,
  createPaletteServerOptions,
  FIXTURE_TOTAL_TOKENS,
} from "../test-support/skin-palette-fixture.mjs";
import { createLiteBoundaryProbe, installLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";
import { resolveBrowserRuntime } from "./skin-palette/capture.mjs";
import { enumerateSourceAssets, SKIN_PREFERENCE_KEY, SKINS } from "../public/skins.js";
import {
  ROOT,
  commonHashes,
  extractChecked,
  nativeCheck,
  releaseDirectory,
  removeTemporary,
  sha256,
} from "./package-release.mjs";
import { EDITIONS, ENTRY_OVERRIDES, isLiteForbidden, releaseInputs } from "./release-dependencies.mjs";
import { assertEditionPayload, commonUsageContract } from "./release-contracts.mjs";

const exec = promisify(execFile);

async function checkNative(unpacked, work, edition) {
  await nativeCheck(unpacked);
  const helper = path.join(unpacked, "native/windows-source-proof/bin/windows-source-proof.exe");
  const receipt = JSON.parse(await readFile(`${helper.slice(0, -4)}.build.json`, "utf8"));
  assert.equal((await readFile(helper)).length, receipt.bytes);
  const evidence = { receipt: "passed", target: receipt.target, bytes: receipt.bytes, sha256: receipt.sha256 };
  if (process.platform !== "win32") return { ...evidence, pairedLocks: "not-applicable" };
  const { WindowsSourceProof } = await import(pathToFileURL(path.join(unpacked, "src/usage-source-native.js")).href);
  const files = [path.join(work, `${edition}-native.sqlite`), path.join(work, `${edition}-native.json`)];
  const database = new DatabaseSync(files[0]);
  database.exec("CREATE TABLE fact(n INTEGER); INSERT INTO fact VALUES(14)");
  database.close();
  await writeFile(files[1], '{"fixture":"native-lock"}\n');
  const proof = new WindowsSourceProof(helper);
  let lease;
  try {
    lease = await proof.lockFiles(files);
    assert.ok(lease, "Packaged native helper must acquire real paired locks");
    assert.equal(await lease.check(), true);
    const reader = new DatabaseSync(files[0], { readOnly: true });
    try {
      assert.equal(reader.prepare("SELECT n FROM fact").get().n, 14);
    } finally {
      reader.close();
    }
    for (const file of files) {
      await assert.rejects(async () => {
        const writer = await open(file, "r+");
        await writer.close();
      }, /EPERM|EACCES|EBUSY/);
      await assert.rejects(rename(file, `${file}.moved`), /EPERM|EACCES|EBUSY/);
      await assert.rejects(unlink(file), /EPERM|EACCES|EBUSY/);
      await writeFile(`${file}.replacement`, "replacement");
      await assert.rejects(rename(`${file}.replacement`, file), /EPERM|EACCES|EBUSY/);
    }
    assert.equal(await lease.check(), true);
    await lease.close();
    assert.equal(await lease.check(), false);
    for (const file of files) {
      const writer = await open(file, "r+");
      await writer.close();
    }
    return {
      ...evidence,
      pairedLocks: "passed",
      denyWriteDeleteRenameReplace: "passed",
      released: "passed",
    };
  } finally {
    await lease?.close();
    proof.close();
  }
}

function isolatedEnvironment(homeDir) {
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: path.join(homeDir, "AppData/Roaming"),
    LOCALAPPDATA: path.join(homeDir, "AppData/Local"),
  };
  for (const key of ["CODEX_HOME", "CODEX_EXTRA_HOMES", "CODEX_USAGE_IMPORT_DIRS", "CODEX_USAGE_STATE_FILE"])
    delete env[key];
  return env;
}

async function checkCli(unpacked, work, edition, databaseFile) {
  const homeDir = path.join(work, `cli-home-${edition}`);
  const sessions = path.join(homeDir, ".codex/sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    path.join(sessions, "release.jsonl"),
    [
      { type: "session_meta", payload: { id: "release", source: "cli", cwd: homeDir } },
      { type: "turn_context", payload: { model: "gpt-6-sol" } },
      {
        type: "event_msg",
        timestamp: "2026-11-16T12:00:00Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 120,
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 5,
            },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const state = path.join(homeDir, "services-isolated.json");
  const entry = path.join(unpacked, "src/cli.js");
  const cli = (args) =>
    exec(
      process.execPath,
      [entry, ...args, ...(args[0] === "history" && args[1] === "verify" ? [] : ["--home-dir", homeDir])],
      {
        cwd: unpacked,
        env: isolatedEnvironment(homeDir),
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  const help = await cli(["--help"]);
  assert.equal(help.stdout.includes("--with-achievements"), edition === "waifu");
  const json = JSON.parse((await cli(["json"])).stdout);
  assert.equal(json.summary.totals.total, 120);
  assert.equal(Object.hasOwn(json.summary, "costEstimate"), edition === "waifu");
  const summary = JSON.parse((await cli(["summary", "--json"])).stdout);
  assert.equal(summary.summary?.totals.total ?? summary.totals.total, 120);
  const backup = path.join(work, `${edition}-backup.sqlite`);
  const restored = path.join(work, `${edition}-restored.sqlite`);
  await cli(["history", "backup", databaseFile, backup]);
  const { verifyHistoryBackup } = await import(pathToFileURL(path.join(unpacked, "src/history-backup.js")).href);
  const verified = await verifyHistoryBackup(backup);
  if (edition === "lite") {
    assert.equal(verified.manifest.pricing, null);
    assert.equal(verified.manifest.formatVersion, 3);
  }
  await cli(["history", "verify", backup]);
  await cli(["history", "restore", backup, restored]);
  const database = new DatabaseSync(restored, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 12);
  } finally {
    database.close();
  }
  let service;
  try {
    await cli(["gateway", "--host", "127.0.0.1", "--port", "0", "--state-file", state]);
    [service] = JSON.parse(await readFile(state, "utf8")).services;
    assert.equal(service.edition, edition);
    assert.equal(await realpath(service.entryFile), await realpath(entry));
    const response = await fetch(`${service.url}/api/usage?view=dashboard&preset=all`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).summary.totals.total, 120);
  } finally {
    await cli(["stop", "--state-file", state]);
    if (service) assert.deepEqual(JSON.parse(await readFile(state, "utf8")).services, []);
  }
  return {
    help: "passed",
    json: "passed",
    summary: "passed",
    historyBackupVerifyRestore: "passed",
    gatewayEditionEntryExecutorStop: "passed",
  };
}

async function checkLitePage(browser, url, locale, viewport) {
  const context = await browser.newContext({ locale, viewport, timezoneId: "Asia/Shanghai" });
  const errors = [],
    forbiddenRequests = [];
  await context.addInitScript(() => {
    localStorage.setItem("codexUsageTheme", "light");
    localStorage.setItem("codexUsageAutoRefresh", "off");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("request", (request) => {
    if (/\/(?:pricing|share|skin|achievement|assets\/|waifu-(?:motion|liquid-glass))/.test(new URL(request.url()).pathname))
      forbiddenRequests.push(request.url());
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator('[data-preset="all"]').click();
    await page.waitForFunction(() => Number.parseFloat(document.querySelector("#totalTokens")?.textContent) > 0);
    assert.equal(await page.locator("html").getAttribute("data-edition"), "lite");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await page.locator(".metrics > .metric").count(), 6);
    assert.equal(
      await page.locator("#themeToggle, #shareToggle, #skinToggle, #achievementToggle, #updatePricingButton").count(),
      0,
    );
    assert.equal(await page.locator("[data-timeline-mode]").count(), 2);
    await page.locator('[data-timeline-mode="model"]').click();
    await page.locator('[data-timeline-mode="channel"]').click();
    await page.locator("#addImportButton").click();
    await page.locator("#importDialog").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#importDialog").waitFor({ state: "hidden" });
    await page.locator("#languageToggle").click();
    assert.deepEqual(forbiddenRequests, []);
    assert.deepEqual(errors, []);
    return {
      locale,
      viewport,
      sixCards: "passed",
      timelineModes: "passed",
      sourceDialog: "passed",
      forbiddenRequests,
      errors,
    };
  } finally {
    await context.close();
  }
}
async function checkWaifuPage(browser, url, edition, locale, viewport) {
  const context = await browser.newContext({ locale, viewport, timezoneId: "Asia/Shanghai" });
  const preference = { version: 1, skinId: "deepseek", showCharacters: true, opacity: 0.63 };
  await context.addInitScript(
    ({ key, preference, locale }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(preference));
      if (!localStorage.getItem("codexUsageTheme")) localStorage.setItem("codexUsageTheme", "light");
      if (!localStorage.getItem("codexUsageLocale")) localStorage.setItem("codexUsageLocale", locale);
      localStorage.setItem("codexUsageAutoRefresh", "off");
    },
    { key: SKIN_PREFERENCE_KEY, preference, locale },
  );
  const page = await context.newPage();
  const errors = [];
  const skinRequests = [];
  const shareImages = [];
  const pendingOperations = new Set();
  const reloadRequests = new WeakSet();
  const reloadAbortedOperations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${message.text()} ${message.location().url}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    pendingOperations.delete(request);
    const pathname = new URL(request.url()).pathname;
    const failure = request.failure()?.errorText;
    if (failure === "net::ERR_ABORTED" && reloadRequests.has(request)) {
      reloadAbortedOperations.push({ method: request.method(), url: request.url(), reason: "explicit-page-reload" });
      return;
    }
    if (pathname === "/api/usage-events") return;
    if (pathname === "/api/imports/discover" && failure === "net::ERR_ABORTED") return;
    errors.push(`${failure} ${request.url()}`);
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/achievements/operations")
      pendingOperations.add(request);
    if (/\/(?:skin[^/]*\.(?:js|css|json|html)|assets\/skins\/)/.test(new URL(request.url()).pathname))
      skinRequests.push(request.url());
  });
  page.on("requestfinished", (request) => pendingOperations.delete(request));
  await page.clock.setFixedTime(new Date("2026-10-04T13:00:00.000Z"));
  async function ready() {
    await page.waitForFunction(() => Number.parseFloat(document.querySelector("#totalTokens")?.textContent) > 0);
    assert.equal(await page.locator("html").getAttribute("data-edition"), edition);
  }
  async function dashboardBooted() {
    await page.waitForFunction(async (edition) => {
      const { state } = await import("/app-state.js");
      return edition === "waifu" ? Boolean(state.usageEventsSource) : Boolean(state.summary);
    }, edition);
  }
  async function appearance(theme) {
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-theme-transition"));
    assert.equal(await page.locator("#skinToggle").count(), 1);
    assert.equal(await page.locator("html").getAttribute("data-skin"), "deepseek");
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll("#skinCharacters img")];
      return images.length === 2 && images.every((img) => img.complete && img.naturalWidth > 0);
    });
    const urls = await page
      .locator("#skinCharacters img")
      .evaluateAll((images) => images.map((img) => new URL(img.src).pathname));
    assert.deepEqual(
      urls.sort(),
      Object.values(SKINS.find((skin) => skin.id === "deepseek").variants[theme].assets).sort(),
    );
    assert.deepEqual(
      JSON.parse(await page.evaluate((key) => localStorage.getItem(key), SKIN_PREFERENCE_KEY)),
      preference,
    );
  }
  async function shareImage(preset, theme, layout = "portrait") {
    await page.locator(`[data-preset="${preset}"]`).click();
    await page.evaluate(async () => await (await import("/app.js")).activeUsageLoadDone);
    const toggle = page.locator("#shareToggle");
    await toggle.click();
    const dialog = page.locator("#shareDialog");
    await dialog.waitFor({ state: "visible" });
    if ((await dialog.getAttribute("data-layout")) !== layout) {
      await dialog.locator("#shareLayout").click();
      await dialog.locator(`[data-share-layout="${layout}"]`).click();
    }
    const [width, height] = layout === "landscape" ? [1440, 1080] : [1080, 1440];
    const save = dialog.locator("#saveShareImage");
    await page.waitForFunction((button) => !button.disabled, await save.elementHandle());
    const preview = dialog.locator("#shareImage");
    await preview.evaluate(async (image) => await image.decode());
    const imageData = await preview.evaluate(async (image) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
      sha256: Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await fetch(image.src).then((response) => response.arrayBuffer())),
        ),
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    }));
    assert.equal(imageData.width, width);
    assert.equal(imageData.height, height);
    assert.equal(await dialog.locator(".dialog-actions button").count(), 2, "Share actions must remain copy/save only");
    const downloadStarted = page.waitForEvent("download");
    await save.click();
    const download = await downloadStarted;
    const filename = download.suggestedFilename();
    assert.match(filename, /^usage_\d{8}(?:-\d{8})?\.png$/);
    const bytes = await readFile(await download.path());
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), width);
    assert.equal(bytes.readUInt32BE(20), height);
    assert.equal(sha256(bytes), imageData.sha256, "Saved image differs from preview");
    shareImages.push({ preset, theme, layout, filename, bytes: bytes.length, ...imageData });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.ok(await toggle.evaluate((button) => button === document.activeElement), "Share close must restore focus");
    await appearance(theme);
  }
  try {
    // Achievement SSE stays connected; readiness below checks actual data and images.
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await dashboardBooted();
    await page.locator('[data-preset="all"]').click();
    await ready();
    await appearance("light");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await page.locator("#addImportButton").click();
    await page.locator("#importDialog").waitFor({ state: "visible" });
    await page.keyboard.press("Shift+Tab");
    assert.ok(await page.locator("#importDialog").evaluate((dialog) => dialog.contains(document.activeElement)));
    await page.keyboard.press("Escape");
    await page.locator("#importDialog").waitFor({ state: "hidden" });
    await page.locator("#updatePricingButton").click();
    const provider = page.locator("#pricingProviderList [data-pricing-provider]").first();
    await provider.waitFor({ state: "visible" });
    const providerId = await provider.getAttribute("data-pricing-provider");
    await provider.click();
    await page.locator("#providerPricingDialog").waitFor({ state: "visible" });
    await page.locator("#pricingModelList [data-pricing-model]").first().click();
    await page.locator("#modelPricingDialog").waitFor({ state: "visible" });
    assert.ok(await page.locator("#modelPricingFields input[data-model]").count());
    await page.keyboard.press("Escape");
    await page.locator("#modelPricingDialog").waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await page.locator("#providerPricingDialog").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.pricingProvider), providerId);
    await page.keyboard.press("Escape");
    await page.locator("#pricingDialog").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "updatePricingButton");
    await shareImage("week", "light");
    await shareImage("week", "light", "landscape");
    for (const theme of ["dark", "light"]) {
      await page.locator("#themeToggle").click();
      await page.waitForFunction(
        (theme) =>
          document.documentElement.dataset.theme === theme &&
          !document.documentElement.hasAttribute("data-theme-transition") &&
          !document.querySelector("#themeToggle").disabled,
        theme,
      );
      await appearance(theme);
      await shareImage(theme === "dark" ? "month" : "today", theme);
      await shareImage(theme === "dark" ? "month" : "today", theme, "landscape");
    }
    if (edition === "waifu") {
      await page.locator("#skinToggle").click();
      await page.locator("#skinDialog").waitFor({ state: "visible" });
      assert.equal(await page.locator(".skin-card[data-skin-id]").count(), SKINS.filter((skin) => !skin.isClassic).length);
      await page.keyboard.press("Tab");
      assert.ok(await page.locator("#skinDialog").evaluate((dialog) => dialog.contains(document.activeElement)));
      await page.keyboard.press("Escape");
      await page.locator("#skinDialog").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#skinToggle").getAttribute("aria-expanded"), "false");
    }
    await page.locator("#languageToggle").click();
    const switchedLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    assert.equal(await page.locator("html").getAttribute("lang"), switchedLocale);
    await appearance("light");
    // Only these exact old-document requests can be cancelled by this deliberate reload.
    for (const request of pendingOperations) reloadRequests.add(request);
    await page.reload({ waitUntil: "domcontentloaded" });
    await dashboardBooted();
    await page.locator('[data-preset="all"]').click();
    await ready();
    assert.equal(await page.locator("html").getAttribute("lang"), switchedLocale);
    await appearance("light");
    assert.deepEqual(errors, [], `Unexpected browser errors: ${JSON.stringify(errors)}`);
    return {
      locale,
      viewport,
      pricing: "passed",
      skinRequests: skinRequests.length,
      errors: errors.length,
      reloadAbortedOperations,
      shareImages,
    };
  } finally {
    await context.close();
  }
}

export async function checkRelease(output = "output/releases", { browserRequested = false } = {}) {
  const directory = await releaseDirectory(ROOT, output);
  const manifest = JSON.parse(await readFile(path.join(directory, "release-manifest.json"), "utf8"));
  assert.match(manifest.releaseVersion, /^\d+\.\d+[a-z]?$/);
  assert.deepEqual(
    Object.keys(manifest.variants).sort(),
    [...EDITIONS].sort(),
    "Exactly Lite and Waifu releases are required",
  );
  const core = commonHashes(manifest.variants.lite.files, manifest.variants.waifu.files);
  assert.deepEqual(core, manifest.core);
  assert.equal(sha256(JSON.stringify(core)), manifest.coreSha256);
  const parent = await realpath(tmpdir());
  const relative = path.relative(ROOT, parent);
  assert.ok(
    path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`),
    "Acceptance must unpack outside the repository",
  );
  const work = await mkdtemp(path.join(parent, "usage-release-check-"));
  const report = {
    version: manifest.version,
    releaseVersion: manifest.releaseVersion,
    platform: process.platform,
    architecture: process.arch,
    coreSha256: manifest.coreSha256,
    browser: "not-run",
    editions: {},
    status: "running",
  };
  let browser, fixture;
  try {
    for (const edition of EDITIONS) {
      const variant = manifest.variants[edition];
      const filename = `${manifest.releaseVersion}-${edition}.zip`;
      assert.equal(variant.filename, filename);
      const zip = path.join(directory, filename);
      assert.equal(sha256(await readFile(zip)), variant.sha256);
      const unpacked = path.join(work, edition);
      await extractChecked(zip, unpacked, variant.files);
      assert.deepEqual(
        Object.keys(variant.files).sort(),
        Object.keys(await releaseInputs(edition, unpacked, { packaged: true })).sort(),
        `${edition} exact runtime closure`,
      );
      const packaged = JSON.parse(await readFile(path.join(unpacked, "package.json"), "utf8"));
      assert.equal(packaged.version, manifest.version);
      assert.equal(packaged.releaseVersion, manifest.releaseVersion);
      if (edition === "lite") {
        for (const [canonical, concrete] of Object.entries(ENTRY_OVERRIDES)) {
          // CLI is copied as the real entry; server/executor named dependencies are also retained.
          if (concrete !== "src/cli-lite.js")
            assert.deepEqual(
              await readFile(path.join(unpacked, canonical)),
              await readFile(path.join(unpacked, concrete)),
            );
        }
        for (const file of Object.keys(variant.files)) assert.equal(isLiteForbidden(file), false, file);
      } else {
        assert.equal(
          Object.keys(variant.files).filter((file) => file.startsWith("public/assets/achievements/")).length,
          96,
        );
        assert.equal(Object.keys(variant.files).filter((file) => file.startsWith("public/assets/skins/")).length, enumerateSourceAssets().length);
        for (const file of [
          "src/achievement-runtime.js",
          "src/achievement-store.js",
          "src/usage-record-store.js",
          "src/waifu/cli-features.js",
          "public/share-card.js",
        ])
          assert.ok(variant.files[file], file);
      }
      report.editions[edition] = {
        zipSha256: variant.sha256,
        files: Object.keys(variant.files).length,
        native: await checkNative(unpacked, work, edition),
        browser: [],
      };
    }
    // Both editions consume the same immutable synthetic source, giving stable source identities.
    fixture = await createPaletteFixture();
    const contracts = {};
    for (const edition of EDITIONS) {
      const unpacked = path.join(work, edition);
      const databaseFile = path.join(work, `${edition}-usage.sqlite`);
      const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, LITE_BOUNDARY_PROBE: process.env.LITE_BOUNDARY_PROBE };
      let server, hooks, probe;
      try {
        if (edition === "lite") {
          const forbiddenModules = Object.keys(manifest.variants.waifu.files)
            .filter((file) => isLiteForbidden(file) && !Object.hasOwn(ENTRY_OVERRIDES, file))
            .map((file) => path.join(unpacked, file));
          probe = createLiteBoundaryProbe(work, { forbiddenModules });
          hooks = installLiteBoundaryProbe(probe.config);
          process.env.NODE_OPTIONS = probe.env.NODE_OPTIONS;
          process.env.LITE_BOUNDARY_PROBE = probe.env.LITE_BOUNDARY_PROBE;
        }
        const { createUsageServer } = await import(pathToFileURL(path.join(unpacked, "src/server.js")).href);
        server = createUsageServer({ ...createPaletteServerOptions(fixture), databaseFile });
        await listenOnFetchPort(server);
        const url = `http://127.0.0.1:${server.address().port}/`;
        const get = async (route) => {
          const response = await fetch(`${url}${route}`);
          const text = await response.text();
          assert.equal(response.status, 200, `${edition} ${route}: ${text}`);
          return JSON.parse(text);
        };
        const payload = await get("api/usage?preset=all&view=dashboard");
        assert.equal(payload.summary.totals.total, FIXTURE_TOTAL_TOKENS);
        assert.deepEqual(payload.summary.totals, {
          total: 242800,
          input: 204000,
          cached: 71100,
          output: 38800,
          reasoning: 8800,
        });
        assert.equal(payload.summary.cacheHitRate, 71100 / 204000);
        assertEditionPayload(edition, payload);
        contracts[edition] = commonUsageContract(payload);
        const timeline = await get("api/usage?preset=all&view=timeline");
        assertEditionPayload(edition, timeline);
        assert.deepEqual(
          commonUsageContract(timeline),
          contracts[edition],
          "Timeline route must preserve the common contract",
        );
        const frozen = await get("api/usage?preset=all&view=dashboard&freeze=1");
        assert.ok(frozen.snapshotId);
        const captured = await get(
          `api/usage?preset=all&view=dashboard&snapshot=${encodeURIComponent(frozen.snapshotId)}`,
        );
        assert.deepEqual(commonUsageContract(captured), contracts[edition], "Frozen common contract differs");
        const html = await fetch(url).then((response) => response.text());
        assert.match(html, new RegExp(`data-edition="${edition}"`));
        if (edition === "lite") {
          assert.equal((html.match(/class="metric"/g) || []).length, 6);
          assert.doesNotMatch(
            html,
            /id="(?:themeToggle|shareToggle|skinToggle|achievementToggle|updatePricingButton)"/,
          );
        } else {
          assert.match(html, /id="shareToggle"/);
          assert.match(html, /id="skinToggle"/);
          assert.match(html, /id="updatePricingButton"/);
        }
        for (const file of Object.keys(await releaseInputs(edition, unpacked, { packaged: true, browserOnly: true }))) {
          const response = await fetch(`${url}${file.slice(7)}`);
          assert.equal(response.status, 200, `${edition} missing runtime resource: ${file}`);
          assert.equal(sha256(Buffer.from(await response.arrayBuffer())), manifest.variants[edition].files[file], file);
        }
        for (const route of [
          "api/pricing",
          "api/achievements",
          "share-card.js",
          "skin-palette-studio.html",
          "pricing-models.js",
        ]) {
          const response = await fetch(`${url}${route}`);
          assert.equal(response.status, edition === "lite" ? 404 : 200, `${edition} ${route}`);
        }
        if (edition === "waifu") {
          const achievements = await get("api/achievements");
          assert.equal(achievements.state, "ready");
          assert.equal(achievements.rows.length, 42);
          report.editions[edition].achievements = { state: achievements.state, rows: achievements.rows.length };
        }
        report.editions[edition].totals = payload.summary.totals;
        report.editions[edition].contracts = "six-cards/timeline/periods/metadata/quota/freeze passed";
        if (browserRequested) {
          if (!browser) {
            const runtime = await resolveBrowserRuntime();
            assert.ok(runtime, "ENVIRONMENT_BLOCKED: Playwright/Edge unavailable");
            browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
          }
          for (const [locale, viewport] of [
            ["zh-CN", { width: 1440, height: 900 }],
            ["en-US", { width: 900, height: 900 }],
          ]) {
            report.editions[edition].browser.push(
              await (edition === "lite"
                ? checkLitePage(browser, url, locale, viewport)
                : checkWaifuPage(browser, url, edition, locale, viewport)),
            );
          }
        }
        await server.close();
        server = null;
        report.editions[edition].cli = await checkCli(unpacked, work, edition, databaseFile);
        if (probe) {
          const evidence = probe.read();
          assert.equal(evidence.filter((entry) => entry.forbidden).length, 0);
          assert.ok(
            evidence.some((entry) => entry.kind === "load" && entry.url?.endsWith("/src/usage-executor-lite.js")),
            "Probe must observe the real Lite executor",
          );
          assert.ok(
            evidence.some((entry) => entry.role === "child" && entry.kind === "load"),
            "Probe must observe executor/gateway descendants",
          );
          report.editions[edition].moduleBoundary = {
            forbidden: 0,
            processes: new Set(evidence.map((entry) => entry.pid)).size,
            loads: evidence.filter((entry) => entry.kind === "load").length,
          };
        }
      } finally {
        await server?.close();
        hooks?.close();
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
    assert.deepEqual(
      contracts.lite,
      contracts.waifu,
      "Packaged common six-card/timeline/period/metadata contracts differ",
    );
    report.commonContractSha256 = sha256(JSON.stringify(contracts.lite));
    report.status = "passed";
    if (browserRequested) report.browser = "passed";
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = error.stack;
    throw error;
  } finally {
    report.checkedAt = new Date().toISOString();
    try {
      await writeFile(
        path.join(directory, browserRequested ? "acceptance-browser.json" : "acceptance-http.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          await fixture?.close();
        } finally {
          await removeTemporary(work, parent, "usage-release-check-");
        }
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => arg !== "--browser");
  assert.ok(
    positional.length <= 1 && !positional[0]?.startsWith("--"),
    "Usage: node scripts/check-release.mjs [output/release-directory] [--browser]",
  );
  console.log(
    JSON.stringify(await checkRelease(positional[0], { browserRequested: args.includes("--browser") }), null, 2),
  );
}
