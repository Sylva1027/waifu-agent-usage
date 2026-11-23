import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateAchievementTimeZone } from "./achievement-calendar.js";
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } from "./achievement-catalog.js";
import { evaluateCalendarAchievements } from "./achievement-evaluate-calendar.js";
import { evaluateCumulativeAchievements } from "./achievement-evaluate-cumulative.js";
import { evaluateMetaAchievements, evaluateOperationAchievements } from "./achievement-evaluate-operations.js";

const catalog = new Map(ACHIEVEMENT_CATALOG.map((row) => [row.id, row]));
const catalogHash = createHash("sha256").update(JSON.stringify(ACHIEVEMENT_CATALOG)).digest("hex");
const metaIds = new Set(["A73", "A74", "A75", "A76"]);

function instant(value) {
  const result =
    typeof value === "number"
      ? value
      : typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
        ? Date.parse(value)
        : NaN;
  if (!Number.isSafeInteger(result) || !Number.isFinite(new Date(result).getTime()))
    throw new TypeError("Invalid achievement evaluation timestamp");
  return result;
}

function contextFor(input) {
  const { profile, cutoff, facts, operations } = input;
  if (
    !profile ||
    profile.rulesVersion !== ACHIEVEMENT_RULES_VERSION ||
    profile.catalogHash !== catalogHash ||
    typeof input.inputKey !== "string" ||
    !input.inputKey
  )
    throw new TypeError("Achievement evaluation requires a prepared R7 input");
  const enabledAt = instant(profile.enabledAt);
  const usageStart = instant(input.usageStart ?? enabledAt);
  instant(cutoff);
  if (
    typeof cutoff !== "number" ||
    cutoff < Math.max(enabledAt, usageStart) ||
    !Array.isArray(facts) ||
    !Array.isArray(operations)
  )
    throw new TypeError("Invalid prepared achievement input");
  validateAchievementTimeZone(profile.timeZone);
  const unique = new Map();
  for (const fact of facts) {
    if (
      typeof fact.factKey !== "string" ||
      !fact.factKey ||
      typeof fact.revision !== "string" ||
      !fact.revision ||
      typeof fact.totalTokens !== "string" ||
      !/^\d+$/.test(fact.totalTokens) ||
      !["instant", "day", "interval"].includes(fact.precision) ||
      !fact.coverage ||
      !["free", "paid", "review", "unknown"].includes(fact.freeClass) ||
      (fact.freeClass === "free" && (typeof fact.freeEvidenceKey !== "string" || !fact.freeEvidenceKey))
    )
      throw new TypeError("Invalid canonical achievement fact");
    if ([fact.occurredAt, fact.coverage.start, fact.coverage.end].some((value) => typeof value !== "number"))
      throw new TypeError("Canonical achievement facts require UTC milliseconds");
    const start = instant(fact.coverage.start),
      end = instant(fact.coverage.end);
    if (start > end || instant(fact.occurredAt) !== end || (fact.precision === "instant" && start !== end))
      throw new TypeError("Invalid achievement fact coverage");
    for (const key of ["modelId", "providerId", "harnessId", "sessionKey", "repositoryKey"])
      if (fact[key] !== null && (typeof fact[key] !== "string" || !fact[key]))
        throw new TypeError("Invalid canonical achievement identity");
    if (unique.has(fact.factKey) && !isDeepStrictEqual(unique.get(fact.factKey), fact))
      throw new Error("Conflicting achievement fact revisions");
    unique.set(fact.factKey, fact);
  }
  const eligible = [...unique.values()].filter(
    (fact) => fact.coverage.start >= usageStart && fact.coverage.end < cutoff && BigInt(fact.totalTokens) > 0n,
  );
  const filteredOperations = operations.filter((operation) => {
    if (!operation || typeof operation.kind !== "string" || typeof operation.key !== "string" || !operation.key)
      throw new TypeError("Invalid achievement operation");
    const at = instant(operation.occurredAt);
    return at >= enabledAt && at < cutoff;
  });
  return { facts: eligible, operations: filteredOperations, enabledAt: usageStart, cutoff, timeZone: profile.timeZone };
}

/** Evaluate one completed canonical input; award times are assigned only by AchievementStore. */
export function evaluateAchievements(input, existingAwards = []) {
  const context = contextFor(input);
  const earned = new Map(ACHIEVEMENT_CATALOG.map(({ id }) => [id, new Set()]));
  for (const { id, tier } of existingAwards) {
    const row = catalog.get(id),
      index = row?.tiers.indexOf(tier);
    if (!row || index < 0) throw new TypeError("Unknown existing achievement award");
    for (const lower of row.tiers.slice(0, index + 1)) earned.get(id).add(lower);
  }
  const awards = [];
  const values = {};
  const accept = (id, value) => {
    const row = catalog.get(id);
    if (!row || Object.hasOwn(values, id) || typeof value !== "bigint" || value < 0n)
      throw new Error("Invalid or duplicate achievement evaluator result");
    values[id] = value;
    row.tiers.forEach((tier, index) => {
      if (value >= BigInt(row.thresholds[index]) && !earned.get(id).has(tier)) {
        earned.get(id).add(tier);
        awards.push({ id, tier });
      }
    });
  };
  for (const group of [
    evaluateCumulativeAchievements(context),
    evaluateCalendarAchievements(context),
    evaluateOperationAchievements(context),
  ])
    for (const [id, value] of Object.entries(group)) {
      if (metaIds.has(id)) throw new Error("Meta achievements must follow base evaluation");
      accept(id, value);
    }
  const grandSlams = evaluateMetaAchievements(earned);
  for (const id of ["A73", "A74", "A75"]) accept(id, grandSlams[id]);
  accept("A76", evaluateMetaAchievements(earned).A76);
  if (Object.keys(values).length !== catalog.size) throw new Error("Incomplete achievement evaluation");
  const rows = ACHIEVEMENT_CATALOG.map(({ id, tiers, thresholds }) => ({
    id,
    observedValue: values[id].toString(),
    nextTarget: thresholds[tiers.findIndex((tier) => !earned.get(id).has(tier))] ?? null,
  }));
  return { inputKey: input.inputKey, evaluatedThrough: context.cutoff, rows, awards };
}

/** Explicit S08-C publication only; formal scheduling and event hooks belong to S08-D. */
export function commitAchievementEvaluation(archive, input) {
  const previous = archive.readSnapshot();
  if (
    !previous ||
    ["profileId", "enabledAt", "timeZone", "rulesVersion", "catalogHash"].some(
      (key) => previous[key] !== input.profile?.[key],
    )
  )
    throw new Error("Achievement input belongs to a different profile");
  const result = evaluateAchievements(input, previous.awards);
  return archive.commitBatch({ ...result, expectedProgressRevision: input.profile.progressRevision });
}
