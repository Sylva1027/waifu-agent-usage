// Generated from achievement-catalog.js; parity is checked by achievement-backup-format.test.js.
export const ACHIEVEMENT_FORMAT_RULES_VERSION = "R7-production-2";
export const ACHIEVEMENT_FORMAT_CATALOG_HASH = "e23dc3e34c58fd24df5045c6e92417518788437ba61b25a36e60b60968092f39";

export function supportsAchievementRuleDirectory({ rulesVersion, catalogHash }) {
  return (
    (rulesVersion === ACHIEVEMENT_FORMAT_RULES_VERSION && catalogHash === ACHIEVEMENT_FORMAT_CATALOG_HASH) ||
    (rulesVersion === "R7-production-1" &&
      catalogHash === "75e83543b974ff9245c0222a01ffab5a50e4c9cb6276054a12ed16518ea30b4c")
  );
}
export const ACHIEVEMENT_FORMAT_CATALOG = Object.freeze(
  [
    { id: "A01", tiers: ["bronze", "silver", "gold"] },
    { id: "A06", tiers: ["bronze", "silver", "gold"] },
    { id: "A07", tiers: ["bronze", "silver", "gold"] },
    { id: "A08", tiers: ["bronze", "silver", "gold"] },
    { id: "A09", tiers: ["bronze", "silver", "gold"] },
    { id: "A10", tiers: ["bronze", "silver", "gold"] },
    { id: "A11", tiers: ["bronze", "silver", "gold"] },
    { id: "A12", tiers: ["bronze", "silver", "gold"] },
    { id: "A13", tiers: ["bronze", "silver", "gold"] },
    { id: "A14", tiers: ["bronze", "silver", "gold"] },
    { id: "A16", tiers: ["bronze", "silver", "gold"] },
    { id: "A18", tiers: ["bronze", "silver", "gold"] },
    { id: "A19", tiers: ["bronze", "silver", "gold"] },
    { id: "A23", tiers: ["bronze", "silver", "gold"] },
    { id: "A24", tiers: ["bronze", "silver", "gold"] },
    { id: "A28", tiers: ["bronze", "silver", "gold"] },
    { id: "A29", tiers: ["bronze", "silver", "gold"] },
    { id: "A30", tiers: ["bronze", "silver", "gold"] },
    { id: "A31", tiers: ["stone"] },
    { id: "A32", tiers: ["stone"] },
    { id: "A33", tiers: ["stone"] },
    { id: "A36", tiers: ["stone"] },
    { id: "A38", tiers: ["stone"] },
    { id: "A39", tiers: ["stone"] },
    { id: "A43", tiers: ["bronze", "silver", "gold"] },
    { id: "A44", tiers: ["stone"] },
    { id: "A46", tiers: ["stone"] },
    { id: "A53", tiers: ["bronze", "silver", "gold"] },
    { id: "A54", tiers: ["bronze", "silver", "gold"] },
    { id: "A55", tiers: ["bronze", "silver", "gold"] },
    { id: "A56", tiers: ["bronze", "silver", "gold"] },
    { id: "A58", tiers: ["bronze", "silver", "gold"] },
    { id: "A59", tiers: ["bronze", "silver", "gold"] },
    { id: "A63", tiers: ["bronze", "silver", "gold"] },
    { id: "A65", tiers: ["bronze", "silver", "gold"] },
    { id: "A69", tiers: ["stone"] },
    { id: "A70", tiers: ["stone"] },
    { id: "A71", tiers: ["stone"] },
    { id: "A73", tiers: ["stone"] },
    { id: "A74", tiers: ["stone"] },
    { id: "A75", tiers: ["stone"] },
    { id: "A76", tiers: ["stone"] },
  ].map(({ id, tiers }) => Object.freeze({ id, tiers: Object.freeze(tiers) })),
);
