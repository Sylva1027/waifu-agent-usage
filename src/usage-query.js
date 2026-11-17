import { USAGE_FIELDS, emptyUsage, sessionIdentity } from "../public/usage-fields.js";
import {
  completedQuotaWindows,
  sourceGroup,
  resolveNamedRecentRange,
  previousQuotaRange,
} from "../public/timeline-utils.js";
import {
  MS_PER_DAY,
  calendarPresetRange,
  endOfLocalDay,
  startOfLocalDay,
  startOfLocalWeek,
} from "../public/period-comparison.js";

export const MS_PER_MINUTE = 60 * 1000;
export const QUOTA_WINDOW_MINUTES = Object.freeze({ quota_5h: 300, quota_week: 10080 });
export const QUOTA_PERCENT_STALE_AFTER_MS = 10 * 60 * 1000;
export const USAGE_PRESETS = Object.freeze([
  "today",
  "week",
  "month",
  "all",
  "recent",
  "custom",
  "quota_5h",
  "quota_week",
]);

export function isQuotaPreset(preset) {
  return Object.hasOwn(QUOTA_WINDOW_MINUTES, preset);
}

export class InvalidPresetError extends Error {
  constructor(preset) {
    super(`无效的时间范围：${String(preset)}`);
    this.name = "InvalidPresetError";
    this.code = "INVALID_PRESET";
  }
}

export class QuotaWindowUnavailableError extends Error {
  constructor(preset, quota) {
    const window = quota?.windows?.[preset];
    super(window?.reason || "当前没有可用的 Codex 限额窗口。");
    this.name = "QuotaWindowUnavailableError";
    this.code = "QUOTA_WINDOW_UNAVAILABLE";
    this.preset = preset;
    this.quota = quota || null;
    this.state = window?.state || "missing";
  }
}

export function addUsage(target, usage) {
  for (const field of USAGE_FIELDS) {
    target[field] += usage[field] || 0;
  }
  return target;
}

function observationKey(observation, index) {
  const sourcePath = observation.sourcePath ?? observation.source_path;
  const lineNumber = observation.lineNumber ?? observation.line_number;
  const role = observation.role;
  return sourcePath !== undefined && lineNumber !== undefined && role
    ? `${sourcePath}\u0000${lineNumber}\u0000${role}`
    : `unkeyed\u0000${index}`;
}

function observationValue(observation, camelName, snakeName) {
  return observation?.[camelName] ?? observation?.[snakeName];
}

export function unavailableQuotaWindow(state, reason) {
  const reasonCode =
    new Map([
      ["存在多个无法区分的 Codex 限额桶。", "multiple-buckets"],
      ["尚未发现 Codex 限额记录。", "no-records"],
      ["同一观察时刻存在相互冲突的限额重置时间。", "conflicting-reset"],
      ["等待新的限额记录", "waiting"],
      ["尚未发现当前限额窗口的 Codex 记录。", "missing-window"],
      ["限额窗口边界无效。", "invalid-boundaries"],
    ]).get(reason) || state;
  return {
    state,
    reason,
    reasonCode,
    windowStart: null,
    windowEndExclusive: null,
    observedAt: null,
    usedPercent: null,
    percentStale: null,
  };
}

export function selectQuotaWindows(observations = [], asOfValue = new Date()) {
  const asOfMs =
    asOfValue instanceof Date ? asOfValue.getTime() : typeof asOfValue === "number" ? asOfValue : Date.parse(asOfValue);
  if (!Number.isFinite(asOfMs)) throw new RangeError("asOf must be a valid date.");
  const asOf = new Date(asOfMs).toISOString();
  const unique = new Map();
  observations.forEach((observation, index) => {
    const key = observationKey(observation, index);
    if (!unique.has(key)) unique.set(key, observation);
  });
  const valid = [...unique.values()].filter((observation) => {
    const id = observationValue(observation, "limitId", "limit_id");
    const observedAt = Number(observationValue(observation, "observedAtMs", "observed_at_ms"));
    const windowMinutes = Number(observation.windowMinutes ?? observation.window_minutes);
    const resetsAtMs = Number(observationValue(observation, "resetsAtMs", "resets_at_ms"));
    return (
      typeof id === "string" &&
      id.trim() &&
      Number.isFinite(observedAt) &&
      Number.isFinite(windowMinutes) &&
      windowMinutes > 0 &&
      Number.isFinite(resetsAtMs)
    );
  });
  const buckets = new Map();
  for (const observation of valid) {
    const id = observationValue(observation, "limitId", "limit_id");
    const observedAtMs = Number(observationValue(observation, "observedAtMs", "observed_at_ms"));
    const bucket = buckets.get(id) || { count: 0, latestObservedAtMs: -Infinity, observations: [] };
    bucket.count += 1;
    bucket.latestObservedAtMs = Math.max(bucket.latestObservedAtMs, observedAtMs);
    bucket.observations.push(observation);
    buckets.set(id, bucket);
  }

  let limitId = null;
  let ignoredBucketCount = 0;
  let bucketAmbiguous = false;
  if (buckets.size === 1) {
    limitId = buckets.keys().next().value;
  } else if (buckets.size > 1) {
    const repeated = [...buckets].filter(([, bucket]) => bucket.count > 1);
    if (!repeated.length) {
      bucketAmbiguous = true;
    } else {
      const candidates = repeated.sort(
        (left, right) => right[1].count - left[1].count || right[1].latestObservedAtMs - left[1].latestObservedAtMs,
      );
      ignoredBucketCount = buckets.size - candidates.length;
      if (
        candidates.length > 1 &&
        candidates[0][1].count === candidates[1][1].count &&
        candidates[0][1].latestObservedAtMs === candidates[1][1].latestObservedAtMs
      ) {
        bucketAmbiguous = true;
      } else {
        limitId = candidates[0][0];
      }
    }
  }

  const windows = {};
  for (const [preset, windowMinutes] of Object.entries(QUOTA_WINDOW_MINUTES)) {
    if (bucketAmbiguous) {
      windows[preset] = unavailableQuotaWindow("ambiguous", "存在多个无法区分的 Codex 限额桶。");
      continue;
    }
    if (!limitId) {
      windows[preset] = unavailableQuotaWindow("missing", "尚未发现 Codex 限额记录。");
      continue;
    }
    const bucketObservations = buckets
      .get(limitId)
      .observations.filter(
        (observation) => Number(observation.windowMinutes ?? observation.window_minutes) === windowMinutes,
      );
    const observedBeforeAsOf = bucketObservations.filter(
      (observation) => Number(observationValue(observation, "observedAtMs", "observed_at_ms")) <= asOfMs,
    );
    const current = observedBeforeAsOf.filter((observation) => {
      const endMs = Number(observationValue(observation, "resetsAtMs", "resets_at_ms"));
      const startMs = endMs - windowMinutes * MS_PER_MINUTE;
      return startMs <= asOfMs && asOfMs < endMs;
    });
    if (current.length) {
      const latestObservedAtMs = Math.max(
        ...current.map((observation) => Number(observationValue(observation, "observedAtMs", "observed_at_ms"))),
      );
      const latest = current.filter(
        (observation) => Number(observationValue(observation, "observedAtMs", "observed_at_ms")) === latestObservedAtMs,
      );
      const endPoints = new Set(
        latest.map((observation) => Number(observationValue(observation, "resetsAtMs", "resets_at_ms"))),
      );
      if (endPoints.size > 1) {
        windows[preset] = unavailableQuotaWindow("ambiguous", "同一观察时刻存在相互冲突的限额重置时间。");
        continue;
      }
      const windowEndMs = endPoints.values().next().value;
      const percents = new Set(
        latest.map((observation) => {
          const value = observationValue(observation, "usedPercent", "used_percent");
          return value === null || value === undefined ? null : Number(value);
        }),
      );
      const usedPercent = percents.size === 1 ? percents.values().next().value : null;
      const windowStartMs = windowEndMs - windowMinutes * MS_PER_MINUTE;
      windows[preset] = {
        state: "available",
        reason: null,
        windowStart: new Date(windowStartMs).toISOString(),
        windowEndExclusive: new Date(windowEndMs).toISOString(),
        observedAt: new Date(latestObservedAtMs).toISOString(),
        usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
        percentStale: asOfMs - latestObservedAtMs > QUOTA_PERCENT_STALE_AFTER_MS,
      };
      continue;
    }
    const hasExpiredObservation = observedBeforeAsOf.some(
      (observation) => Number(observationValue(observation, "resetsAtMs", "resets_at_ms")) <= asOfMs,
    );
    windows[preset] = hasExpiredObservation
      ? unavailableQuotaWindow("waiting", "等待新的限额记录")
      : unavailableQuotaWindow("missing", "尚未发现当前限额窗口的 Codex 记录。");
  }
  const previousWindows = {};
  for (const [preset, minutes] of Object.entries(QUOTA_WINDOW_MINUTES)) {
    const completed = bucketAmbiguous
      ? null
      : completedQuotaWindows(buckets.get(limitId)?.observations, limitId, asOfMs, minutes);
    previousWindows[preset] =
      completed === null
        ? unavailableQuotaWindow(
            "ambiguous",
            preset === "quota_week"
              ? "上一周限额记录存在冲突，无法确认周期边界。"
              : "同一观察时刻存在相互冲突的限额重置时间。",
          )
        : completed.at(-1) || unavailableQuotaWindow("missing", "尚未发现上一限额窗口的 Codex 记录。");
  }
  return { asOf, limitId, ignoredBucketCount, windows, previousWindows };
}

function addLocalDays(date, days, zone = "local") {
  const next = new Date(date);
  if (zone === "utc") next.setUTCDate(next.getUTCDate() + days);
  else next.setDate(next.getDate() + days);
  return next;
}

function parseDateStart(value, zone = "local") {
  return value ? new Date(`${value}T00:00:00${zone === "utc" ? "Z" : ""}`) : null;
}

function parseDateEnd(value, zone = "local") {
  return value ? new Date(`${value}T23:59:59.999${zone === "utc" ? "Z" : ""}`) : null;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function subtractMonthsClamped(date, months, zone = "local") {
  const year = zone === "utc" ? date.getUTCFullYear() : date.getFullYear();
  const month = zone === "utc" ? date.getUTCMonth() : date.getMonth();
  const day = zone === "utc" ? date.getUTCDate() : date.getDate();
  const target = zone === "utc" ? new Date(Date.UTC(year, month - months, 1)) : new Date(year, month - months, 1);
  const targetYear = zone === "utc" ? target.getUTCFullYear() : target.getFullYear();
  const targetMonth = zone === "utc" ? target.getUTCMonth() : target.getMonth();
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return zone === "utc"
    ? new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          clampedDay,
          date.getUTCHours(),
          date.getUTCMinutes(),
          date.getUTCSeconds(),
          date.getUTCMilliseconds(),
        ),
      )
    : new Date(
        targetYear,
        targetMonth,
        clampedDay,
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
        date.getMilliseconds(),
      );
}

function parseRecentValue(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, "");
  if (normalized === "半年") {
    return { months: 6 };
  }
  if (normalized === "一年") {
    return { months: 12 };
  }
  const dayMatch = normalized.match(/^([1-9]\d*)天$/);
  if (dayMatch) {
    return { days: Number(dayMatch[1]) };
  }
  const weekMatch = normalized.match(/^([1-9]\d*)周$/);
  if (weekMatch) {
    return { days: Number(weekMatch[1]) * 7 };
  }
  const monthMatch = normalized.match(/^([1-9]\d*)个月$/);
  if (monthMatch) {
    return { months: Number(monthMatch[1]) };
  }
  const yearMatch = normalized.match(/^([1-9]\d*)年$/);
  if (yearMatch) {
    return { months: Number(yearMatch[1]) * 12 };
  }
  return null;
}

function recentDateRange(value, now, zone = "local") {
  const parsed = parseRecentValue(value);
  if (!parsed) {
    return null;
  }
  if (parsed.days === 1) {
    return {
      start: new Date(now.getTime() - MS_PER_DAY),
      end: now,
      preset: "recent",
      rolling: true,
    };
  }
  const start = parsed.days
    ? addLocalDays(startOfLocalDay(now, zone), 1 - parsed.days, zone)
    : startOfLocalDay(subtractMonthsClamped(now, parsed.months, zone), zone);
  return {
    start,
    end: endOfLocalDay(now, zone),
    preset: "recent",
  };
}

/** @returns {import("./usage-types.js").UsageRange} */
export function resolveDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(
    filters,
    events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite),
  );
}

/** @returns {import("./usage-types.js").UsageRange} */
function resolveDateRangeFromTimestamps(filters = {}, timestamps = []) {
  // Report and index summaries share this resolver to avoid date-range drift.
  const now = filters.now ? new Date(filters.now) : new Date();
  const zone = filters.calendarZone === "utc" ? "utc" : "local";
  const preset = filters.preset || "all";
  if (!USAGE_PRESETS.includes(preset)) {
    throw new InvalidPresetError(preset);
  }
  if (isQuotaPreset(preset)) {
    const quota = filters.quota;
    const quotaWindow = quota?.windows?.[preset];
    if (quotaWindow?.state !== "available") {
      throw new QuotaWindowUnavailableError(preset, quota);
    }
    const windowStartMs = Date.parse(quotaWindow.windowStart || "");
    const windowEndExclusiveMs = Date.parse(quotaWindow.windowEndExclusive || "");
    const asOfMs = Date.parse(quota?.asOf || "");
    const expectedDuration = QUOTA_WINDOW_MINUTES[preset] * MS_PER_MINUTE;
    if (
      !Number.isFinite(windowStartMs) ||
      !Number.isFinite(windowEndExclusiveMs) ||
      !Number.isFinite(asOfMs) ||
      windowEndExclusiveMs - windowStartMs !== expectedDuration ||
      windowStartMs > asOfMs ||
      asOfMs >= windowEndExclusiveMs
    ) {
      throw new QuotaWindowUnavailableError(preset, {
        ...quota,
        windows: { ...quota?.windows, [preset]: unavailableQuotaWindow("ambiguous", "限额窗口边界无效。") },
      });
    }
    const effectiveEndExclusiveMs = Math.min(asOfMs, windowEndExclusiveMs);
    return {
      start: new Date(windowStartMs),
      // Existing event queries use inclusive ends. Subtracting one millisecond
      // preserves the required [start, effectiveEndExclusive) window.
      end: new Date(effectiveEndExclusiveMs - 1),
      endExclusive: new Date(effectiveEndExclusiveMs),
      windowEndExclusive: new Date(windowEndExclusiveMs),
      asOf: new Date(asOfMs),
      observedAt: quotaWindow.observedAt ? new Date(quotaWindow.observedAt) : null,
      usedPercent: quotaWindow.usedPercent ?? null,
      percentStale: Boolean(quotaWindow.percentStale),
      limitId: quota.limitId || null,
      quotaState: "available",
      quotaReason: null,
      quotaWindow: true,
      preset,
      rolling: false,
      calendarZone: zone,
    };
  }
  if (preset === "today" || preset === "week" || preset === "month" || preset === "all") {
    return { ...calendarPresetRange(preset, now, zone, timestamps), asOf: now };
  }
  if (preset === "custom") {
    return {
      start: parseDateStart(filters.startDate, zone),
      end: parseDateEnd(filters.endDate, zone),
      preset,
      asOf: now,
      calendarZone: zone,
    };
  }
  if (preset === "recent") {
    const named = resolveNamedRecentRange(filters.recentValue, now, filters.quota, zone);
    if (named) {
      if ("quotaState" in named && named.quotaState === "missing")
        throw new QuotaWindowUnavailableError(named.quotaPreset, filters.quota);
      return { ...named, asOf: now, calendarZone: zone };
    }
    const range = recentDateRange(filters.recentValue, now, zone);
    if (range) {
      return { ...range, recentValue: filters.recentValue, asOf: now, calendarZone: zone };
    }
  }

  return calendarPresetRange("all", now, zone, timestamps);
}

export function groupByUsage(events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event);
    const current = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    current.count += 1;
    current.sessions.add(sessionIdentity(event.homeId, event.sessionId));
    addUsage(current.total, event.total);
    if (current.channelGroups) {
      const channelKey = event.channel || "Unknown";
      const channel = current.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(sessionIdentity(event.homeId, event.sessionId));
      addUsage(channel.total, event.total);
      current.channelGroups.set(channelKey, channel);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      count: group.count,
      sessions: group.sessions.size,
      total: group.total,
      ...(group.channelGroups
        ? {
            channels: [...group.channelGroups.values()]
              .map((channel) => ({
                key: channel.key,
                name: channel.name,
                count: channel.count,
                sessions: channel.sessions.size,
                total: channel.total,
              }))
              .sort((a, b) => b.total.total - a.total.total),
          }
        : {}),
    }))
    .sort((a, b) => b.total.total - a.total.total);
}

export function groupRepositories(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.repositoryKey || `directory:${event.cwd || "Unknown cwd"}`;
    const group = groups.get(key) || {
      key,
      name: event.repositoryPath || event.cwd || "Unknown cwd",
      count: 0,
      sessions: new Set(),
      pathCount: 0,
      pathSet: new Set(),
      kind: event.repositoryKind || "directory",
      total: emptyUsage(),
    };
    const repositoryPath = event.repositoryPath || event.cwd || "Unknown cwd";
    if (repositoryPath < group.name) group.name = repositoryPath;
    group.count += 1;
    group.sessions.add(sessionIdentity(event.homeId, event.sessionId));
    if (event.cwd) {
      group.pathSet.add(event.cwd);
    }
    addUsage(group.total, event.total);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const { sessions, pathSet, ...row } = group;
      return {
        ...row,
        sessions: sessions.size,
        sessionIds: [...sessions].map((value) => JSON.parse(value)[1]),
        pathCount: pathSet.size,
      };
    })
    .sort((a, b) => b.total.total - a.total.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** @returns {import("./usage-types.js").UsageRange} */
export function indexDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(filters, events.map((event) => event.t).filter(Number.isFinite));
}

export function addIndexedUsage(target, event) {
  for (const field of USAGE_FIELDS) {
    target[field] += event[field] || 0;
  }
  return target;
}

export function groupIndexedEvents(index, events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event) || "Unknown";
    const current = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    current.count += 1;
    current.sessions.add(sessionIdentity(event.h, event.s));
    addIndexedUsage(current.total, event);
    if (current.channelGroups) {
      const channelKey = index.strings[event.c] || "Unknown";
      const channel = current.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(sessionIdentity(event.h, event.s));
      addIndexedUsage(channel.total, event);
      current.channelGroups.set(channelKey, channel);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      count: group.count,
      sessions: group.sessions.size,
      total: group.total,
      ...(group.channelGroups
        ? {
            channels: [...group.channelGroups.values()]
              .map((channel) => ({
                key: channel.key,
                name: channel.name,
                count: channel.count,
                sessions: channel.sessions.size,
                total: channel.total,
              }))
              .sort((a, b) => b.total.total - a.total.total),
          }
        : {}),
    }))
    .sort((a, b) => b.total.total - a.total.total);
}

export function groupIndexedRepositories(index, events) {
  const groups = new Map();
  for (const event of events) {
    const strings = index.strings;
    const key = strings[event.rk] || `directory:${strings[event.p] || "Unknown cwd"}`;
    const group = groups.get(key) || {
      key,
      name: strings[event.rp] || strings[event.p] || "Unknown cwd",
      kind: strings[event.rt] || "directory",
      count: 0,
      sessions: new Set(),
      pathSet: new Set(),
      total: emptyUsage(),
    };
    const repositoryPath = strings[event.rp] || strings[event.p] || "Unknown cwd";
    if (repositoryPath < group.name) group.name = repositoryPath;
    group.count += 1;
    group.sessions.add(sessionIdentity(event.h, event.s));
    const cwd = strings[event.p];
    if (cwd) {
      group.pathSet.add(cwd);
    }
    addIndexedUsage(group.total, event);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const { sessions, pathSet, ...row } = group;
      return {
        ...row,
        sessions: sessions.size,
        sessionIds: [...sessions].map((value) => index.strings[Number(JSON.parse(value)[1])] || JSON.parse(value)[1]),
        pathCount: pathSet.size,
      };
    })
    .sort((a, b) => b.total.total - a.total.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function usageIndexMetadata(index) {
  const homeStats = homeStatsFromIndex(index);
  return {
    generatedAt: index.generatedAt,
    eventCount: index.events.length,
    sessionCount: index.sessionCount,
    homeCount: index.homes.length,
    homes: index.homes.map((home) => ({
      ...home,
      ...(homeStats.get(home.id) || {
        status: "no-events",
        eventCount: 0,
        sessionCount: 0,
      }),
    })),
    warnings: index.warnings,
  };
}

function homeStatsFromIndex(index) {
  // Attach per-home activity counts without expanding the compact index into full events.
  const stats = new Map();
  for (const event of index.events) {
    const homeId = index.strings[event.h] || "";
    const current = stats.get(homeId) || {
      status: "active",
      eventCount: 0,
      sessions: new Set(),
    };
    current.eventCount += 1;
    current.sessions.add(event.s);
    stats.set(homeId, current);
  }
  return new Map(
    [...stats.entries()].map(([homeId, stat]) => [
      homeId,
      {
        status: stat.eventCount > 0 ? "active" : "no-events",
        eventCount: stat.eventCount,
        sessionCount: stat.sessions.size,
      },
    ]),
  );
}

export function previousUsageRange(range) {
  if (!range.start || !range.end || range.preset === "all") {
    return null;
  }
  const zone = range.calendarZone === "utc" ? "utc" : "local";
  if (range.preset === "today") {
    const previousDay = addLocalDays(startOfLocalDay(range.start, zone), -1, zone);
    return {
      start: previousDay,
      end: endOfLocalDay(previousDay, zone),
    };
  }
  if (range.preset === "week") {
    const previousWeekStart = addLocalDays(startOfLocalWeek(range.start, zone), -7, zone);
    return {
      start: previousWeekStart,
      end: endOfLocalDay(addLocalDays(previousWeekStart, 6, zone), zone),
    };
  }
  if (range.preset === "month" || range.recentValue === "上个月") {
    const currentMonthStart = startOfLocalDay(range.start, zone);
    return {
      start:
        zone === "utc"
          ? new Date(Date.UTC(currentMonthStart.getUTCFullYear(), currentMonthStart.getUTCMonth() - 1, 1))
          : new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1),
      end: new Date(currentMonthStart.getTime() - 1),
    };
  }
  if (["今年", "去年"].includes(range.recentValue)) {
    const utc = zone === "utc";
    const year = utc ? range.start.getUTCFullYear() : range.start.getFullYear();
    const start = utc ? new Date(Date.UTC(year - 1, 0, 1)) : new Date(year - 1, 0, 1);
    if (range.recentValue === "去年") return { start, end: new Date(range.start.getTime() - 1) };
    const end = utc
      ? new Date(
          Date.UTC(
            year - 1,
            range.end.getUTCMonth(),
            Math.min(range.end.getUTCDate(), new Date(Date.UTC(year - 1, range.end.getUTCMonth() + 1, 0)).getUTCDate()),
            23,
            59,
            59,
            999,
          ),
        )
      : new Date(
          year - 1,
          range.end.getMonth(),
          Math.min(range.end.getDate(), new Date(year - 1, range.end.getMonth() + 1, 0).getDate()),
          23,
          59,
          59,
          999,
        );
    return { start, end };
  }
  const durationMs = range.end.getTime() - range.start.getTime() + 1;
  return {
    start: new Date(range.start.getTime() - durationMs),
    end: new Date(range.start.getTime() - 1),
  };
}

function rangeDurationMs(range) {
  if (!range?.start || !range?.end) {
    return 0;
  }
  return Math.max(0, range.end.getTime() - range.start.getTime() + 1);
}

function currentElapsedMs(range, now) {
  if (!range?.start || !range?.end || Number.isNaN(now?.getTime())) {
    return rangeDurationMs(range);
  }
  const boundedEnd = Math.min(range.end.getTime(), Math.max(range.start.getTime(), now.getTime()));
  return Math.max(0, boundedEnd - range.start.getTime() + 1);
}

function averageTrend(currentTotals, previousTotals, range, previousRange, now) {
  const previousDurationMs = rangeDurationMs(previousRange);
  const elapsedMs = currentElapsedMs(range, now);
  const averageBaselineTotal = previousDurationMs
    ? Math.round((previousTotals.total * elapsedMs) / previousDurationMs)
    : 0;
  return {
    averageBaselineTotal,
    averageDelta: currentTotals.total - averageBaselineTotal,
    averagePercentChange: percentChange(currentTotals.total, averageBaselineTotal),
  };
}

function percentChange(current, previous) {
  if (!previous) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function comparisonLabel(preset) {
  return (
    {
      today: "较昨日",
      week: "较上周",
      month: "较上月",
      year: "较去年同期",
      lastYear: "较前年",
      custom: "较上一等长周期",
      recent: "较上一等长周期",
      quota_5h: "较上一5h",
      quota_week: "较上一7d",
    }[preset] || "暂无对比"
  );
}

export function usageComparison({
  range,
  allEvents,
  eventTime,
  eventSession,
  addEventUsage,
  currentTotals,
  now,
  quota,
  observations,
}) {
  // 保持调用方事件结构不变，只在这里统一计算上一周期和趋势。
  const previousRange = range.quotaWindow ? previousQuotaRange(range, quota, observations) : previousUsageRange(range);
  if (!previousRange) {
    return usageComparisonFromAggregates({ range, currentTotals, now, previousRange });
  }
  const previousEvents = allEvents.filter((event) => {
    const time = eventTime(event);
    return Number.isFinite(time) && time >= previousRange.start.getTime() && time <= previousRange.end.getTime();
  });
  const previousTotals = previousEvents.reduce((sum, event) => addEventUsage(sum, event), emptyUsage());
  const previousSessions = new Set(previousEvents.map(eventSession));
  return usageComparisonFromAggregates({
    range,
    currentTotals,
    previousTotals,
    previousEventCount: previousEvents.length,
    previousSessionCount: previousSessions.size,
    now,
    previousRange,
  });
}

export function usageComparisonFromAggregates({
  range,
  currentTotals,
  previousTotals = emptyUsage(),
  previousEventCount = 0,
  previousSessionCount = 0,
  now,
  previousRange = previousUsageRange(range),
}) {
  if (!previousRange) {
    return {
      label: comparisonLabel(
        { 今年: "year", 去年: "lastYear", 上个月: "month" }[range.recentValue] || range.quotaPreset || range.preset,
      ),
      previousRange: null,
      previousTotals: emptyUsage(),
      previousEventCount: 0,
      previousSessionCount: 0,
      totalDelta: currentTotals.total,
      percentChange: null,
      averageBaselineTotal: 0,
      averageDelta: currentTotals.total,
      averagePercentChange: null,
    };
  }
  const average = averageTrend(currentTotals, previousTotals, range, previousRange, now);

  return {
    label: comparisonLabel(range.quotaPreset || range.preset),
    previousRange: {
      start: previousRange.start.toISOString(),
      end: previousRange.end.toISOString(),
    },
    previousTotals,
    previousEventCount,
    previousSessionCount,
    totalDelta: currentTotals.total - previousTotals.total,
    percentChange: percentChange(currentTotals.total, previousTotals.total),
    ...average,
  };
}

export function summaryQuotaContext(observations, filters) {
  const initialAsOf = filters.quota?.asOf || filters.now || new Date();
  const quota = filters.quota || selectQuotaWindows(observations || [], initialAsOf);
  return { quota, asOf: new Date(quota.asOf) };
}

export function sourceGroupForQuota(kind) {
  return !kind || sourceGroup("", kind) === "Codex";
}

export function summaryRangeFields(range, bucket) {
  return {
    preset: range.preset,
    ...(range.recentValue ? { recentValue: range.recentValue } : {}),
    ...(range.asOf ? { asOf: range.asOf.toISOString() } : {}),
    start: range.start ? range.start.toISOString() : null,
    end: range.end ? range.end.toISOString() : null,
    bucket,
    calendarZone: range.calendarZone || "local",
    rolling: Boolean(range.rolling),
    ...(range.quotaWindow
      ? {
          quotaWindow: true,
          recentValue: range.recentValue,
          quotaPreset: range.quotaPreset,
          asOf: range.asOf.toISOString(),
          windowStart: range.start.toISOString(),
          windowEndExclusive: range.windowEndExclusive.toISOString(),
          observedAt: range.observedAt?.toISOString() || null,
          usedPercent: range.usedPercent,
          percentStale: range.percentStale,
          limitId: range.limitId,
          quotaState: range.quotaState,
          quotaReason: range.quotaReason,
          ...(range.durationMinutes === undefined
            ? {}
            : { durationMinutes: range.durationMinutes, plannedResetAt: range.plannedResetAt }),
        }
      : {}),
  };
}
