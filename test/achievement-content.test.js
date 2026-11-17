import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  ACHIEVEMENT_CONTENT,
  achievementCopy,
  achievementUi,
  categoryEnglishLabels,
  categoryOrder,
} from "../public/achievement-content.js";
import { ACHIEVEMENT_CATALOG } from "../src/achievement-catalog.js";
import { englishAchievements, interfaceCopy } from "./fixtures/achievements/translations.mjs";
import {
  categoryOrder as approvedCategoryOrder,
  categoryEnglishLabels as approvedCategoryEnglishLabels,
} from "./fixtures/achievements/recent.mjs";

const approvedRoot = new URL("./fixtures/achievements/", import.meta.url);
const assetRoot = new URL("../public/assets/achievements/", import.meta.url);
const json = async (url) => JSON.parse(await readFile(url, "utf8"));
const approved = await json(new URL("achievements.json", approvedRoot));
const flavor = await json(new URL("achievement-flavor.json", approvedRoot));
const resources = await json(new URL("./fixtures/achievements/resources.json", import.meta.url));

test("production content preserves all 42 approved IDs, order, labels and exact thresholds", () => {
  assert.equal(ACHIEVEMENT_CONTENT.length, 42);
  assert.equal(new Set(ACHIEVEMENT_CONTENT.map((row) => row.id)).size, 42);
  assert.deepEqual(
    ACHIEVEMENT_CONTENT.map((row) => row.id),
    approved.rows.map((row) => row.id),
  );
  assert.deepEqual(ACHIEVEMENT_CONTENT.map((row) => row.id).sort(), ACHIEVEMENT_CATALOG.map((row) => row.id).sort());
  assert.equal(ACHIEVEMENT_CONTENT.filter((row) => row.tiered).length, 27);
  assert.equal(ACHIEVEMENT_CONTENT.filter((row) => !row.tiered).length, 15);
  assert.deepEqual(categoryOrder, approvedCategoryOrder);
  assert.deepEqual(categoryEnglishLabels, approvedCategoryEnglishLabels);
  for (const row of ACHIEVEMENT_CONTENT) {
    const original = approved.rows.find((entry) => entry.id === row.id);
    const rule = ACHIEVEMENT_CATALOG.find((entry) => entry.id === row.id);
    assert.deepEqual(
      Object.keys(row).sort(),
      ["id", "category", "tiered", "unit", "levels", "thresholds", "zh", "en"].sort(),
    );
    for (const key of ["category", "tiered", "unit", "levels"])
      assert.deepEqual(row[key], original[key], `${row.id}.${key}`);
    assert.deepEqual(row.thresholds, rule.thresholds, row.id);
    assert.equal(row.tiered, rule.tiers.length === 3);
    for (const threshold of row.thresholds) assert.match(threshold, /^\d+$/);
  }
});

test("all bilingual names, conditions and revision 382 explanations match current S07 bytes", () => {
  assert.equal(flavor.revision, 382);
  assert.equal(resources.flavorRevision, 382);
  assert.deepEqual(flavor.rows.map((row) => row.id).sort(), ACHIEVEMENT_CONTENT.map((row) => row.id).sort());
  for (const row of ACHIEVEMENT_CONTENT) {
    const original = approved.rows.find((entry) => entry.id === row.id);
    const explanation = flavor.rows.find((entry) => entry.id === row.id);
    assert.deepEqual(row.zh, { name: original.name, description: original.description, flavor: explanation.zh });
    assert.deepEqual(row.en, { ...englishAchievements[row.id], flavor: explanation.en });
    for (const [locale, key] of [
      ["zh-CN", "zh"],
      ["en", "en"],
      ["en-US", "en"],
    ]) {
      assert.deepEqual(achievementCopy(row, locale), row[key]);
      for (const value of Object.values(row[key])) assert.ok(value.length > 0, `${row.id}.${locale}`);
    }
    assert.deepEqual(achievementCopy(row), row.zh);
  }
});

test("product UI retains approved visible and accessible copy without authoring controls", () => {
  const additions = ["loading", "loadFailed", "retry"];
  const keys = [
    "title",
    "search",
    "searchPlaceholder",
    "status",
    "categories",
    "statuses",
    "grades",
    "view",
    "details",
    "progress",
    "previewGrade",
    "tier",
    "earned",
    "updated",
    "notEarned",
    "noRecent",
    "noRecentHint",
    "noMatches",
    "noMatchesHint",
  ];
  for (const locale of ["zh-CN", "en", "en-US"]) {
    const ui = achievementUi(locale);
    const original = interfaceCopy[locale === "en-US" ? "en" : locale];
    assert.deepEqual(Object.keys(ui).sort(), [...keys, ...additions].sort());
    for (const key of keys) {
      if (typeof ui[key] !== "function") {
        assert.deepEqual(ui[key], original[key], `${locale}.${key}`);
        continue;
      }
      for (const row of ACHIEVEMENT_CONTENT) {
        const text = achievementCopy(row, locale);
        for (const threshold of row.levels) {
          for (const date of ["", "Nov 16, 2026", "2026.11.16"]) {
            const args = key === "previewGrade" || key === "tier" ? [ui.grades.gold, threshold, date] : [text.name];
            assert.equal(ui[key](...args), original[key](...args), `${locale}.${row.id}.${key}`);
          }
        }
      }
    }
    for (const key of additions) assert.equal(typeof ui[key], "string");
    assert.doesNotMatch(ui.loadFailed, /样稿|preview/i);
  }
  assert.equal(achievementUi("en-US"), achievementUi("en"));
  assert.equal(achievementUi(), achievementUi("zh-CN"));
});

test("all 96 production WebPs match independent frozen SHA-256, bytes and 256px alpha headers", async () => {
  const digests = await json(new URL("badge-digests.json", approvedRoot));
  assert.equal(digests.length, 96);
  assert.equal(new Set(digests.map((entry) => entry.file)).size, 96);
  const expected = ACHIEVEMENT_CONTENT.flatMap((row) =>
    (row.tiered ? ["bronze", "silver", "gold"] : ["stone"]).map((grade) => `${row.id}/${grade}.webp`),
  );
  assert.equal(resources.resources.length, 96);
  assert.deepEqual(
    resources.resources.map((row) => `${row.id}/${row.grade}.webp`),
    expected,
  );
  assert.deepEqual((await readdir(assetRoot)).sort(), ACHIEVEMENT_CONTENT.map((row) => row.id).sort());
  for (const row of ACHIEVEMENT_CONTENT) {
    assert.deepEqual(
      (await readdir(new URL(`${row.id}/`, assetRoot))).sort(),
      expected
        .filter((file) => file.startsWith(`${row.id}/`))
        .map((file) => file.split("/")[1])
        .sort(),
    );
  }
  let totalBytes = 0;
  for (const resource of resources.resources) {
    const file = `${resource.id}/${resource.grade}.webp`;
    const original = digests.find((entry) => entry.file === file);
    const actual = await readFile(new URL(file, assetRoot));
    assert.equal(actual.length, original.bytes, file);
    assert.equal(actual.length, resource.bytes, file);
    const sha256 = createHash("sha256").update(actual).digest("hex");
    assert.equal(sha256, original.sha256, file);
    assert.equal(sha256, resource.sha256, file);
    assert.equal(resource.url, `/assets/achievements/${file}`);
    assert.equal(actual.toString("ascii", 0, 4), "RIFF", file);
    assert.equal(actual.readUInt32LE(4) + 8, actual.length, file);
    assert.equal(actual.toString("ascii", 8, 16), "WEBPVP8X", file);
    assert.equal(actual[20] & 0x10, 0x10, file);
    assert.equal(actual.readUIntLE(24, 3) + 1, 256, file);
    assert.equal(actual.readUIntLE(27, 3) + 1, 256, file);
    assert.equal(resource.width, 256);
    assert.equal(resource.height, 256);
    totalBytes += actual.length;
  }
  assert.equal(totalBytes, 1618302);
  assert.deepEqual(resources.summary, {
    achievements: 42,
    tiered: 27,
    oneTime: 15,
    images: 96,
    bytes: totalBytes,
    width: 256,
    height: 256,
  });
});

test("production content imports standalone without docs, output, sample data or authoring runtime", async () => {
  const source = await readFile(new URL("../public/achievement-content.js", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /\bimport\b|\bfetch\s*\(|docs\/|output\/|illustrative|\bsample\b|flavor-editor|api\/flavor|badgePrompts/,
  );
  const standalone = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.deepEqual(standalone.ACHIEVEMENT_CONTENT, ACHIEVEMENT_CONTENT);
  assert.equal(standalone.achievementUi("en-US").title, "Achievements");
});
