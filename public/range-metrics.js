import { sourceGroup, timelineDateKey as dateKey, rangeHourStart } from "./timeline-utils.js";
export { rangeHourStart };
import { dateKey as calendarDateKey, rangeCalendarZone } from "./calendar.js";
import { sessionIdentity, USAGE_DETAIL_MASK } from "./usage-fields.js";

export function usageHarness(channel, kind) {
  const known = sourceGroup("", kind);
  if (known) return known;
  const legacy = sourceGroup(channel);
  return ["Codex", "ZCode", "DSH", "OpenCode", "Claude", "WorkBuddy", "Hermes"].includes(legacy) ? legacy : null;
}

export function rangeMetricsFromGroups({
  days = [],
  hours = [],
  sessions = [],
  harnesses = [],
  repositoryCount = 0,
  first = null,
  last = null,
  composition = { uncached: 0, cached: 0, output: 0, total: 0 },
}) {
  const peak = (rows) =>
    rows.reduce(
      (best, row) => (!best || row.total > best.total || (row.total === best.total && row.key < best.key) ? row : best),
      null,
    );
  return {
    first,
    last,
    activeDays: days.length,
    peakDay: peak(days),
    peakHour: peak(hours),
    maxSessionTokens: sessions.length ? sessions.reduce((max, row) => Math.max(max, row.total), 0) : 0,
    repositoryCount,
    harnesses: [...harnesses].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    composition,
  };
}

export function createRangeMetricsAccumulator(calendarZone = "local", sourceKinds = new Map()) {
  const days = new Map(),
    hours = new Map(),
    sessions = new Map(),
    harnesses = new Map(),
    repositories = new Set();
  const composition = { uncached: 0, cached: 0, output: 0, total: 0 };
  let first = null,
    last = null;
  const add = (map, key, total) => map.set(key, (map.get(key) || 0) + total);
  return {
    add(event) {
      const time = typeof event.timestamp === "number" ? event.timestamp : Date.parse(event.timestamp);
      const total = Number(event.total?.total || 0);
      if (!Number.isFinite(time) || total <= 0) return;
      first = first === null ? time : Math.min(first, time);
      last = last === null ? time : Math.max(last, time);
      add(days, dateKey(new Date(time), calendarZone), total);
      add(hours, rangeHourStart(time, calendarZone), total);
      add(sessions, sessionIdentity(event.homeId, event.sessionId), total);
      const harness = usageHarness(event.channel, event.sourceKind || sourceKinds.get(String(event.homeId)));
      if (harness && harness !== "Unknown") add(harnesses, harness, total);
      const repository = event.repositoryKey;
      if (repository && event.repositoryKind !== "unknown" && !repository.startsWith("unknown:"))
        repositories.add(repository);
      const mask = Number.isInteger(event.detailMask) ? event.detailMask : USAGE_DETAIL_MASK.complete;
      if ((mask & 7) === 7) {
        composition.uncached += Math.max(0, event.total.input - event.total.cached);
        composition.cached += event.total.cached;
        composition.output += event.total.output;
        composition.total += total;
      }
    },
    result() {
      return rangeMetricsFromGroups({
        first,
        last,
        repositoryCount: repositories.size,
        composition,
        days: [...days].map(([key, total]) => ({ key, total })),
        hours: [...hours].map(([key, total]) => ({ key, total })),
        sessions: [...sessions].map(([key, total]) => ({ key, total })),
        harnesses: [...harnesses].map(([name, total]) => ({ name, total })),
      });
    },
  };
}

export function coveredCalendarDays(range, metrics) {
  const cutoff = range.asOf ? Date.parse(range.asOf) : Infinity;
  const start = range.start ? Date.parse(range.start) : metrics?.first;
  const end = range.end ? Math.min(Date.parse(range.end), cutoff) : Math.min(metrics?.last ?? Infinity, cutoff);
  if (start === null || start === undefined || !Number.isFinite(start) || !Number.isFinite(end) || start > end)
    return null;
  const ordinal = (time) =>
    Date.parse(`${calendarDateKey(new Date(time), rangeCalendarZone(range))}T00:00:00Z`) / 86400000;
  return ordinal(end) - ordinal(start) + 1;
}
