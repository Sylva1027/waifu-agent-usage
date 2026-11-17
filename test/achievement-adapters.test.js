import assert from "node:assert/strict";
import test from "node:test";

import { ACHIEVEMENT_IDENTITY_VERSION, createAchievementIdentity } from "../src/achievement-identity.js";
import {
  achievementCalendarKeys,
  achievementPeriodBounds,
  closedAchievementPeriods,
  validateAchievementTimeZone,
} from "../src/achievement-calendar.js";
import {
  createAchievementFreeClassifier,
  validateAchievementFreePolicies,
  validateAchievementFreePolicy,
} from "../src/achievement-free-policy.js";

test("achievement identities reuse real aliases, pinned snapshots and distinct formal versions", () => {
  const identity = createAchievementIdentity({
    pricingModels: {
      "gpt-5.6-sol": {},
      "claude-sonnet-4-5": {},
      "claude-opus-4-5": {},
      "mimo-v2.6-flash": {},
    },
  });
  const base = { homeId: "home-a", sessionId: "same", sourceKind: "main", channel: "gateway" };
  assert.ok(ACHIEVEMENT_IDENTITY_VERSION);
  assert.deepEqual(identity({ ...base, model: "openrouter/gpt-daybreak-blue-latest" }), {
    modelId: "gpt-5.6-sol",
    providerId: "openai",
    harnessId: "Codex",
    sessionKey: '["home-a","same"]',
    repositoryKey: null,
  });
  for (const model of ["gpt-5.6", "gpt-daybreak-blue-latest", "gpt-5.6-sol"]) {
    assert.equal(identity({ ...base, model }).modelId, "gpt-5.6-sol");
  }
  for (const model of ["deepseek-v4.1-flash", "deepseek-v4.1-flash-sg", "group/deepseek"]) {
    assert.equal(identity({ ...base, model }).modelId, "deepseek-flash");
  }
  assert.equal(identity({ ...base, model: "anthropic/claude-sonnet-4-5-20250929" }).modelId, "claude-sonnet-4-5");
  assert.equal(identity({ ...base, model: "claude-opus-4-5-20251101" }).modelId, "claude-opus-4-5");
  assert.equal(identity({ ...base, model: "claude-sonnet-4-9" }).modelId, "claude-sonnet-4-9");
  assert.equal(identity({ ...base, model: "mimo-v2.6-flash-202609" }).modelId, "mimo-v2.6-flash-202609");
  assert.notEqual(
    identity({ ...base, model: "gpt-6-sol" }).modelId,
    identity({ ...base, model: "gpt-6.1-sol" }).modelId,
  );
  assert.equal(
    identity({ ...base, rawModel: "gateway/claude-sonnet-4-5", model: "unknown model" }).providerId,
    "anthropic",
  );
  assert.equal(identity({ ...base, raw: "gateway/hy4free" }).providerId, "tencent");
  assert.equal(identity({ ...base, model: "codex-auto-review" }).modelId, "codex-auto-review");
});

test("achievement identities isolate homes, reuse harness kinds, and ignore unknown diversity", () => {
  const identity = createAchievementIdentity();
  const base = { model: "Unknown model", homeId: "a", sessionId: "same", sourceKind: "main" };
  assert.deepEqual(identity(base), {
    modelId: null,
    providerId: null,
    harnessId: "Codex",
    sessionKey: '["a","same"]',
    repositoryKey: null,
  });
  assert.notEqual(identity(base).sessionKey, identity({ ...base, homeId: "b" }).sessionKey);
  assert.equal(identity(base).harnessId, identity({ ...base, homeId: "b", sourceKind: "extra" }).harnessId);
  assert.equal(identity({ sourceKind: "opencode", model: "router/mystery-model" }).providerId, null);
  assert.equal(identity({ channel: "Codex Desktop" }).harnessId, "Codex");
  assert.equal(identity({ channel: "unrecognized" }).harnessId, null);
  for (const model of ["", null, undefined, " UNKNOWN MODEL "]) assert.equal(identity({ model }).modelId, null);
});

test("achievement repository mappings merge only proven worktrees and preserve independent clones", () => {
  const identity = createAchievementIdentity({
    repositoryAliases: { "git:/main": "common:/one/.git", "git:/worktree": "common:/one/.git" },
  });
  const repository = (repositoryKey, repositoryKind = "git") =>
    identity({ repositoryKey, repositoryKind }).repositoryKey;
  assert.equal(repository("git:/main"), "common:/one/.git");
  assert.equal(repository("git:/worktree"), repository("git:/main"));
  assert.equal(repository("git:/clone"), "git:/clone");
  assert.equal(repository("directory:/old", "directory"), "directory:/old");
  assert.equal(repository("unknown:cwd"), null);
  assert.equal(repository("git:/main", "unknown"), null);
  assert.equal(repository(""), null);
  assert.equal(repository("toString"), "toString");
});

test("achievement calendar validates fixed zones and absolute timestamps without system TZ changes", () => {
  const systemZone = process.env.TZ;
  assert.equal(validateAchievementTimeZone("UTC"), "UTC");
  assert.equal(validateAchievementTimeZone("Asia/Shanghai"), "Asia/Shanghai");
  for (const zone of ["local", "LOCAL", "", null, undefined, "Invalid/Zone", "+08:00"]) {
    assert.throws(() => validateAchievementTimeZone(zone), RangeError);
  }
  for (const time of [null, undefined, NaN, Infinity, "bad", "2026-11-17T00:00:00", 0.5]) {
    assert.throws(() => achievementCalendarKeys(time, "UTC"), RangeError);
  }
  assert.throws(() => achievementPeriodBounds(0, "UTC", "year"), RangeError);
  assert.equal(process.env.TZ, systemZone);
});

test("achievement calendar keys cover Monday weeks, years, leap dates and timezone date shifts", () => {
  const cases = [
    ["2026-11-16T00:00:00Z", "UTC", "2026-11-16", "2026-11-16", "2026-11"],
    ["2026-11-15T23:59:59.999Z", "UTC", "2026-11-15", "2026-11-09", "2026-11"],
    ["2026-01-01T12:00:00Z", "UTC", "2026-01-01", "2025-12-29", "2026-01"],
    ["2024-02-29T23:59:59Z", "UTC", "2024-02-29", "2024-02-26", "2024-02"],
    ["2026-12-31T16:00:00Z", "Asia/Shanghai", "2027-01-01", "2026-12-28", "2027-01"],
    ["2026-01-01T00:00:00Z", "America/Los_Angeles", "2025-12-31", "2025-12-29", "2025-12"],
    ["1969-12-28T12:00:00Z", "UTC", "1969-12-28", "1969-12-22", "1969-12"],
  ];
  for (const [time, zone, day, week, month] of cases) {
    assert.deepEqual(achievementCalendarKeys(time, zone), {
      day,
      week,
      month,
      ordinal: Date.parse(`${day}T00:00:00Z`) / 86_400_000,
    });
  }
  assert.deepEqual(achievementCalendarKeys(new Date(0), "UTC"), achievementCalendarKeys(0, "UTC"));
  const before = achievementCalendarKeys("2026-03-08T05:00:00Z", "America/New_York");
  const after = achievementCalendarKeys("2026-03-09T04:00:00Z", "America/New_York");
  assert.equal(after.ordinal - before.ordinal, 1);
});

test("achievement day/week/month bounds are half-open across DST and calendar rollover", () => {
  const cases = [
    ["2026-03-08T12:00:00Z", "America/New_York", "day", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["2026-11-01T12:00:00Z", "America/New_York", "day", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
    ["2026-03-08T12:00:00Z", "America/New_York", "week", "2026-03-02T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["2026-03-08T12:00:00Z", "America/New_York", "month", "2026-03-01T05:00:00Z", "2026-04-01T04:00:00Z"],
    ["2026-10-15T12:00:00Z", "Europe/Berlin", "month", "2026-09-30T22:00:00Z", "2026-10-31T23:00:00Z"],
    ["2026-10-04T04:00:00Z", "Australia/Lord_Howe", "day", "2026-10-03T13:30:00Z", "2026-10-04T13:00:00Z"],
    ["2018-11-04T12:00:00Z", "America/Sao_Paulo", "day", "2018-11-04T03:00:00Z", "2018-11-05T02:00:00Z"],
    ["2024-02-29T12:00:00Z", "UTC", "month", "2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z"],
    ["2026-12-31T12:00:00Z", "UTC", "month", "2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z"],
    ["2026-01-01T12:00:00Z", "UTC", "week", "2025-12-29T00:00:00Z", "2026-01-05T00:00:00Z"],
    ["2026-12-31T16:00:00Z", "Asia/Shanghai", "day", "2026-12-31T16:00:00Z", "2027-01-01T16:00:00Z"],
  ];
  for (const [time, zone, period, start, end] of cases) {
    const expected = { start: Date.parse(start), end: Date.parse(end) };
    assert.deepEqual(achievementPeriodBounds(time, zone, period), expected, `${zone} ${period} ${time}`);
    assert.deepEqual(achievementPeriodBounds(expected.start, zone, period), expected);
    assert.deepEqual(achievementPeriodBounds(expected.end - 1, zone, period), expected);
    assert.equal(achievementPeriodBounds(expected.end, zone, period).start, expected.end);
  }
});

test("closed achievement keys advance exactly at ended boundaries and stay stable inside periods", () => {
  const cutoff = "2026-11-16T16:00:00Z";
  assert.deepEqual(closedAchievementPeriods(cutoff, "Asia/Shanghai"), {
    day: "2026-11-16",
    week: "2026-11-09",
    month: "2026-10",
  });
  assert.deepEqual(
    closedAchievementPeriods("2026-11-17T15:59:59.999Z", "Asia/Shanghai"),
    closedAchievementPeriods(cutoff, "Asia/Shanghai"),
  );
  assert.deepEqual(closedAchievementPeriods("2026-01-01T00:00:00Z", "UTC"), {
    day: "2025-12-31",
    week: "2025-12-22",
    month: "2025-12",
  });
  assert.equal(closedAchievementPeriods("2026-03-09T03:59:59.999Z", "America/New_York").day, "2026-03-07");
  assert.equal(closedAchievementPeriods("2026-03-09T04:00:00Z", "America/New_York").day, "2026-03-08");
  assert.equal(closedAchievementPeriods("2026-03-09T04:00:00Z", "America/New_York").week, "2026-03-02");
  assert.equal(closedAchievementPeriods("2011-12-30T10:00:00Z", "Pacific/Apia").day, "2011-12-29");
});

function policy(overrides = {}) {
  return {
    evidenceKey: "fixture-only-not-vendor-history",
    version: "1",
    validFrom: "2026-11-01T00:00:00Z",
    validUntil: "2026-11-10T00:00:00Z",
    sourceKind: "opencode",
    model: "hy4free",
    route: "gateway",
    freeClass: "free",
    type: "explicit-free-identity",
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    occurredAt: "2026-11-05T00:00:00Z",
    sourceKind: "opencode",
    rawModel: "gateway/hy4free",
    model: "hy4free",
    ...overrides,
  };
}

test("interval free classification needs complete consistent coverage, including partial conflicts", () => {
  const interval = event({
    occurredAt: "2026-11-05T00:00:00Z",
    precision: "interval",
    coverage: { start: Date.parse("2026-11-02T00:00:00Z"), end: Date.parse("2026-11-05T00:00:00Z") },
  });
  assert.equal(createAchievementFreeClassifier({ policies: [policy()] })(interval).freeClass, "free");
  const conflict = policy({
    evidenceKey: "paid-patch",
    type: "policy",
    freeClass: "paid",
    validFrom: "2026-11-03T00:00:00Z",
    validUntil: "2026-11-04T00:00:00Z",
  });
  assert.equal(createAchievementFreeClassifier({ policies: [policy(), conflict] })(interval).freeClass, "unknown");
  const first = policy({ evidenceKey: "first", validUntil: "2026-11-04T00:00:00Z" });
  const second = policy({ evidenceKey: "second", validFrom: "2026-11-04T00:00:00Z" });
  assert.equal(createAchievementFreeClassifier({ policies: [first, second] })(interval).freeClass, "free");
  assert.equal(
    createAchievementFreeClassifier({ policies: [first, policy({ ...second, validFrom: "2026-11-04T12:00:00Z" })] })(
      interval,
    ).freeClass,
    "unknown",
  );
});

test("unknown models and missing session identities cannot create diversity or a shared fake session", () => {
  const identity = createAchievementIdentity();
  assert.equal(identity({ model: "unknown", sourceKind: "codex" }).modelId, null);
  assert.equal(identity({ model: "gpt-6-sol", homeId: "home", sessionId: "" }).sessionKey, null);
});

test("achievement free policies use occurrence-time finite intervals and exact source/model/raw-route scopes", () => {
  const classify = createAchievementFreeClassifier({ policies: [policy()] });
  const free = classify(event());
  assert.equal(free.freeClass, "free");
  assert.ok(free.freeEvidenceKey.includes("fixture-only-not-vendor-history"));
  assert.deepEqual(classify(event({ occurredAt: "2026-11-01T00:00:00Z" })), free);
  assert.deepEqual(classify(event({ occurredAt: Date.parse("2026-11-10T00:00:00Z") - 1 })), free);
  for (const overrides of [
    { occurredAt: "2026-10-31T23:59:59.999Z" },
    { occurredAt: "2026-11-10T00:00:00Z" },
    { occurredAt: null },
    { occurredAt: "2026-11-05T00:00:00" },
    { sourceKind: "main" },
    { rawModel: "other/hy4free" },
    { rawModel: "hy4free" },
    { rawModel: "gateway/other-free" },
    { route: "other" },
  ])
    assert.deepEqual(classify(event(overrides)), { freeClass: "unknown", freeEvidenceKey: null });
  assert.deepEqual(classify(event({ rawModel: undefined, model: "hy4free", route: "gateway" })), free);
  assert.deepEqual(classify(event({ rawModel: undefined, raw: "gateway/hy4free" })), free);
});

test("zero cost, missing rates, subscription and current price versions never create free evidence", () => {
  const classify = createAchievementFreeClassifier();
  for (const model of ["hy4free", "mimo-v2.6-flash-free", "unknown model", "gpt-6-sol"]) {
    assert.deepEqual(
      classify({
        model,
        occurredAt: "2026-11-05T00:00:00Z",
        priceVersion: "free-today",
        totalUsd: 0,
        quotaSource: "plan",
        subscription: true,
      }),
      { freeClass: "unknown", freeEvidenceKey: null },
    );
  }
});

test("review precedes policies and does not count as free even without a timestamp", () => {
  const classify = createAchievementFreeClassifier({
    policies: [
      policy({
        type: "policy",
        model: "codex-auto-review",
        freeClass: "free",
      }),
    ],
  });
  assert.deepEqual(classify(event({ rawModel: "gateway/CODEX-AUTO-REVIEW" })), {
    freeClass: "review",
    freeEvidenceKey: "achievement-review-1",
  });
  assert.equal(classify({ model: "codex-auto-review" }).freeClass, "review");
});

test("policy versions remain immutable and later paid intervals/pricing changes preserve earlier classification", () => {
  const original = policy();
  const policies = [original];
  const classify = createAchievementFreeClassifier({ policies });
  const before = classify(event());
  original.freeClass = "paid";
  original.validUntil = "2026-11-02T00:00:00Z";
  policies.length = 0;
  assert.deepEqual(classify(event({ priceVersion: "changed", totalUsd: 100 })), before);
  const repriced = createAchievementFreeClassifier({
    policies: [
      policy(),
      policy({
        version: "2",
        type: "policy",
        freeClass: "paid",
        validFrom: "2026-11-10T00:00:00Z",
        validUntil: "2026-12-01T00:00:00Z",
      }),
    ],
  });
  assert.deepEqual(repriced(event({ priceVersion: "new" })), before);
  assert.equal(repriced(event({ occurredAt: "2026-11-10T00:00:00Z" })).freeClass, "paid");
  assert.equal(repriced(event({ occurredAt: "2026-12-01T00:00:00Z" })).freeClass, "unknown");
  const dates = policy({ validFrom: new Date("2026-11-01Z"), validUntil: new Date("2026-11-10Z") });
  const validated = validateAchievementFreePolicy(dates);
  dates.validFrom.setUTCFullYear(2030);
  assert.equal(validated.validFrom, Date.parse("2026-11-01Z"));
  assert.ok(Object.isFrozen(validated));
});

test("overlapping conflicting policy evidence is unknown and agreeing evidence is deterministic", () => {
  const one = policy();
  const two = policy({ evidenceKey: "second-evidence" });
  const agreement = createAchievementFreeClassifier({ policies: [one, two] })(event());
  assert.equal(agreement.freeClass, "free");
  assert.deepEqual(createAchievementFreeClassifier({ policies: [two, one] })(event()), agreement);
  const conflicting = policy({ evidenceKey: "paid-evidence", type: "policy", freeClass: "paid" });
  for (const policies of [
    [one, conflicting],
    [conflicting, one],
  ]) {
    assert.deepEqual(createAchievementFreeClassifier({ policies })(event()), {
      freeClass: "unknown",
      freeEvidenceKey: null,
    });
  }
  assert.equal(validateAchievementFreePolicies([one, one]).length, 1);
  assert.ok(Object.isFrozen(validateAchievementFreePolicies([one])));
  assert.throws(
    () => validateAchievementFreePolicies([one, policy({ validUntil: "2026-11-11T00:00:00Z" })]),
    TypeError,
  );
});

test("free policy validation rejects missing scope, unbounded history, wildcards and invalid identities", () => {
  for (const overrides of [
    { evidenceKey: "" },
    { version: "" },
    { sourceKind: "" },
    { model: "" },
    { sourceKind: "*" },
    { model: "*-free" },
    { route: "*" },
    { route: undefined },
    { model: "other/hy4free" },
    { freeClass: "unknown" },
    { type: "zero-price" },
    { model: "gpt-6-sol" },
    { freeClass: "paid" },
  ])
    assert.throws(() => validateAchievementFreePolicy(policy(overrides)), TypeError);
  for (const overrides of [
    { validFrom: null },
    { validUntil: null },
    { validFrom: -Infinity },
    { validUntil: Infinity },
    { validFrom: "2026-11-10T00:00:00Z" },
    { validUntil: "2026-10-31T00:00:00Z" },
    { validFrom: "2026-11-01T00:00:00" },
  ])
    assert.throws(() => validateAchievementFreePolicy(policy(overrides)), RangeError);
  assert.throws(() => validateAchievementFreePolicies(null), TypeError);
  assert.throws(() => validateAchievementFreePolicy(null), TypeError);
  const suffix = createAchievementFreeClassifier({ policies: [policy({ model: "mimo-v2.6-flash-free" })] });
  assert.equal(suffix(event({ rawModel: "gateway/mimo-v2.6-flash-free" })).freeClass, "free");
  assert.equal(suffix(event({ rawModel: "gateway/mimo-v2.6-flash" })).freeClass, "unknown");
  const alias = createAchievementFreeClassifier({
    policies: [
      policy({
        model: "gpt-5.6-sol",
        type: "policy",
        freeClass: "paid",
      }),
    ],
  });
  assert.equal(alias(event({ rawModel: "gateway/gpt-daybreak-blue-latest" })).freeClass, "paid");
});
