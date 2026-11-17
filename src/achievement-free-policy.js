import { canonicalModelName, CODEX_AUTO_REVIEW_MODEL } from "../public/pricing-models.js";

/**
 * @typedef {object} AchievementFreePolicy
 * @property {string} evidenceKey Stable persisted evidence record ID.
 * @property {string} version Immutable evidence version, independent of priceVersion.
 * @property {number|string|Date} validFrom Inclusive absolute time.
 * @property {number|string|Date} validUntil Exclusive absolute time; finite and required.
 * @property {string} sourceKind Exact source kind, not a pricing provider.
 * @property {string} model Exact model identity (aliases use canonicalModelName).
 * @property {string} route Exact raw route prefix; empty means an unrouted model.
 * @property {"free"|"paid"|"review"} freeClass
 * @property {"policy"|"explicit-free-identity"} [type]
 */

function absoluteTime(value) {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
          ? Date.parse(value)
          : NaN;
  return Number.isSafeInteger(time) && Number.isFinite(new Date(time).getTime()) ? time : NaN;
}

/** @param {AchievementFreePolicy} policy */
export function validateAchievementFreePolicy(policy) {
  if (!policy || typeof policy !== "object") throw new TypeError("Achievement free policy must be an object");
  for (const field of ["evidenceKey", "version", "sourceKind", "model"]) {
    if (typeof policy[field] !== "string" || !policy[field].trim() || policy[field].includes("*")) {
      throw new TypeError(`Achievement free policy requires an exact ${field}`);
    }
  }
  if (typeof policy.route !== "string" || policy.route.includes("*")) {
    throw new TypeError("Achievement free policy requires an exact route (empty for direct requests)");
  }
  const rawModel = policy.model.trim();
  if (rawModel.includes("/") && rawModel.slice(0, rawModel.lastIndexOf("/")) !== policy.route) {
    throw new TypeError("Achievement free policy model route must agree with its route scope");
  }
  const validFrom = absoluteTime(policy.validFrom);
  const validUntil = absoluteTime(policy.validUntil);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil) || validFrom >= validUntil) {
    throw new RangeError("Achievement free policy requires a finite, nonempty [validFrom, validUntil) interval");
  }
  if (!["free", "paid", "review"].includes(policy.freeClass)) {
    throw new TypeError("Achievement free policy class must be free, paid or review");
  }
  const type = policy.type ?? "policy";
  const model = canonicalModelName(policy.model, {}).toLowerCase();
  if (!["policy", "explicit-free-identity"].includes(type)) throw new TypeError("Invalid achievement free policy type");
  if (
    type === "explicit-free-identity" &&
    (policy.freeClass !== "free" || (model !== "hy4free" && !model.endsWith("-free")))
  ) {
    throw new TypeError("Explicit free identity must name hy4free or an exact -free model and classify free");
  }
  return Object.freeze({
    evidenceKey: policy.evidenceKey,
    version: policy.version,
    validFrom,
    validUntil,
    sourceKind: policy.sourceKind,
    model,
    route: policy.route,
    freeClass: policy.freeClass,
    type,
  });
}

function evidenceIdentity(policy) {
  return JSON.stringify([policy.evidenceKey, policy.version]);
}

/** @param {AchievementFreePolicy[]} policies */
export function validateAchievementFreePolicies(policies) {
  if (!Array.isArray(policies)) throw new TypeError("Achievement free policies must be an array");
  const records = new Map();
  for (const policy of policies) {
    const record = validateAchievementFreePolicy(policy);
    const key = evidenceIdentity(record);
    const previous = records.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
      throw new TypeError("Achievement free evidence identity cannot describe different policies");
    }
    records.set(key, record);
  }
  return Object.freeze([...records.values()]);
}

/** @param {{ policies?: AchievementFreePolicy[] }} [options] */
export function createAchievementFreeClassifier({ policies = [] } = {}) {
  const records = validateAchievementFreePolicies(policies);
  return function classifyAchievementFree(event) {
    const raw = String(event.rawModel ?? event.raw ?? event.model ?? "").trim();
    const model = canonicalModelName(raw, {}).toLowerCase();
    if (model === CODEX_AUTO_REVIEW_MODEL) {
      return { freeClass: "review", freeEvidenceKey: "achievement-review-1" };
    }
    const time = absoluteTime(event.occurredAt);
    const interval = event.precision === "interval" || event.precision === "day";
    const start = interval ? absoluteTime(event.coverage?.start) : time;
    const end = interval ? absoluteTime(event.coverage?.end) : time;
    if (!Number.isFinite(time) || !Number.isFinite(start) || !Number.isFinite(end) || start > end)
      return { freeClass: "unknown", freeEvidenceKey: null };
    const route = event.route ?? (raw.includes("/") ? raw.slice(0, raw.lastIndexOf("/")) : "");
    const matches = records.filter(
      (policy) =>
        policy.validFrom <= end &&
        policy.validUntil > start &&
        event.sourceKind === policy.sourceKind &&
        model === policy.model &&
        route === policy.route,
    );
    const classes = new Set(matches.map((policy) => policy.freeClass));
    if (!matches.length || classes.size !== 1) return { freeClass: "unknown", freeEvidenceKey: null };
    let coveredThrough = start;
    for (const policy of [...matches].sort((a, b) => a.validFrom - b.validFrom)) {
      if (policy.validFrom > coveredThrough) break;
      coveredThrough = Math.max(coveredThrough, policy.validUntil);
    }
    if (coveredThrough <= end) return { freeClass: "unknown", freeEvidenceKey: null };
    return {
      freeClass: matches[0].freeClass,
      freeEvidenceKey: JSON.stringify(matches.map(evidenceIdentity).sort()),
    };
  };
}
