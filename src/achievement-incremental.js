import { achievementCalendarKeys } from "./achievement-calendar.js";
import { ACHIEVEMENT_CATALOG } from "./achievement-catalog.js";
import { evaluateCalendarAchievements } from "./achievement-evaluate-calendar.js";
import { evaluateCumulativeAchievements } from "./achievement-evaluate-cumulative.js";
import { evaluateMetaAchievements, evaluateOperationAchievements } from "./achievement-evaluate-operations.js";

/** Derived in-memory buckets only; canonical events remain exclusively in UsageStore. */
export class AchievementAggregates {
  constructor(timeZone) {
    this.timeZone = timeZone;
    this.cumulative = new Map();
    this.calendar = new Map();
    this.records = 0n;
  }

  append(facts) {
    for (const fact of facts) {
      // The canonical adapter validates identities; runtime proves this tail has never been applied.
      this.records++;
      const cumulativeKey = JSON.stringify([
        fact.modelId,
        fact.providerId,
        fact.harnessId,
        fact.sessionKey,
        fact.repositoryKey,
        fact.freeClass,
      ]);
      const first = achievementCalendarKeys(fact.coverage.start, this.timeZone);
      const last = achievementCalendarKeys(fact.coverage.end, this.timeZone);
      const calendarKey = JSON.stringify([first.day, last.day, fact.modelId, fact.harnessId, fact.repositoryKey]);
      /** @type {[Map<string, any>, string][]} */
      const targets = [
        [this.cumulative, cumulativeKey],
        [this.calendar, calendarKey],
      ];
      for (const [buckets, key] of targets) {
        const previous = buckets.get(key);
        buckets.set(key, {
          modelId: fact.modelId,
          providerId: fact.providerId,
          harnessId: fact.harnessId,
          sessionKey: fact.sessionKey,
          repositoryKey: fact.repositoryKey,
          freeClass: fact.freeClass,
          totalTokens: (BigInt(previous?.totalTokens || 0) + BigInt(fact.totalTokens)).toString(),
          coverage: {
            start: Math.min(previous?.coverage.start ?? fact.coverage.start, fact.coverage.start),
            end: Math.max(previous?.coverage.end ?? fact.coverage.end, fact.coverage.end),
          },
        });
      }
    }
  }

  evaluate({ profile, cutoff, operations, inputKey }, existingAwards) {
    const context = { enabledAt: Date.parse(profile.enabledAt), cutoff, timeZone: this.timeZone };
    /** @type {Record<string, bigint>} */
    const values = {
      ...evaluateCumulativeAchievements({ facts: [...this.cumulative.values()] }),
      A31: this.records,
      ...evaluateCalendarAchievements({ ...context, facts: [...this.calendar.values()] }),
      ...evaluateOperationAchievements({
        operations: operations.filter(({ occurredAt }) => {
          const at = typeof occurredAt === "number" ? occurredAt : Date.parse(occurredAt);
          return at >= context.enabledAt && at < cutoff;
        }),
      }),
    };
    const earned = new Map(ACHIEVEMENT_CATALOG.map(({ id }) => [id, new Set()]));
    for (const { id, tier } of existingAwards) {
      const row = ACHIEVEMENT_CATALOG.find((row) => row.id === id);
      for (const lower of row.tiers.slice(0, row.tiers.indexOf(tier) + 1)) earned.get(id).add(lower);
    }
    const awards = [];
    const accept = (id) => {
      const row = ACHIEVEMENT_CATALOG.find((row) => row.id === id);
      row.tiers.forEach((tier, index) => {
        if (values[id] >= BigInt(row.thresholds[index]) && !earned.get(id).has(tier)) {
          earned.get(id).add(tier);
          awards.push({ id, tier });
        }
      });
    };
    for (const id of Object.keys(values)) accept(id);
    Object.assign(values, evaluateMetaAchievements(earned));
    for (const id of ["A73", "A74", "A75"]) accept(id);
    values.A76 = evaluateMetaAchievements(earned).A76;
    accept("A76");
    return {
      inputKey,
      evaluatedThrough: cutoff,
      awards,
      rows: ACHIEVEMENT_CATALOG.map(({ id, tiers, thresholds }) => ({
        id,
        observedValue: values[id].toString(),
        nextTarget: thresholds[tiers.findIndex((tier) => !earned.get(id).has(tier))] ?? null,
      })),
    };
  }
}
