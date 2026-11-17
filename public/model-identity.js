export const MODEL_ALIASES = Object.freeze({
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-daybreak-blue-latest": "gpt-5.6-sol",
  "deepseek-v4.1-flash": "deepseek-flash",
  "deepseek-v4.1-flash-sg": "deepseek-flash",
  // Local Magpie routing-group convention; sync this alias when the group changes.
  "group/deepseek": "deepseek-flash",
});

// Only these pinned snapshots share their base model's identity.
export const CLAUDE_MODEL_SNAPSHOTS = Object.freeze({
  "claude-opus-4-20250514": "claude-opus-4",
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-opus-4-1-20250805": "claude-opus-4-1",
  "claude-opus-4-5-20251101": "claude-opus-4-5",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  "claude-3-5-haiku-20241022": "claude-3-5-haiku",
});

export const CODEX_AUTO_REVIEW_MODEL = "codex-auto-review";

export function isCodexAutoReview(model) {
  return (
    String(model ?? "")
      .trim()
      .toLowerCase() === CODEX_AUTO_REVIEW_MODEL
  );
}

function aliasTarget(model) {
  return (
    (Object.hasOwn(MODEL_ALIASES, model) && MODEL_ALIASES[model]) ||
    (Object.hasOwn(CLAUDE_MODEL_SNAPSHOTS, model) && CLAUDE_MODEL_SNAPSHOTS[model])
  );
}

/** Keep raw input for route/evidence consumers; group only by modelKey. */
export function resolveModelIdentity(rawModel) {
  const raw = String(rawModel ?? "");
  const normalized = raw.trim().toLowerCase();
  const routed = aliasTarget(normalized) || normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
  const modelKey = aliasTarget(routed) || routed;
  return {
    rawModel: raw,
    modelKey,
    displayName: modelKey === "unknown model" ? "Unknown model" : modelKey,
  };
}

/** Catalog-independent display name for existing aggregation callers. */
export function canonicalModelName(rawModel) {
  return resolveModelIdentity(rawModel).displayName;
}
