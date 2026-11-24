import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isCharacterSkin, listSkinIds } from "../public/skins.js";
import { ACHIEVEMENT_CATALOG } from "../src/achievement-catalog.js";
import { evaluateMetaAchievements, evaluateOperationAchievements } from "../src/achievement-evaluate-operations.js";
import { AchievementStore } from "../src/achievement-store.js";

const oracle = JSON.parse(readFileSync(new URL("./fixtures/achievements/rule-cases.json", import.meta.url), "utf8"));
const operationIds = ["A43", "A44", "A46"];
const metaIds = ["A73", "A74", "A75", "A76"];
const characterIds = listSkinIds().filter(isCharacterSkin);
const T0 = Date.parse("2026-11-17T00:00:00Z");
const context = (operations = []) => ({ facts: [], operations, enabledAt: T0, cutoff: T0 + 1000, timeZone: "UTC" });
const receipt = (kind, key, payload = {}) => ({ kind, key, occurredAt: new Date(T0 + 1).toISOString(), payload });
const dependencyRule = (id) => oracle.rows.find((row) => row.id === id);

function operationInput(id, count) {
  if (id === "A43") return Array.from({ length: count }, (_, i) => receipt("share", `snapshot-${i}`));
  if (id === "A46") return Array.from({ length: count }, (_, i) => receipt("restore", `restore-${i}`));
  const operations = characterIds.slice(0, count).map((characterId) => receipt("skin", characterId, { characterId }));
  if (count > characterIds.length) {
    operations.push(receipt("skin", "repeated-character", { characterId: characterIds[0], mode: "dark" }));
    operations.push(receipt("skin", "unknown-character", { characterId: "not-a-character" }));
  }
  return operations;
}

function dependencyInput(row, count) {
  const ids = row.requires.ids;
  const earned = new Map(
    ids.slice(0, count).map((id) => [id, new Set([row.requires.level || (id === "A43" ? "bronze" : "stone")])]),
  );
  if (count > ids.length) {
    earned.get(ids[0]).add(row.requires.level || "stone");
    earned.set("A99", new Set(["stone", "bronze", "silver", "gold"]));
  }
  return earned;
}

for (const row of oracle.rows.filter(({ id }) => operationIds.includes(id) || metaIds.includes(id))) {
  for (const boundary of row.boundaryCases) {
    test(`S08-C ${boundary.caseId}`, () => {
      const input = operationIds.includes(row.id)
        ? context(operationInput(row.id, Number(boundary.requestedMetric)))
        : dependencyInput(row, Number(boundary.requestedMetric));
      const evaluate = operationIds.includes(row.id) ? evaluateOperationAchievements : evaluateMetaAchievements;
      const result = evaluate(input);
      assert.equal(result[row.id], BigInt(boundary.effectiveMetric), "observedValue");
      assert.equal(result[row.id] >= BigInt(boundary.target), boundary.expected.reachesTarget, "reachesTarget");
      const tiers = row.tiered ? ["bronze", "silver", "gold"] : ["stone"];
      const highest = tiers.filter((_, i) => result[row.id] >= BigInt(row.thresholds[i])).at(-1) || null;
      assert.equal(highest, boundary.expected.highestEarned);
      assert.deepEqual(evaluate(input), result, "same input replays unchanged");
    });
  }
}

test("operations produce only the three owned zero counters without facts or receipts", () => {
  assert.deepEqual(evaluateOperationAchievements(context()), { A43: 0n, A44: 0n, A46: 0n });
  assert.deepEqual(evaluateMetaAchievements(new Map()), { A73: 0n, A74: 0n, A75: 0n, A76: 0n });
});

test("share deduplicates data snapshots across copy, save, layout, metric and theme changes", () => {
  const operations = [
    receipt("share", "original-snapshot", { action: "copy", layout: "portrait", metric: "total" }),
    receipt("share", "original-snapshot", { action: "save", layout: "landscape", metric: "input", mode: "dark" }),
    receipt("share", "new-data-snapshot"),
    receipt("share", "original-snapshot", { action: "copy" }),
    receipt("share-preview", "preview"),
    receipt("share-failed", "failed-copy"),
  ];
  assert.deepEqual(evaluateOperationAchievements(context(operations)), { A43: 2n, A44: 0n, A46: 0n });
});

test("skin uses active registry IDs and excludes retired skins, classic, variants, aliases and missing payloads", () => {
  assert.equal(characterIds.length, Number(ACHIEVEMENT_CATALOG.find(({ id }) => id === "A44").thresholds[0]));
  const operations = [
    ...characterIds.flatMap((characterId) => [
      receipt("skin", `${characterId}-light`, { characterId, mode: "light", opacity: 0.5 }),
      receipt("skin", `${characterId}-dark`, { characterId, mode: "dark", opacity: 1 }),
    ]),
    ...["muse", "mimo", "classic", "chatgpt-light", "chatgpt/dark", "ChatGPT", "unknown", "", null, 1].map(
      (characterId, i) => receipt("skin", `invalid-${i}`, { characterId }),
    ),
    receipt("skin", "missing-character", { skinId: "chatgpt" }),
    receipt("skin", "null-payload", null),
    receipt("skin-preview", "preview", { characterId: "chatgpt" }),
    receipt("skin-preload", "preload", { characterId: "claude" }),
  ];
  assert.deepEqual(evaluateOperationAchievements(context(operations)), { A43: 0n, A44: 8n, A46: 0n });
  assert.equal(evaluateOperationAchievements(context([receipt("skin", "alias", { characterId: "ChatGPT" })])).A44, 0n);
});

test("operation kind and key determine replay identity and retain the first skin payload", () => {
  const operations = [
    receipt("share", "same-key"),
    receipt("share", "same-key"),
    receipt("restore", "same-key"),
    receipt("restore", "same-key"),
    receipt("skin", "same-key", { characterId: "chatgpt" }),
    receipt("skin", "same-key", { characterId: "claude" }),
  ];
  const before = structuredClone(operations);
  assert.deepEqual(evaluateOperationAchievements(context(operations)), { A43: 1n, A44: 1n, A46: 1n });
  assert.deepEqual(operations, before);
});

test("restore counts distinct successful top-level receipts and ignores other operation kinds", () => {
  const operations = [
    receipt("restore", "published-package-1"),
    receipt("restore", "published-package-1"),
    receipt("restore", "published-package-2"),
    ...["verify", "import", "restore-internal", "restore-failed", "archive-copy", "A46", "toString"].map((kind) =>
      receipt(kind, kind),
    ),
  ];
  assert.deepEqual(evaluateOperationAchievements(context(operations)), { A43: 0n, A44: 0n, A46: 2n });
});

test("empty or non-string credentials cannot create operation counts", () => {
  const operations = ["share", "skin", "restore"].flatMap((kind) =>
    ["", "   ", null, undefined, 0, {}].map((key) => receipt(kind, key, { characterId: "chatgpt" })),
  );
  assert.deepEqual(evaluateOperationAchievements(context(operations)), { A43: 0n, A44: 0n, A46: 0n });
});

test("meta counts the exact 27 tiered IDs and exact 11 story dependencies without self cycles", () => {
  const tiered = ACHIEVEMENT_CATALOG.filter(({ tiers }) => tiers.includes("bronze")).map(({ id }) => id);
  assert.equal(tiered.length, 27);
  for (const id of ["A73", "A74", "A75"]) assert.deepEqual(tiered, dependencyRule(id).requires.ids);
  const story = dependencyRule("A76").requires.ids;
  assert.equal(story.length, 11);
  for (const id of tiered) {
    assert.equal(metaIds.includes(id), false);
    const result = evaluateMetaAchievements(new Map([[id, new Set(["gold"])]]));
    assert.deepEqual(result, { A73: 1n, A74: 1n, A75: 1n, A76: id === "A43" ? 1n : 0n });
  }
  for (const id of story) {
    assert.notEqual(id, "A76");
    const result = evaluateMetaAchievements(new Map([[id, new Set([id === "A43" ? "bronze" : "stone"])]]));
    assert.equal(result.A76, 1n, id);
  }
  const excluded = ACHIEVEMENT_CATALOG.filter(({ id }) => !story.includes(id));
  for (const { id } of excluded) {
    assert.equal(evaluateMetaAchievements(new Map([[id, new Set(["stone", "gold"])]])).A76, 0n, id);
  }
});

test("each dependency contributes once and higher tiers satisfy lower tier dependencies", () => {
  for (const [tier, expected] of [
    ["bronze", { A73: 1n, A74: 0n, A75: 0n, A76: 1n }],
    ["silver", { A73: 1n, A74: 1n, A75: 0n, A76: 1n }],
    ["gold", { A73: 1n, A74: 1n, A75: 1n, A76: 1n }],
  ]) {
    assert.deepEqual(evaluateMetaAchievements(new Map([["A43", new Set([tier])]])), expected);
  }
  assert.deepEqual(evaluateMetaAchievements(new Map([["A43", new Set(["bronze", "silver", "gold", "gold"])]])), {
    A73: 1n,
    A74: 1n,
    A75: 1n,
    A76: 1n,
  });
});

test("illegal tier combinations, unknown IDs and token milestones cannot satisfy meta dependencies", () => {
  const earned = new Map([
    ["A43", new Set(["stone", "special", "platinum"])],
    ["A31", new Set(["gold", "bronze"])],
    ["A73", new Set(["gold"])],
    ["A76", new Set(["stone"])],
    ["A40", new Set(["stone"])],
    ["A99", new Set(["stone", "bronze", "silver", "gold"])],
    ["A01", new Set()],
    ...["A32", "A69", "A70", "A71"].map((id) => [id, new Set(["stone"])]),
  ]);
  assert.deepEqual(evaluateMetaAchievements(earned), { A73: 0n, A74: 0n, A75: 0n, A76: 0n });
});

test("meta observes supplied earned records without mutating them or granting intermediate awards", () => {
  const earned = dependencyInput(dependencyRule("A75"), 27);
  const before = structuredClone(earned);
  assert.deepEqual(evaluateMetaAchievements(earned), { A73: 27n, A74: 27n, A75: 27n, A76: 1n });
  assert.deepEqual(earned, before);
  for (const id of ["A73", "A74", "A75"]) earned.set(id, new Set(["stone"]));
  assert.equal(evaluateMetaAchievements(earned).A76, 4n);
});

test("persisted dependency awards survive progress removal and isolated archive reopen", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "achievement-operation-meta-"));
  const store = new AchievementStore({
    databaseFile: path.join(directory, "achievements.sqlite"),
    catalog: ACHIEVEMENT_CATALOG,
    clock: () => T0 + 10,
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  try {
    store.open({ enabledAt: T0, timeZone: "UTC", rulesVersion: "R7-production-1", catalogHash: "isolated-test" });
    const earned = dependencyInput(dependencyRule("A75"), 27);
    for (const id of dependencyRule("A76").requires.ids) {
      if (!earned.has(id)) earned.set(id, new Set(["stone"]));
    }
    const rows = ACHIEVEMENT_CATALOG.map(({ id }) => ({ id, observedValue: "0", nextTarget: null }));
    store.commitBatch({
      inputKey: "all-dependencies",
      evaluatedThrough: T0 + 10,
      rows,
      awards: [...earned].flatMap(([id, tiers]) => [...tiers].map((tier) => ({ id, tier }))),
    });
    store.clearProgress();
    const before = store.readSnapshot();
    store.close();
    store.open();
    assert.deepEqual(store.readSnapshot(), before);
    assert.equal(before.rows, null);
    const persisted = new Map();
    for (const { id, tier } of store.readSnapshot().awards) {
      if (!persisted.has(id)) persisted.set(id, new Set());
      persisted.get(id).add(tier);
    }
    assert.deepEqual(evaluateOperationAchievements(context()), { A43: 0n, A44: 0n, A46: 0n });
    assert.deepEqual(evaluateMetaAchievements(persisted), { A73: 27n, A74: 27n, A75: 27n, A76: 11n });
  } finally {
    store.close();
  }
});
