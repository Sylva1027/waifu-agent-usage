import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { achievementShareArt } from "../public/achievement-share-art.js";
import { SKIN_MODES, SKINS } from "../public/skins.js";
import {
  commonHashes,
  packageRelease,
  releaseDirectory,
  releaseFiles,
  ROOT,
  sha256,
} from "../scripts/package-release.mjs";
import {
  ENTRY_OVERRIDES,
  isLiteForbidden,
  readReleaseInput,
  releaseInputs,
  scriptReferences,
} from "../scripts/release-dependencies.mjs";

test("Lite closure binds all canonical entries and retains the exact common runtime and history formats", async () => {
  const inputs = await releaseInputs("lite", ROOT);
  for (const [file, source] of Object.entries(ENTRY_OVERRIDES)) assert.equal(inputs[file], source);
  for (const file of [
    "src/cli-core.js",
    "src/server-core.js",
    "src/usage-executor-client.js",
    "src/usage-executor-worker.js",
    "src/usage-executor-lite.js",
    "src/usage-store-lite.js",
    "src/usage-record-migration.js",
    "src/achievement-backup-format.js",
    "src/achievement-format-descriptor.js",
    "src/pricing-catalog-format.js",
    "src/service-tier-evidence-format.js",
    "public/locale.js",
    "public/source-view.js",
    "public/dashboard-runtime.js",
    "public/dashboard-view-utils.js",
    "public/lite/index.html",
  ])
    assert.ok(inputs[file], file);
  assert.ok(Object.keys(inputs).length > 60);
  assert.deepEqual(Object.keys(inputs).filter(isLiteForbidden), []);
  assert.equal(inputs["public/waifu-achievement-badge.js"], undefined);
  assert.equal(inputs["public/waifu-achievement-notice-effect.js"], undefined);
  assert.equal(inputs["public/waifu-visuals-core.js"], undefined);
  assert.doesNotMatch(Object.keys(inputs).join("\n"), /^public\/waifu-(?:motion|liquid-glass)/m);
  assert.doesNotMatch(Object.keys(inputs).join("\n"), /^public\/(?:assets|i18n|share|skin|achievement)|^src\/waifu/m);
});

test("Waifu closure keeps all achievement badges, share artwork, and dashboard skins", async () => {
  const files = await releaseFiles("waifu");
  const badges = files.filter((file) => file.startsWith("public/assets/achievements/"));
  assert.equal(badges.length, 96);
  assert.equal(new Set(badges.map((file) => file.split("/")[3])).size, 42);
  assert.equal(files.filter((file) => file.startsWith("public/assets/skins/")).length, 32);
  const shareArt = SKINS.filter((skin) => !skin.isClassic).flatMap(({ id }) =>
    SKIN_MODES.flatMap((mode) => {
      const { background, figure } = achievementShareArt(id, mode);
      return [`public${background}`, `public${figure}`];
    }),
  );
  assert.equal(new Set(shareArt).size, 32);
  assert.deepEqual(files.filter((file) => file.startsWith("public/assets/achievement-share/")).sort(), shareArt.sort());
  for (const file of [
    "src/achievement-runtime.js",
    "src/achievement-restore.js",
    "src/usage-record-store.js",
    "src/pricing.js",
    "public/share-card.js",
    "public/skin-palette-studio.js",
    "public/waifu-achievement-badge.js",
    "public/waifu-achievement-notice-effect.js",
    "public/waifu-visuals-core.js",
    "public/waifu-motion.js",
    "public/waifu-motion-controls.js",
    "public/waifu-motion-glass.css",
    "public/waifu-liquid-glass.js",
    "public/waifu-liquid-glass.css",
    "native/windows-source-proof/src/usn.rs",
    "native/windows-source-proof/bin/windows-source-proof.build.json",
  ])
    assert.ok(files.includes(file), file);
  assert.doesNotMatch(files.join("\n"), /target\/|node_modules\/|^(?:test|docs|scripts|output)\//m);
  assert.deepEqual(
    files.filter((file) => file.endsWith(".png")).sort(),
    ["dark", "light"].map((mode) => `public${achievementShareArt("claude", mode).background}`),
  );
  assert.doesNotMatch(files.join("\n"), /^public\/dev\//m);
  assert.equal(files.includes("src/cli-lite.js"), false);
  await assert.rejects(releaseFiles("standard"), /Unknown edition/);
});

test("dependency parsing follows static, dynamic, require, worker URLs and assets but rejects unresolved edges", () => {
  assert.deepEqual(
    scriptReferences(
      "src/example.js",
      'import "./a.js"; export * from "./b.js"; import("./c.js"); require("./d.js"); new URL("./worker.js", import.meta.url);',
    ),
    ["./a.js", "./b.js", "./c.js", "./d.js", "./worker.js"],
  );
  assert.deepEqual(scriptReferences("public/example.js", 'const asset="/assets/skins/a.webp"; import "./view.js";'), [
    "/assets/skins/a.webp",
    "./view.js",
  ]);
  assert.deepEqual(
    scriptReferences("src/example.js", '/** @type {import("./type.js").Type} */\nimport "node:fs";'),
    [],
  );
  assert.throws(() => scriptReferences("src/example.js", "import(variable)"), /Nonliteral/);
  assert.throws(() => scriptReferences("src/example.js", 'import "unshipped-dependency"'), /External/);
});

test("missing release inputs and unsafe paths fail closed", async () => {
  await assert.rejects(readReleaseInput(ROOT, "public/does-not-exist-c19.js"), { code: "ENOENT" });
  for (const file of ["../outside", "C:/outside", "/outside", "src/../../outside"])
    await assert.rejects(readReleaseInput(ROOT, file), /Unsafe/);
});

test("browser manifest follows served imports without exposing Node-only public parser modules", async () => {
  const runtime = await releaseInputs("lite", ROOT);
  const browser = await releaseInputs("lite", ROOT, { browserOnly: true });
  assert.ok(runtime["public/quota-usage.js"]);
  assert.equal(browser["public/quota-usage.js"], undefined);
  assert.ok(browser["public/dashboard-runtime.js"]);
  assert.ok(browser["public/lite/app.js"]);
  assert.ok(Object.keys(browser).every((file) => file.startsWith("public/")));
});

test("shared hashes compare actual common modules, allowing concrete edition entries and exclusive resources", () => {
  const waifu = {
    "src/cli.js": "waifu",
    "src/cli-core.js": "shared",
    "src/pricing.js": "price",
    "public/locale.js": "locale",
  };
  const lite = {
    "src/cli.js": "lite",
    "src/cli-core.js": "shared",
    "src/usage-store-lite.js": "lite-store",
    "public/locale.js": "locale",
  };
  assert.deepEqual(commonHashes(lite, waifu), { "public/locale.js": "locale", "src/cli-core.js": "shared" });
  assert.throws(() => commonHashes({ ...lite, "src/cli-core.js": "changed" }, waifu), /Shared core differs/);
  assert.throws(() => commonHashes({}, waifu), /No shared/);
});

test("runtime inventory shares identical original bytes for every real common dependency", async () => {
  const variants = {};
  for (const edition of ["lite", "waifu"]) {
    variants[edition] = {};
    for (const [file, source] of Object.entries(await releaseInputs(edition, ROOT)))
      variants[edition][file] = sha256(await readReleaseInput(ROOT, source));
  }
  const core = commonHashes(variants.lite, variants.waifu);
  assert.ok(core["src/cli-core.js"]);
  assert.ok(core["src/history-backup.js"]);
  assert.ok(!Object.hasOwn(core, "src/cli.js"));
  assert.ok(!Object.hasOwn(core, "src/pricing.js"));
});

test("output validation preserves earlier releases and rejects user/source or linked locations", async (t) => {
  for (const directory of [".", "output", "public", "output/..", "../outside", path.parse(ROOT).root])
    await assert.rejects(releaseDirectory(ROOT, directory), /child of workspace\/output/);
  await mkdir(path.join(ROOT, "output"), { recursive: true });
  const fixture = await mkdtemp(path.join(ROOT, "output/package-test-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const existing = path.join(fixture, "existing");
  await mkdir(existing);
  await writeFile(path.join(existing, "user-data.txt"), "keep");
  await assert.rejects(packageRelease(existing), { code: "EEXIST" });
  await assert.rejects(releaseDirectory(ROOT, path.join(existing, "user-data.txt/release")), /linked\/non-directory/);
  assert.equal(await readFile(path.join(existing, "user-data.txt"), "utf8"), "keep");
});
