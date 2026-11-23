function add(totals, key, tokens) {
  if (key) totals.set(key, (totals.get(key) || 0n) + tokens);
}

function addCombination(groups, outer, inner, tokens) {
  if (!outer || !inner) return;
  if (!groups.has(outer)) groups.set(outer, new Map());
  add(groups.get(outer), inner, tokens);
}

function qualifiedCount(totals, minimum) {
  let count = 0n;
  for (const tokens of totals.values()) if (tokens >= minimum) count++;
  return count;
}

function maximum(values) {
  let result = 0n;
  for (const value of values) if (value > result) result = value;
  return result;
}

function maximumQualified(groups, minimum) {
  return maximum(Array.from(groups.values(), (totals) => qualifiedCount(totals, minimum)));
}

/** Consumes validated, deduplicated usage facts with canonical identities. */
export function evaluateCumulativeAchievements({ facts }) {
  let total = 0n;
  let free = 0n;
  let positiveRecords = 0n;
  const models = new Map();
  const providers = new Map();
  const harnesses = new Map();
  const sessions = new Map();
  const repositories = new Map();
  const modelHarnesses = new Map();
  const repositoryModels = new Map();
  const sessionModels = new Map();

  for (const fact of facts) {
    const tokens = BigInt(fact.totalTokens);
    if (tokens === 0n) continue;
    total += tokens;
    positiveRecords++;
    if (fact.freeClass === "free") free += tokens;
    add(models, fact.modelId, tokens);
    add(providers, fact.providerId, tokens);
    add(harnesses, fact.harnessId, tokens);
    add(sessions, fact.sessionKey, tokens);
    add(repositories, fact.repositoryKey, tokens);
    addCombination(modelHarnesses, fact.modelId, fact.harnessId, tokens);
    addCombination(repositoryModels, fact.repositoryKey, fact.modelId, tokens);
    addCombination(sessionModels, fact.sessionKey, fact.modelId, tokens);
  }

  return {
    A01: total,
    A06: free,
    A07: qualifiedCount(models, 100_000_000n),
    A08: qualifiedCount(providers, 1_000_000_000n),
    A09: qualifiedCount(harnesses, 1_000_000_000n),
    A10: qualifiedCount(models, 1_000_000_000n),
    A11: maximumQualified(modelHarnesses, 1_000_000_000n),
    A12: maximumQualified(repositoryModels, 1_000_000_000n),
    A23: maximum(sessions.values()),
    A24: qualifiedCount(repositories, 1_000_000_000n),
    A31: positiveRecords,
    A32: total,
    A33: maximumQualified(sessionModels, 100_000_000n),
    A53: maximum(models.values()),
    A54: maximum(harnesses.values()),
    A55: maximum(repositories.values()),
    A69: total,
    A70: total,
    A71: total,
  };
}
