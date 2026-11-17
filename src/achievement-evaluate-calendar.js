import { achievementCalendarKeys, closedAchievementPeriods } from "./achievement-calendar.js";

const M = 1_000_000n;

function add(map, key, value) {
  map.set(key, (map.get(key) || 0n) + value);
}

function qualifiedCount(map, minimum) {
  let count = 0n;
  for (const value of map.values()) if (value >= minimum) count++;
  return count;
}

function maximum(values) {
  let result = 0n;
  for (const value of values) if (value > result) result = value;
  return result;
}

/** Evaluate normalized, deduplicated S08-B facts without awarding or persisting. */
export function evaluateCalendarAchievements({ facts, enabledAt, cutoff, timeZone }) {
  const result = {
    A13: 0n,
    A14: 0n,
    A16: 0n,
    A18: 0n,
    A19: 0n,
    A28: 0n,
    A29: 0n,
    A30: 0n,
    A36: 0n,
    A38: 0n,
    A39: 0n,
    A56: 0n,
    A58: 0n,
    A59: 0n,
    A63: 0n,
    A65: 0n,
  };
  const closed = closedAchievementPeriods(cutoff, timeZone);
  const days = new Map();
  const weeks = new Map();
  const months = new Map();
  const models = new Map();

  for (const fact of facts) {
    const { start, end } = fact.coverage;
    const total = BigInt(fact.totalTokens);
    if (start < enabledAt || end >= cutoff || total === 0n) continue;
    const first = achievementCalendarKeys(start, timeZone);
    const last = start === end ? first : achievementCalendarKeys(end, timeZone);
    if (fact.modelId) {
      if (!models.has(fact.modelId)) models.set(fact.modelId, { ranges: [], activeDays: [] });
      // Unknown placement anywhere in a positive interval prevents proving an idle gap there.
      models.get(fact.modelId).ranges.push({ start: first.ordinal, end: last.ordinal });
    }
    if (first.day === last.day) {
      if (!days.has(first.day)) {
        days.set(first.day, { ...first, total: 0n, models: new Map(), harnesses: new Map(), repositories: new Map() });
      }
      const day = days.get(first.day);
      day.total += total;
      if (fact.modelId) add(day.models, fact.modelId, total);
      if (fact.harnessId) add(day.harnesses, fact.harnessId, total);
      if (fact.repositoryKey) add(day.repositories, fact.repositoryKey, total);
    }
    if (first.week === last.week) {
      if (!weeks.has(first.week)) weeks.set(first.week, { total: 0n, harnesses: new Map() });
      const week = weeks.get(first.week);
      week.total += total;
      if (fact.harnessId) add(week.harnesses, fact.harnessId, total);
    }
    if (first.month === last.month) add(months, first.month, total);
  }

  const repositoryDays = new Map();
  const monthDays = new Map();
  let previousActive;
  let streak = 0n;
  for (const day of [...days.values()].sort((a, b) => a.ordinal - b.ordinal)) {
    if (!monthDays.has(day.month)) monthDays.set(day.month, { active: 0n, high: 0n });
    const month = monthDays.get(day.month);
    if (day.total >= 10n * M) {
      result.A13++;
      month.active++;
      streak = previousActive === day.ordinal - 1 ? streak + 1n : 1n;
      previousActive = day.ordinal;
      if (streak > result.A14) result.A14 = streak;
    }
    if (day.total >= 100n * M) month.high++;
    if (day.total >= 1000n * M) result.A56++;
    if (day.total > result.A19) result.A19 = day.total;
    const modelCount = qualifiedCount(day.models, 100n * M);
    const harnessCount = qualifiedCount(day.harnesses, 100n * M);
    if (modelCount > result.A28) result.A28 = modelCount;
    if (harnessCount > result.A63) result.A63 = harnessCount;
    for (const [model, total] of day.models) {
      if (total >= 100n * M) models.get(model).activeDays.push(day.ordinal);
    }
    for (const [repository, total] of day.repositories) {
      if (total >= 100n * M) add(repositoryDays, repository, 1n);
    }
    if (day.total >= M && day.day.endsWith("-02-29")) result.A39++;
    if (day.total >= M && day.day.endsWith("-12-31")) {
      const next = `${Number(day.day.slice(0, 4)) + 1}-01-01`;
      if (days.get(next)?.total >= M) result.A38++;
    }
  }
  result.A18 = maximum(repositoryDays.values());
  result.A58 = maximum(months.values());
  for (const [key, month] of monthDays) {
    if (key > closed.month) continue;
    if (month.active >= 10n) result.A16++;
    if (month.high >= 20n) result.A65++;
  }
  for (const [key, week] of weeks) {
    if (week.total > result.A59) result.A59 = week.total;
    if (key <= closed.week) {
      const count = qualifiedCount(week.harnesses, 1000n * M);
      if (count > result.A29) result.A29 = count;
    }
  }
  for (const model of models.values()) {
    const active = BigInt(model.activeDays.length);
    if (active > result.A30) result.A30 = active;
    model.ranges.sort((a, b) => a.start - b.start);
    let cursor = 0;
    let latestEnd;
    for (const day of model.activeDays) {
      while (cursor < model.ranges.length && model.ranges[cursor].start < day) {
        latestEnd = Math.max(latestEnd ?? -Infinity, model.ranges[cursor++].end);
      }
      if (latestEnd !== undefined && latestEnd < day) {
        const unused = BigInt(day - latestEnd - 1);
        if (unused > result.A36) result.A36 = unused;
      }
    }
  }
  return result;
}
