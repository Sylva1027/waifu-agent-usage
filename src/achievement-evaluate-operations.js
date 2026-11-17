import { isCharacterSkin } from "../public/skins.js";
import { ACHIEVEMENT_CATALOG } from "./achievement-catalog.js";

const tieredIds = ACHIEVEMENT_CATALOG.filter(({ tiers }) => tiers.includes("bronze")).map(({ id }) => id);
const storyIds = ["A31", "A33", "A36", "A38", "A39", "A43", "A44", "A46", "A73", "A74", "A75"];
const storyDependencies = ACHIEVEMENT_CATALOG.filter(({ id }) => storyIds.includes(id));

// Only successful, trusted receipts enter operations; main has already applied T0/cutoff.
export function evaluateOperationAchievements({ operations }) {
  const seen = new Map(["share", "skin", "restore"].map((kind) => [kind, new Set()]));
  const characters = new Set();
  for (const { kind, key, payload } of operations) {
    const keys = seen.get(kind);
    if (!keys || typeof key !== "string" || !key.trim() || keys.has(key)) continue;
    keys.add(key);
    if (kind === "skin" && isCharacterSkin(payload?.characterId)) characters.add(payload.characterId);
  }
  return { A43: BigInt(seen.get("share").size), A44: BigInt(characters.size), A46: BigInt(seen.get("restore").size) };
}

export function evaluateMetaAchievements(earned) {
  const hasTier = (id, tiers) => tiers.some((tier) => earned.get(id)?.has(tier));
  const countTiered = (tiers) => BigInt(tieredIds.filter((id) => hasTier(id, tiers)).length);
  return {
    A73: countTiered(["bronze", "silver", "gold"]),
    A74: countTiered(["silver", "gold"]),
    A75: countTiered(["gold"]),
    A76: BigInt(storyDependencies.filter(({ id, tiers }) => hasTier(id, tiers)).length),
  };
}
