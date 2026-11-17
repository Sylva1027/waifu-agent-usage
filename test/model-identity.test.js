import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalModelName,
  CLAUDE_MODEL_SNAPSHOTS,
  CODEX_AUTO_REVIEW_MODEL,
  isCodexAutoReview,
  MODEL_ALIASES,
  resolveModelIdentity,
} from "../public/model-identity.js";
import { canonicalModelName as legacyModelName } from "../public/pricing-models.js";
import { createAchievementFreeClassifier, validateAchievementFreePolicy } from "../src/achievement-free-policy.js";
import { createAchievementIdentity } from "../src/achievement-identity.js";

test("model identity preserves raw input and gives case variants one deterministic key and display", () => {
  const raw = "  Gateway/Vendor/Muse-Spark-1.3-Contributor  ";
  assert.deepEqual(resolveModelIdentity(raw), {
    rawModel: raw,
    modelKey: "muse-spark-1.3-contributor",
    displayName: "muse-spark-1.3-contributor",
  });
  for (const name of [raw, "muse-spark-1.3-contributor", "MUSE-SPARK-1.3-CONTRIBUTOR"]) {
    assert.equal(resolveModelIdentity(name).modelKey, "muse-spark-1.3-contributor");
    assert.equal(canonicalModelName(name), "muse-spark-1.3-contributor");
  }
  assert.deepEqual(resolveModelIdentity(" Unknown model "), {
    rawModel: " Unknown model ",
    modelKey: "unknown model",
    displayName: "Unknown model",
  });
  for (const value of [null, undefined, "", "  "]) {
    assert.equal(resolveModelIdentity(value).modelKey, "");
    assert.equal(canonicalModelName(value), "");
  }
});

test("existing explicit aliases resolve before route removal without broadening group aliases", () => {
  for (const [raw, expected] of [
    ["gpt-5.6", "gpt-5.6-sol"],
    ["gateway/gpt-daybreak-blue-latest", "gpt-5.6-sol"],
    ["workbuddy-ai/deepseek-v4.1-flash-sg", "deepseek-flash"],
    ["opendesign/deepseek-v4.1-flash", "deepseek-flash"],
    ["group/deepseek", "deepseek-flash"],
    ["opencode-go/gemini-4-argon-contributor", "gemini-4-argon-contributor"],
    ["gateway/group/deepseek", "deepseek"],
    ["group/other", "other"],
    ["gateway/", "gateway/"],
  ]) {
    assert.equal(canonicalModelName(raw), expected, raw);
    assert.equal(canonicalModelName(raw.toUpperCase()), expected, raw);
  }
  assert.ok(Object.isFrozen(MODEL_ALIASES));
});

test("only the listed pinned snapshots merge with base models", () => {
  const snapshots = [
    ["claude-opus-4-20250514", "claude-opus-4"],
    ["claude-sonnet-4-20250514", "claude-sonnet-4"],
    ["claude-opus-4-1-20250805", "claude-opus-4-1"],
    ["claude-opus-4-5-20251101", "claude-opus-4-5"],
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["claude-3-5-haiku-20241022", "claude-3-5-haiku"],
  ];
  assert.deepEqual(Object.entries(CLAUDE_MODEL_SNAPSHOTS), snapshots);
  assert.ok(Object.isFrozen(CLAUDE_MODEL_SNAPSHOTS));
  for (const [snapshot, expected] of snapshots) {
    for (const raw of [snapshot, `anthropic/${snapshot.toUpperCase()}`, `gateway/anthropic/${snapshot}`]) {
      assert.equal(resolveModelIdentity(raw).modelKey, expected, raw);
    }
  }
});

test("unknown IDs, formal versions, dates and free suffixes remain separate identities", () => {
  const models = [
    "mimo-v2.6-flash",
    "mimo-v2.6-flash-202609",
    "mimo-v2.6-flash-202610",
    "mimo-v2.6-flash-free",
    "claude-sonnet-4-5-20250930",
    "claude-sonnet-4-5-20250929-free",
    "claude-sonnet-4-9",
    "claude-sonnet-4-9-20270101",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-5.6-free",
    "gpt-daybreak-blue-latest-free",
    "deepseek-v4.1-flash-free",
    "mystery",
    "mystery-free",
    "hy4free",
    "hy4free-other",
    "constructor",
    "toString",
    "__proto__",
  ];
  const keys = models.map((model) => {
    const result = resolveModelIdentity(`vendor/${model}`);
    assert.equal(result.modelKey, model.toLowerCase(), model);
    assert.equal(result.displayName, model.toLowerCase(), model);
    return result.modelKey;
  });
  assert.equal(new Set(keys).size, models.length);
});

test("catalog casing changes display only; lowercase persistent identities stay compatible", () => {
  const catalogs = [{}, { "GPT-6.1-SOL": {}, "Mystery-Model": {} }, { "gpt-6.1-sol": {}, "mystery-model": {} }];
  for (const raw of ["vendor/GpT-6.1-SoL", "vendor/MYSTERY-MODEL", "vendor/mimo-v2.6-flash-202609"]) {
    const expected = raw.slice(raw.lastIndexOf("/") + 1).toLowerCase();
    for (const catalog of catalogs) {
      assert.equal(legacyModelName(raw, catalog).toLowerCase(), expected);
      assert.equal(resolveModelIdentity(raw).modelKey, expected);
      assert.equal(canonicalModelName(raw), expected);
    }
  }
  assert.equal(legacyModelName("vendor/GpT-6.1-SoL", catalogs[0]), "GpT-6.1-SoL");
  assert.equal(legacyModelName("vendor/GpT-6.1-SoL", catalogs[1]), "GPT-6.1-SOL");
  assert.equal(canonicalModelName("vendor/GpT-6.1-SoL"), "gpt-6.1-sol");
});

test("achievement model IDs retain provider, harness, session and repository identity", () => {
  const identity = createAchievementIdentity({
    pricingModels: { "GPT-5.6-SOL": {}, "CLAUDE-SONNET-4-5": {}, "deepseek-flash": {} },
    repositoryAliases: { "git:/worktree": "common:/main/.git" },
  });
  const base = {
    homeId: "home-a",
    sessionId: "same",
    sourceKind: "main",
    channel: "gateway",
    repositoryKey: "git:/worktree",
    repositoryKind: "git",
  };
  for (const [rawModel, modelId, providerId] of [
    ["gateway/gpt-daybreak-blue-latest", "gpt-5.6-sol", "openai"],
    ["workbuddy-ai/deepseek-v4.1-flash-sg", "deepseek-flash", "deepseek"],
    ["group/deepseek", "deepseek-flash", "deepseek"],
    ["anthropic/claude-sonnet-4-5-20250929", "claude-sonnet-4-5", "anthropic"],
    ["gateway/hy4free", "hy4free", "tencent"],
    ["gateway/codex-auto-review", "codex-auto-review", "openai"],
    ["vendor/mystery-20261117-free", "mystery-20261117-free", null],
    ["unknown model", null, null],
    ["unknown", null, null],
    ["", null, null],
  ]) {
    const observed = identity({ ...base, rawModel });
    const resolved = resolveModelIdentity(rawModel);
    assert.deepEqual(observed, {
      modelId,
      providerId,
      harnessId: "Codex",
      sessionKey: '["home-a","same"]',
      repositoryKey: "common:/main/.git",
    });
    assert.equal(resolved.modelKey, modelId ?? rawModel);
    assert.deepEqual(identity({ ...base, rawModel: resolved.displayName }), observed);
  }
});

test("free evidence keeps its raw route, exact suffix and immutable evidence key", () => {
  const policy = {
    evidenceKey: "fixture-free-route",
    version: "1",
    validFrom: "2026-11-01T00:00:00Z",
    validUntil: "2026-11-10T00:00:00Z",
    sourceKind: "opencode",
    model: "Gateway/Mystery-20261105-Free",
    route: "Gateway",
    freeClass: "free",
    type: "explicit-free-identity",
  };
  assert.equal(validateAchievementFreePolicy(policy).model, "mystery-20261105-free");
  const classify = createAchievementFreeClassifier({ policies: [policy] });
  const event = {
    rawModel: policy.model,
    occurredAt: "2026-11-05T00:00:00Z",
    sourceKind: "opencode",
  };
  const resolved = resolveModelIdentity(event.rawModel);
  const evidence = { freeClass: "free", freeEvidenceKey: '["[\\"fixture-free-route\\",\\"1\\"]"]' };
  assert.deepEqual(classify({ ...event, rawModel: resolved.rawModel }), evidence);
  assert.deepEqual(classify({ ...event, rawModel: resolved.displayName, route: policy.route }), evidence);
  for (const rawModel of [resolved.displayName, "gateway/Mystery-20261105-Free", "Gateway/Mystery-20261106-Free"]) {
    assert.deepEqual(classify({ ...event, rawModel }), { freeClass: "unknown", freeEvidenceKey: null });
  }
  assert.deepEqual(createAchievementFreeClassifier()(event), { freeClass: "unknown", freeEvidenceKey: null });
});

test("auto-review identity stays exact and separate from achievement free classification", () => {
  assert.equal(CODEX_AUTO_REVIEW_MODEL, "codex-auto-review");
  assert.equal(isCodexAutoReview(" CODEX-AUTO-REVIEW "), true);
  for (const raw of ["gateway/codex-auto-review", "codex-auto-review-free", "codex-auto-review-other", null]) {
    assert.equal(isCodexAutoReview(raw), false);
  }
  const result = resolveModelIdentity("gateway/CODEX-AUTO-REVIEW");
  assert.equal(result.modelKey, CODEX_AUTO_REVIEW_MODEL);
  assert.deepEqual(createAchievementFreeClassifier()({ rawModel: result.rawModel }), {
    freeClass: "review",
    freeEvidenceKey: "achievement-review-1",
  });
});

test("pure identity module loads alone without a catalog, provider directory or runtime", async () => {
  const source = await readFile(new URL("../public/model-identity.js", import.meta.url), "utf8");
  const standalone = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.deepEqual(standalone.resolveModelIdentity("gateway/GPT-DAYBREAK-BLUE-LATEST"), {
    rawModel: "gateway/GPT-DAYBREAK-BLUE-LATEST",
    modelKey: "gpt-5.6-sol",
    displayName: "gpt-5.6-sol",
  });
  assert.equal(standalone.canonicalModelName("vendor/unknown-20261117-free"), "unknown-20261117-free");
});
