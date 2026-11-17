import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateCalendarAchievements } from "../src/achievement-evaluate-calendar.js";

const oracle = JSON.parse(readFileSync(new URL("./fixtures/achievements/rule-cases.json", import.meta.url), "utf8"));
const IDS = [
  "A13",
  "A14",
  "A16",
  "A18",
  "A19",
  "A28",
  "A29",
  "A30",
  "A36",
  "A38",
  "A39",
  "A56",
  "A58",
  "A59",
  "A63",
  "A65",
];
const DAY = 86_400_000;
const M = 1_000_000n;
const START = Date.UTC(2027, 0, 1, 12);
let sequence = 0;

// Context fixtures use canonical identities, including an injected registry for the eighth Harness boundary.
function fact(time, total = 100n * M, overrides = {}) {
  const occurredAt = typeof time === "number" ? time : Date.parse(time);
  return {
    factKey: `calendar-fixture-${sequence++}`,
    revision: "1",
    occurredAt,
    precision: "instant",
    coverage: { start: occurredAt, end: occurredAt },
    totalTokens: String(total),
    modelId: "gpt-6-sol",
    providerId: "openai",
    harnessId: "Codex",
    repositoryKey: "common:/fixture/.git",
    sessionKey: "fixture-session",
    freeClass: "paid",
    freeEvidenceKey: null,
    ...overrides,
  };
}

function interval(start, end, total, overrides = {}) {
  const first = typeof start === "number" ? start : Date.parse(start);
  const last = typeof end === "number" ? end : Date.parse(end);
  return fact(last, total, { precision: "interval", coverage: { start: first, end: last }, ...overrides });
}

function context(facts, overrides = {}) {
  return {
    facts,
    operations: [],
    enabledAt: Date.parse(oracle.t0),
    cutoff: Date.parse(oracle.clock),
    timeZone: oracle.timeZone,
    ...overrides,
  };
}

function evaluate(facts, overrides = {}) {
  return evaluateCalendarAchievements(context(facts, overrides));
}

function boundaryFacts(id, value) {
  const n = Number(value);
  switch (id) {
    case "A13":
      return Array.from({ length: n }, (_, i) => fact(START + i * 2 * DAY, 10n * M));
    case "A14":
      return Array.from({ length: n }, (_, i) => fact(START + i * DAY, 10n * M));
    case "A18":
      return Array.from({ length: n }, (_, i) => fact(START + i * 2 * DAY));
    case "A30":
      return Array.from({ length: n }, (_, i) => fact(START + i * 2 * DAY));
    case "A56":
      return Array.from({ length: n }, (_, i) => fact(START + i * 2 * DAY, 1000n * M));
    case "A16":
    case "A65":
      return Array.from({ length: n }, (_, month) =>
        Array.from({ length: id === "A16" ? 10 : 20 }, (_, day) =>
          fact(Date.UTC(2027, month, day + 1, 12), id === "A16" ? 10n * M : 100n * M),
        ),
      ).flat();
    case "A19":
      return [fact(START, value / 2n), fact(START + 1000, value - value / 2n)];
    case "A28":
      return Array.from({ length: n }, (_, i) => fact(START, 100n * M, { modelId: `fixture-model-${i}` }));
    case "A29":
      return Array.from({ length: n }, (_, i) =>
        fact(Date.UTC(2027, 0, 4, 12), 1000n * M, { harnessId: `fixture-harness-${i}` }),
      );
    case "A63":
      return Array.from({ length: n }, (_, i) => fact(START, 100n * M, { harnessId: `fixture-harness-${i}` }));
    case "A36":
      return [fact(START, 1n), fact(START + (n + 1) * DAY)];
    case "A38":
      return Array.from({ length: n }, (_, i) => [
        fact(Date.UTC(2027 + i, 11, 31, 12), M),
        fact(Date.UTC(2028 + i, 0, 1, 12), M),
      ]).flat();
    case "A39":
      return Array.from({ length: n }, (_, i) => fact(Date.UTC(2028 + 4 * i, 1, 29, 12), M));
    case "A58":
      return [fact(START, value / 2n), fact(START + 14 * DAY, value - value / 2n)];
    case "A59":
      return [fact(Date.UTC(2027, 0, 4, 12), value / 2n), fact(Date.UTC(2027, 0, 10, 12), value - value / 2n)];
    default:
      throw new Error(`Missing independent construction for ${id}`);
  }
}

for (const row of oracle.rows.filter((row) => IDS.includes(row.id))) {
  for (const sample of row.boundaryCases) {
    test(`S08-C ${sample.caseId}`, () => {
      const input = context(boundaryFacts(row.id, BigInt(sample.requestedMetric)));
      const result = evaluateCalendarAchievements(input);
      assert.equal(result[row.id], BigInt(sample.effectiveMetric), "observedValue from real facts");
      assert.equal(result[row.id] >= BigInt(sample.target), sample.expected.reachesTarget);
      assert.deepEqual(evaluateCalendarAchievements(input), result, "pure replay is stable");
    });
  }
}

test("calendar group exports exactly 16 BigInt metrics and leaves normalized facts untouched", () => {
  const empty = evaluate([]);
  assert.deepEqual(Object.keys(empty), IDS);
  assert.ok(Object.values(empty).every((value) => value === 0n));
  const input = context([fact(START), fact(START + DAY)]);
  const saved = structuredClone(input);
  evaluateCalendarAchievements(input);
  assert.deepEqual(input, saved);
});

test("daily qualification counts distinct days, longest streak, and per-identity maxima", () => {
  const facts = Array.from({ length: 6 }, (_, i) => fact(START + i * DAY, 10n * M));
  facts.push(fact(START + 7 * DAY, 10n * M), fact(START + 6 * DAY, 10n * M - 1n));
  assert.equal(evaluate(facts).A13, 7n);
  assert.equal(evaluate(facts).A14, 6n);
  facts.push(fact(START + 6 * DAY, 1n));
  assert.equal(evaluate(facts).A14, 8n);
  const separated = [
    fact(START),
    fact(START + 1000, 1n),
    fact(START + DAY),
    fact(START + 2 * DAY, 100n * M, { repositoryKey: "other", modelId: "other" }),
    fact(START + 3 * DAY, 100n * M - 1n),
  ];
  assert.equal(evaluate(separated).A18, 2n);
  assert.equal(evaluate(separated).A30, 2n);
  separated.push(fact(START + 3 * DAY, 1n));
  assert.equal(evaluate(separated).A18, 3n);
  assert.equal(evaluate(separated).A30, 3n);
});

test("model and Harness diversity require each identity's local-day minimum", () => {
  const facts = [
    fact(START, 100n * M - 1n),
    fact(START + DAY, 1n),
    fact(START, 100n * M, { modelId: "other", harnessId: "other" }),
  ];
  assert.equal(evaluate(facts).A28, 1n);
  assert.equal(evaluate(facts).A63, 1n);
  facts.push(fact(START + 1000, 1n));
  assert.equal(evaluate(facts).A28, 2n);
  assert.equal(evaluate(facts).A63, 2n);
});

test("unknown identities still contribute totals and total-day rules, but never diversity", () => {
  const facts = [
    fact(START, 1000n * M, {
      modelId: null,
      harnessId: null,
      repositoryKey: null,
      providerId: null,
      freeClass: "review",
    }),
  ];
  const result = evaluate(facts);
  for (const id of ["A18", "A28", "A29", "A30", "A36", "A63"]) assert.equal(result[id], 0n, id);
  assert.equal(result.A13, 1n);
  assert.equal(result.A56, 1n);
  assert.equal(result.A19, 1000n * M);
  assert.equal(result.A58, 1000n * M);
  assert.equal(result.A59, 1000n * M);
});

test("daily billion threshold and totals remain exact above Number.MAX_SAFE_INTEGER", () => {
  assert.equal(evaluate([fact(START, 1000n * M - 1n)]).A56, 0n);
  assert.equal(evaluate([fact(START, 1000n * M - 1n), fact(START + 1, 1n)]).A56, 1n);
  const large = 9_007_199_254_740_993n;
  const result = evaluate([fact(START, large), fact(START + 1, 1n)]);
  for (const id of ["A19", "A58", "A59"]) assert.equal(result[id], large + 1n, id);
});

test("intervals bucket only when both inclusive coverage endpoints share that period", () => {
  const sameWeek = evaluate([interval("2027-01-04T23:00:00Z", "2027-01-05T01:00:00Z", 3_000n * M)], {
    timeZone: "UTC",
  });
  assert.equal(sameWeek.A19, 0n);
  assert.equal(sameWeek.A13, 0n);
  assert.equal(sameWeek.A29, 1n);
  assert.equal(sameWeek.A59, 3_000n * M);
  assert.equal(sameWeek.A58, 3_000n * M);
  const sameMonth = evaluate([interval("2027-01-10T23:00:00Z", "2027-01-11T01:00:00Z", 5_000n * M)], {
    timeZone: "UTC",
  });
  assert.equal(sameMonth.A19, 0n);
  assert.equal(sameMonth.A29, 0n);
  assert.equal(sameMonth.A59, 0n);
  assert.equal(sameMonth.A58, 5_000n * M);
  const sameWeekAcrossYear = evaluate([interval("2026-12-31T23:00:00Z", "2027-01-01T01:00:00Z", 7_000n * M)], {
    timeZone: "UTC",
  });
  assert.equal(sameWeekAcrossYear.A19, 0n);
  assert.equal(sameWeekAcrossYear.A58, 0n);
  assert.equal(sameWeekAcrossYear.A59, 7_000n * M);
  assert.equal(sameWeekAcrossYear.A38, 0n);
  const acrossEverything = evaluate([interval("2027-01-31T23:00:00Z", "2027-02-01T01:00:00Z", 9_000n * M)], {
    timeZone: "UTC",
  });
  for (const id of IDS) assert.equal(acrossEverything[id], 0n, id);
});

test("inclusive period boundary and day precision never become a fake last-seen instant", () => {
  const start = Date.parse("2027-01-04T00:00:00Z");
  const fullDay = interval(start, start + DAY - 1, 1000n * M, { precision: "day" });
  assert.equal(evaluate([fullDay], { timeZone: "UTC" }).A19, 1000n * M);
  const boundary = interval(start, start + DAY, 1000n * M);
  const result = evaluate([boundary], { timeZone: "UTC" });
  assert.equal(result.A19, 0n);
  assert.equal(result.A58, 1000n * M);
  assert.equal(result.A59, 1000n * M);
});

test("monthly attendance waits for closure, counts each day once, and allows T0 mid-period", () => {
  const enabledAt = Date.parse("2027-01-05T06:00:00Z");
  const cutoff = Date.parse("2027-01-25T00:00:00Z");
  const facts = Array.from({ length: 20 }, (_, i) => fact(Date.UTC(2027, 0, 5 + i, 12), 150n * M));
  const current = evaluate(facts, { enabledAt, cutoff, timeZone: "UTC" });
  assert.equal(current.A16, 0n);
  assert.equal(current.A65, 0n);
  assert.equal(current.A58, 3_000n * M);
  const closed = evaluate(facts, { enabledAt, cutoff: Date.parse("2027-02-01T00:00:00Z"), timeZone: "UTC" });
  assert.equal(closed.A16, 1n);
  assert.equal(closed.A65, 1n);
  assert.equal(evaluate(facts.slice(0, 9)).A16, 0n);
  assert.equal(evaluate(facts.slice(0, 10)).A16, 1n);
  assert.equal(evaluate([...facts.slice(0, 19), fact(facts[0].occurredAt)]).A65, 0n);
  assert.equal(evaluate(facts.slice(0, 19)).A65, 0n);
  const almost = Array.from({ length: 20 }, (_, i) => fact(Date.UTC(2027, 0, 5 + i, 12), 100n * M - 1n));
  assert.equal(evaluate(almost).A65, 0n);
});

test("nonconsecutive qualified months accumulate attendance across underqualified gaps", () => {
  const facts = [0, 2, 4].flatMap((month) =>
    Array.from({ length: 20 }, (_, day) => fact(Date.UTC(2027, month, day + 1, 12))),
  );
  facts.push(
    ...[1, 3].flatMap((month) => Array.from({ length: 9 }, (_, day) => fact(Date.UTC(2027, month, day + 1, 12)))),
  );
  const result = evaluate(facts.toReversed(), { cutoff: Date.parse("2027-06-01T00:00:00Z"), timeZone: "UTC" });
  assert.equal(result.A16, 3n, "January, March and May each have at least 10 qualified days");
  assert.equal(result.A65, 3n, "January, March and May each have 20 days at 100M");
});

test("weekly diversity closes at local Monday, while weekly total needs no closure", () => {
  const facts = [fact("2027-01-04T12:00:00Z", 1000n * M - 1n), fact("2027-01-10T12:00:00Z", 1n)];
  const justBefore = evaluate(facts, { cutoff: Date.parse("2027-01-10T23:59:59.999Z"), timeZone: "UTC" });
  assert.equal(justBefore.A29, 0n);
  assert.equal(justBefore.A59, 1000n * M);
  assert.equal(evaluate(facts, { cutoff: Date.parse("2027-01-11T00:00:00Z"), timeZone: "UTC" }).A29, 1n);
  assert.equal(evaluate(facts.slice(0, 1)).A29, 0n);
  assert.equal(evaluate([facts[0], fact("2027-01-11T12:00:00Z", 1n)]).A29, 0n);
});

test("midweek T0 allows A29 only after Sunday has ended at the next local Monday", () => {
  const enabledAt = Date.parse("2027-01-06T04:00:00Z");
  const facts = [
    fact("2027-01-04T04:00:00Z", 5_000n * M, { harnessId: "OpenCode" }),
    fact(enabledAt, 1000n * M, { harnessId: "Codex" }),
    fact("2027-01-07T04:00:00Z", 1000n * M, { harnessId: "Hermes" }),
    fact("2027-01-10T04:00:00Z", 1000n * M, { harnessId: "Claude" }),
  ];
  const sunday = evaluate(facts, { enabledAt, cutoff: Date.parse("2027-01-10T15:59:59.999Z") });
  assert.equal(sunday.A29, 0n, "Sunday 23:59:59.999 in Asia/Shanghai is still an open week");
  assert.equal(sunday.A59, 3_000n * M, "only the three post-T0 Harness totals count");
  const monday = evaluate(facts, { enabledAt, cutoff: Date.parse("2027-01-10T16:00:00Z") });
  assert.equal(monday.A29, 3n, "Monday 00:00 closes the week even though T0 was Wednesday");
});

test("natural weeks and months do not become rolling 7-day or 30-day windows", () => {
  const week = evaluate([fact("2027-01-10T23:59:59.999Z", 600n * M), fact("2027-01-11T00:00:00Z", 600n * M)], {
    timeZone: "UTC",
  });
  assert.equal(week.A59, 600n * M);
  const month = evaluate([fact("2027-01-31T23:59:59.999Z", 2_000n * M), fact("2027-02-01T00:00:00Z", 2_000n * M)], {
    timeZone: "UTC",
  });
  assert.equal(month.A58, 2_000n * M);
});

test("DST spring and fall preserve local adjacency and repeated hours count as one day", () => {
  const facts = [
    fact("2027-03-13T17:00:00Z", 10n * M),
    fact("2027-03-14T16:00:00Z", 10n * M),
    fact("2027-03-15T16:00:00Z", 10n * M),
    fact("2027-11-06T16:00:00Z", 10n * M),
    fact("2027-11-07T05:30:00Z", 5n * M),
    fact("2027-11-07T06:30:00Z", 5n * M),
    fact("2027-11-08T17:00:00Z", 10n * M),
  ];
  const result = evaluate(facts, { timeZone: "America/New_York" });
  assert.equal(result.A13, 6n);
  assert.equal(result.A14, 3n);
  assert.equal(result.A19, 10n * M);
});

test("DST week/month closure uses the fixed IANA date rather than UTC midnight", () => {
  const facts = Array.from({ length: 20 }, (_, i) => fact(Date.UTC(2027, 2, i + 1, 17)));
  assert.equal(
    evaluate(facts, { timeZone: "America/New_York", cutoff: Date.parse("2027-04-01T03:59:59.999Z") }).A65,
    0n,
  );
  assert.equal(evaluate(facts, { timeZone: "America/New_York", cutoff: Date.parse("2027-04-01T04:00:00Z") }).A65, 1n);
  const week = [fact("2027-03-14T16:00:00Z", 1000n * M)];
  assert.equal(
    evaluate(week, { timeZone: "America/New_York", cutoff: Date.parse("2027-03-15T03:59:59.999Z") }).A29,
    0n,
  );
  assert.equal(evaluate(week, { timeZone: "America/New_York", cutoff: Date.parse("2027-03-15T04:00:00Z") }).A29, 1n);
});

test("return gap counts 30 intermediate dates; even one intervening model Token interrupts it", () => {
  const facts = [fact("2027-01-01T12:00:00Z", 1n), fact("2027-02-01T12:00:00Z")];
  assert.equal(evaluate(facts).A36, 30n);
  assert.equal(evaluate([facts[0], fact("2027-01-31T12:00:00Z")]).A36, 29n);
  assert.equal(evaluate([...facts, fact("2027-01-15T12:00:00Z", 1n)]).A36, 16n);
  assert.equal(evaluate([...facts, fact("2027-01-15T12:00:00Z", 0n)]).A36, 30n);
  assert.equal(evaluate([...facts, fact("2027-01-15T12:00:00Z", 1n, { modelId: "different" })]).A36, 30n);
  assert.equal(evaluate([facts[0], fact("2027-02-01T12:00:00Z", 100n * M - 1n)]).A36, 0n);
  const split = [facts[0], fact("2027-02-01T12:00:00Z", 60n * M), fact("2027-02-01T13:00:00Z", 40n * M)];
  assert.equal(evaluate(split).A36, 30n);
});

test("return requires both uses after T0 and cannot turn cross-T0 intervals into prior use", () => {
  const enabledAt = Date.parse("2027-01-02T00:00:00Z");
  const returning = fact("2027-02-02T12:00:00Z");
  assert.equal(evaluate([fact("2027-01-01T23:59:59.999Z", 1n), returning], { enabledAt }).A36, 0n);
  assert.equal(
    evaluate([interval("2027-01-01T23:00:00Z", "2027-01-02T01:00:00Z", 1n), returning], { enabledAt }).A36,
    0n,
  );
  assert.equal(evaluate([fact(enabledAt, 1n), returning], { enabledAt, timeZone: "UTC" }).A36, 30n);
});

test("uncertain positive cross-day coverage can interrupt, but never manufacture, idle days", () => {
  const before = fact("2027-01-01T12:00:00Z", 1n);
  const returning = fact("2027-02-01T12:00:00Z");
  const spanning = interval("2027-01-01T13:00:00Z", "2027-02-01T11:00:00Z", 1n);
  assert.equal(evaluate([before, returning, spanning]).A36, 0n);
  const middle = interval("2027-01-10T12:00:00Z", "2027-01-20T12:00:00Z", 1n);
  assert.equal(evaluate([before, returning, middle]).A36, 11n);
  const unlocatedReturn = interval("2027-02-01T12:00:00Z", "2027-02-02T12:00:00Z", 100n * M);
  assert.equal(evaluate([before, unlocatedReturn]).A36, 0n);
  const oldInterval = interval("2027-01-01T12:00:00Z", "2027-01-02T12:00:00Z", 1n);
  assert.equal(evaluate([oldInterval, fact("2027-02-02T12:00:00Z")]).A36, 30n);
});

test("A36 retains the longest interval end through nested, overlapping and unordered coverage", () => {
  const before = fact("2027-01-01T12:00:00Z", 1n);
  const returning = fact("2027-02-01T12:00:00Z");
  const long = interval("2027-01-02T12:00:00Z", "2027-01-20T12:00:00Z", 1n);
  const nested = interval("2027-01-10T12:00:00Z", "2027-01-11T12:00:00Z", 1n);
  const overlapping = interval("2027-01-15T12:00:00Z", "2027-01-25T12:00:00Z", 1n);
  const shorter = interval("2027-01-16T12:00:00Z", "2027-01-17T12:00:00Z", 1n);
  const spanningReturn = interval("2027-01-02T12:00:00Z", "2027-02-03T12:00:00Z", 1n);
  for (const [label, ranges, expected] of [
    ["nested: January 21 through 31 are the 11 possible idle days", [long, nested], 11n],
    ["overlap: January 26 through 31 are the 6 possible idle days", [long, nested, overlapping, shorter], 6n],
    ["a long interval covering the return day blocks any proven gap", [spanningReturn, nested, shorter], 0n],
  ]) {
    const facts = [before, ...ranges, returning];
    for (const ordered of [facts, facts.toReversed(), [returning, ...ranges.toReversed(), before]]) {
      assert.equal(evaluate(ordered, { timeZone: "UTC" }).A36, expected, label);
    }
  }
});

test("return gap is measured by local dates across 23-hour and 25-hour days", () => {
  const spring = [fact("2027-03-01T17:00:00Z", 1n), fact("2027-04-01T16:00:00Z")];
  const fall = [fact("2027-10-15T16:00:00Z", 1n), fact("2027-11-15T17:00:00Z")];
  assert.equal(evaluate(spring, { timeZone: "America/New_York" }).A36, 30n);
  assert.equal(evaluate(fall, { timeZone: "America/New_York" }).A36, 30n);
});

test("cross-year and leap-day totals require matching local dates and each day's own minimum", () => {
  const lateDecember = fact("2027-12-31T15:59:59.999Z", M);
  const earlyJanuary = fact("2027-12-31T16:00:00Z", M - 1n);
  const base = [lateDecember, earlyJanuary];
  assert.equal(evaluate(base).A38, 0n);
  base.push(fact("2027-12-31T16:00:00.001Z", 1n));
  assert.equal(evaluate(base).A38, 1n);
  assert.equal(evaluate(base, { timeZone: "UTC" }).A38, 0n);
  assert.equal(evaluate([lateDecember, fact("2029-01-01T12:00:00Z", M)]).A38, 0n);
  const leap = [fact("2028-02-28T16:00:00Z", M - 1n)];
  assert.equal(evaluate(leap).A39, 0n);
  leap.push(fact("2028-02-28T16:00:00.001Z", 1n));
  assert.equal(evaluate(leap).A39, 1n);
  assert.equal(evaluate(leap, { timeZone: "UTC" }).A39, 0n);
  assert.equal(evaluate([fact("2027-02-28T12:00:00Z", 1000n * M)]).A39, 0n);
});

test("late-arriving facts and revisions recompute the original periods and may lower progress", () => {
  const first = fact("2027-01-01T12:00:00Z", 1n);
  const returning = fact("2027-02-01T12:00:00Z");
  assert.equal(evaluate([returning, first]).A36, 30n);
  const late = fact("2027-01-15T12:00:00Z", 1n);
  assert.equal(evaluate([returning, late, first]).A36, 16n);
  const monthly = Array.from({ length: 10 }, (_, i) => fact(START + i * DAY, 10n * M));
  assert.equal(evaluate(monthly.slice(1)).A16, 0n);
  assert.equal(evaluate([...monthly.slice(1), monthly[0]]).A16, 1n);
  const revised = { ...monthly[0], totalTokens: "9999999", revision: "2" };
  assert.equal(evaluate([...monthly.slice(1), revised]).A16, 0n);
});

test("T0 and cutoff are half-open and crossing aggregates are excluded without prorating", () => {
  const enabledAt = START;
  const cutoff = START + DAY;
  const facts = [
    fact(START - 1, 1000n * M),
    fact(START, 1n),
    fact(cutoff - 1, 9_999_999n),
    fact(cutoff, 1000n * M),
    interval(START - 1, START + 1000, 1000n * M),
    interval(cutoff - 1000, cutoff, 1000n * M),
  ];
  const result = evaluate(facts, { enabledAt, cutoff, timeZone: "UTC" });
  assert.equal(result.A19, 9_999_999n);
  assert.equal(result.A58, 10n * M);
  assert.equal(result.A13, 0n);
  assert.equal(result.A14, 0n);
});
