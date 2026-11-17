const DAY_MS = 86_400_000;
const formatters = new Map();

/** Validate and return a fixed IANA name; callers must resolve local before persisting. */
export function validateAchievementTimeZone(zone) {
  if (typeof zone !== "string" || !zone || zone.toLowerCase() === "local" || /^[+-]/.test(zone)) {
    throw new RangeError("Achievement time zone must be a fixed IANA name or UTC");
  }
  return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
}

function formatter(zone) {
  if (!formatters.has(zone)) {
    const timeZone = validateAchievementTimeZone(zone);
    formatters.set(
      zone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        calendar: "iso8601",
        numberingSystem: "latn",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    );
  }
  return formatters.get(zone);
}

function timestampMs(timestamp) {
  const value =
    timestamp instanceof Date
      ? timestamp.getTime()
      : typeof timestamp === "number"
        ? timestamp
        : typeof timestamp === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)
          ? Date.parse(timestamp)
          : NaN;
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
    throw new RangeError("Invalid achievement timestamp; use UTC milliseconds or an absolute ISO timestamp");
  }
  return value;
}

function localOrdinal(timestamp, calendar) {
  const parts = calendar.formatToParts(timestamp);
  const part = (type) => Number(parts.find((entry) => entry.type === type).value);
  const date = new Date(0);
  date.setUTCFullYear(part("year"), part("month") - 1, part("day"));
  return date.getTime() / DAY_MS;
}

function dateKey(ordinal) {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

function keysForOrdinal(ordinal) {
  const day = dateKey(ordinal);
  return { day, week: dateKey(ordinal - ((((ordinal + 3) % 7) + 7) % 7)), month: day.slice(0, 7), ordinal };
}

export function achievementCalendarKeys(timestamp, zone) {
  return keysForOrdinal(localOrdinal(timestampMs(timestamp), formatter(zone)));
}

function dayBoundary(ordinal, calendar) {
  // Find the first real instant of a local date, including missing/repeated midnights.
  let low = (ordinal - 3) * DAY_MS;
  let high = (ordinal + 3) * DAY_MS;
  while (low < high) {
    const middle = Math.floor(low + (high - low) / 2);
    if (localOrdinal(middle, calendar) < ordinal) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Half-open UTC millisecond bounds; a local day need not last 24 hours.
 * @param {number|string|Date} timestamp
 * @param {string} zone
 * @param {"day"|"week"|"month"} period
 */
export function achievementPeriodBounds(timestamp, zone, period) {
  const calendar = formatter(zone);
  const ordinal = localOrdinal(timestampMs(timestamp), calendar);
  const keys = keysForOrdinal(ordinal);
  let first;
  let next;
  if (period === "day") {
    first = ordinal;
    next = first + 1;
  } else if (period === "week") {
    first = Date.parse(`${keys.week}T00:00:00Z`) / DAY_MS;
    next = first + 7;
  } else if (period === "month") {
    const date = new Date(`${keys.month}-01T00:00:00Z`);
    first = date.getTime() / DAY_MS;
    date.setUTCMonth(date.getUTCMonth() + 1);
    next = date.getTime() / DAY_MS;
  } else {
    throw new RangeError("Achievement period must be day, week or month");
  }
  return { start: dayBoundary(first, calendar), end: dayBoundary(next, calendar) };
}

/** Latest ended period keys, stable throughout the current day/week/month. */
export function closedAchievementPeriods(cutoff, zone) {
  const closed = (period) => {
    const { start } = achievementPeriodBounds(cutoff, zone, period);
    return achievementCalendarKeys(start - 1, zone)[period];
  };
  return { day: closed("day"), week: closed("week"), month: closed("month") };
}
