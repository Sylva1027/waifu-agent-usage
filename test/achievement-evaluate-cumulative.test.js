import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateCumulativeAchievements } from "../src/achievement-evaluate-cumulative.js";
import { createAchievementIdentity } from "../src/achievement-identity.js";

const oracle = JSON.parse(readFileSync(new URL("./fixtures/achievements/rule-cases.json", import.meta.url), "utf8"));
const IDS = [
  "A01",
  "A06",
  "A07",
  "A08",
  "A09",
  "A10",
  "A11",
  "A12",
  "A23",
  "A24",
  "A31",
  "A32",
  "A33",
  "A53",
  "A54",
  "A55",
  "A69",
  "A70",
  "A71",
];
const T0 = Date.parse(oracle.t0);
let sequence = 0;

function fact(tokens, overrides = {}) {
  return {
    factKey: `fact-${sequence++}`,
    revision: "revision-1",
    totalTokens: String(tokens),
    occurredAt: T0 + 1000,
    precision: "instant",
    coverage: { start: T0 + 1000, end: T0 + 1000 },
    modelId: "model-0",
    providerId: "provider-0",
    harnessId: "harness-0",
    sessionKey: '["home-0","session-0"]',
    repositoryKey: "common:/repository-0/.git",
    freeClass: "paid",
    freeEvidenceKey: null,
    ...overrides,
  };
}

function context(facts) {
  return { facts, operations: [], enabledAt: T0, cutoff: T0 + 86_400_000, timeZone: oracle.timeZone };
}

function split(tokens, overrides = {}) {
  return [fact(tokens / 2n, overrides), fact(tokens - tokens / 2n, overrides)];
}

function boundaryFacts(id, n) {
  if (id === "A31") return Array.from({ length: Number(n) }, () => fact(1n));
  if (["A07", "A08", "A09", "A10", "A11", "A12", "A24", "A33"].includes(id)) {
    return Array.from({ length: Number(n) }, (_, i) => {
      const identity = {};
      if (["A07", "A10", "A12", "A33"].includes(id)) identity.modelId = `model-${i}`;
      if (id === "A08") identity.providerId = `provider-${i}`;
      if (["A09", "A11"].includes(id)) identity.harnessId = `harness-${i}`;
      if (id === "A24") identity.repositoryKey = `common:/repository-${i}/.git`;
      return split(["A07", "A33"].includes(id) ? 100_000_000n : 1_000_000_000n, identity);
    }).flat();
  }
  return split(n, id === "A06" ? { freeClass: "free", freeEvidenceKey: "usage-time-policy-v1" } : {});
}

for (const row of oracle.rows.filter(({ id }) => IDS.includes(id))) {
  for (const boundary of row.boundaryCases) {
    test(`S08-C ${boundary.caseId}`, () => {
      const result = evaluateCumulativeAchievements(context(boundaryFacts(row.id, BigInt(boundary.requestedMetric))));
      assert.equal(result[row.id], BigInt(boundary.effectiveMetric), "observedValue");
      assert.equal(result[row.id] >= BigInt(boundary.target), boundary.expected.reachesTarget, "reachesTarget");
    });
  }
}

test("cumulative returns exactly its 19 BigInt metrics, including zero for empty input", () => {
  assert.equal(oracle.rows.filter(({ id }) => IDS.includes(id)).flatMap((row) => row.boundaryCases).length, 135);
  assert.deepEqual(evaluateCumulativeAchievements(context([])), Object.fromEntries(IDS.map((id) => [id, 0n])));
  assert.deepEqual(evaluateCumulativeAchievements(context([fact(0n)])), evaluateCumulativeAchievements(context([])));
});

test("each identity must independently reach its minimum, even after split aggregation", () => {
  const identities = [
    ["modelId", "A07", 100_000_000n],
    ["modelId", "A10", 1_000_000_000n],
    ["providerId", "A08", 1_000_000_000n],
    ["harnessId", "A09", 1_000_000_000n],
    ["repositoryKey", "A24", 1_000_000_000n],
  ];
  for (const [field, id, minimum] of identities) {
    const facts = [
      ...split(minimum - 1n, { [field]: "identity-a" }),
      ...split(minimum - 1n, { [field]: "identity-b" }),
    ];
    assert.equal(evaluateCumulativeAchievements(context(facts))[id], 0n, id);
    facts.push(fact(1n, { [field]: "identity-a" }));
    assert.equal(evaluateCumulativeAchievements(context(facts))[id], 1n, id);
  }
});

test("combination minima and maxima cannot be assembled across different outer identities", () => {
  for (const [id, outer, inner, minimum] of [
    ["A11", "modelId", "harnessId", 1_000_000_000n],
    ["A12", "repositoryKey", "modelId", 1_000_000_000n],
    ["A33", "sessionKey", "modelId", 100_000_000n],
  ]) {
    const facts = [
      ...split(minimum, { [outer]: "outer-a", [inner]: "inner-a" }),
      ...split(minimum, { [outer]: "outer-b", [inner]: "inner-b" }),
      ...split(minimum - 1n, { [outer]: "outer-a", [inner]: "inner-b" }),
    ];
    assert.equal(evaluateCumulativeAchievements(context(facts))[id], 1n, id);
    facts.push(fact(1n, { [outer]: "outer-a", [inner]: "inner-b" }));
    assert.equal(evaluateCumulativeAchievements(context(facts))[id], 2n, id);
  }
});

test("unknown identities contribute total tokens without inventing diversity or maxima", () => {
  const unknown = fact(10_000_000_000n, {
    modelId: null,
    providerId: null,
    harnessId: null,
    sessionKey: null,
    repositoryKey: null,
    freeClass: "unknown",
  });
  const result = evaluateCumulativeAchievements(context([unknown]));
  assert.deepEqual(result, {
    A01: 10_000_000_000n,
    A06: 0n,
    A07: 0n,
    A08: 0n,
    A09: 0n,
    A10: 0n,
    A11: 0n,
    A12: 0n,
    A23: 0n,
    A24: 0n,
    A31: 1n,
    A32: 10_000_000_000n,
    A33: 0n,
    A53: 0n,
    A54: 0n,
    A55: 0n,
    A69: 10_000_000_000n,
    A70: 10_000_000_000n,
    A71: 10_000_000_000n,
  });
});

test("unknown components do not qualify combinations but preserve known dimensions", () => {
  const result = evaluateCumulativeAchievements(
    context([
      fact(1_000_000_000n, { modelId: null }),
      fact(1_000_000_000n, { harnessId: null, repositoryKey: null, sessionKey: null }),
    ]),
  );
  for (const id of ["A07", "A08", "A09", "A10", "A24"]) assert.equal(result[id], 1n, id);
  for (const id of ["A11", "A12", "A33"]) assert.equal(result[id], 0n, id);
});

test("free evidence is historical classification; review, unknown and zero-cost paid usage stay excluded", () => {
  const facts = [
    fact(10_000_000_000n, { freeClass: "free", freeEvidenceKey: "historical-policy" }),
    fact(10_000_000_000n, { freeClass: "review", modelId: "codex-auto-review" }),
    fact(10_000_000_000n, { freeClass: "unknown", cost: 0 }),
    fact(10_000_000_000n, { freeClass: "paid", cost: 0 }),
  ];
  const result = evaluateCumulativeAchievements(context(facts));
  assert.equal(result.A01, 40_000_000_000n);
  assert.equal(result.A06, 10_000_000_000n);
  assert.equal(result.A31, 4n);
  assert.deepEqual(
    evaluateCumulativeAchievements({ ...context(facts), pricingModels: { "model-0": { cost: 999 } } }),
    result,
  );
});

test("canonical home/session keys isolate same-named sessions", () => {
  const identity = createAchievementIdentity();
  const records = ["home-a", "home-b"].map((homeId, i) =>
    fact(100_000_000n, {
      ...identity({ homeId, sessionId: "same-session", model: i ? "gpt-6.1-sol" : "gpt-6-sol", sourceKind: "main" }),
    }),
  );
  const isolated = evaluateCumulativeAchievements(context(records));
  assert.equal(isolated.A23, 100_000_000n);
  assert.equal(isolated.A33, 1n);
  const together = evaluateCumulativeAchievements(
    context([records[0], { ...records[1], sessionKey: records[0].sessionKey }]),
  );
  assert.equal(together.A23, 200_000_000n);
  assert.equal(together.A33, 2n);
});

test("already normalized worktrees, aliases and harness directories aggregate without merging versions or clones", () => {
  const identity = createAchievementIdentity({
    repositoryAliases: { "git:/main": "common:/one", "git:/worktree": "common:/one" },
  });
  const records = [
    ["gpt-5.6-sol", "git:/main", "home-a"],
    ["gpt-daybreak-blue-latest", "git:/worktree", "home-b"],
    ["gpt-6.1-sol", "git:/clone", "home-c"],
  ].map(([model, repositoryKey, homeId]) =>
    fact(500_000_000n, {
      ...identity({ model, repositoryKey, repositoryKind: "git", homeId, sessionId: "same", sourceKind: "main" }),
    }),
  );
  const result = evaluateCumulativeAchievements(context(records));
  assert.equal(result.A07, 2n);
  assert.equal(result.A10, 1n);
  assert.equal(result.A09, 1n);
  assert.equal(result.A24, 1n);
  assert.equal(result.A53, 1_000_000_000n);
  assert.equal(result.A54, 1_500_000_000n);
  assert.equal(result.A55, 1_000_000_000n);
});

test("BigInt aggregation keeps above-safe-integer tokens and combination increments exact", () => {
  const large = 9_007_199_254_740_993n;
  const result = evaluateCumulativeAchievements(
    context([
      fact(large, { freeClass: "free", freeEvidenceKey: "policy" }),
      fact(2n, { freeClass: "free", freeEvidenceKey: "policy" }),
    ]),
  );
  for (const id of ["A01", "A06", "A23", "A32", "A53", "A54", "A55", "A69", "A70", "A71"])
    assert.equal(result[id], large + 2n, id);
  for (const id of ["A07", "A08", "A09", "A10", "A11", "A12", "A24", "A33"]) assert.equal(result[id], 1n, id);
});

test("legitimate identical payloads with distinct fact keys remain additive, with no cache/reasoning recount", () => {
  const records = [
    fact(100n, { cachedTokens: "60", reasoningTokens: "5" }),
    fact(100n, { cachedTokens: "60", reasoningTokens: "5" }),
  ];
  assert.notEqual(records[0].factKey, records[1].factKey);
  const before = structuredClone(records);
  const result = evaluateCumulativeAchievements(context(records));
  assert.equal(result.A01, 200n);
  assert.equal(result.A23, 200n);
  assert.equal(result.A31, 2n);
  assert.deepEqual(evaluateCumulativeAchievements(context(records.toReversed())), result);
  assert.deepEqual(records, before);
});

test("post-T0 interval facts remain eligible for cumulative metrics across calendar boundaries", () => {
  const result = evaluateCumulativeAchievements(
    context([
      fact(1_000_000_000n, {
        precision: "interval",
        coverage: { start: T0, end: T0 + 86_400_000 - 1 },
        occurredAt: T0 + 86_400_000 - 1,
      }),
    ]),
  );
  assert.equal(result.A01, 1_000_000_000n);
  assert.equal(result.A53, 1_000_000_000n);
  assert.equal(result.A10, 1n);
});
