import assert from "node:assert/strict";
import test from "node:test";
import { calendarDate, calendarParts, dateKey, rangeCalendarZone } from "../public/calendar.js";
import { coveredCalendarDays } from "../public/range-metrics.js";
import { shareCardFilename } from "../public/share-card-data.js";
import { timelineAxisLabels, timelineSlotRangeTitle } from "../public/app.js";

test("service calendar parts and filenames use explicit IANA rather than the browser's local day", () => {
  const date = new Date("2026-01-01T01:30:00Z");
  assert.equal(dateKey(date, "America/Los_Angeles"), "2025-12-31");
  assert.equal(dateKey(date, "Asia/Tokyo"), "2026-01-01");
  assert.equal(calendarParts(date, "America/Los_Angeles").hour, 17);
  assert.equal(calendarParts(date, "America/Los_Angeles").weekday, 3);
  const range = {
    preset: "quota_5h",
    quotaPreset: "quota_5h",
    quotaWindow: true,
    calendarZone: "local",
    timeZone: "America/Los_Angeles",
    start: date.toISOString(),
    end: "2026-01-01T06:29:59.999Z",
  };
  assert.equal(shareCardFilename(range), "usage_quota_5h_20251231_1730-20251231_2230.png");
  assert.equal(
    rangeCalendarZone({ ...range, calendarZone: "utc" }),
    "utc",
    "Old explicit internal UTC ranges keep their own semantics",
  );
});

test("service calendar boundaries preserve DST short/long days, leap dates and missing midnight", () => {
  const start = calendarDate(2026, 2, 8, "America/New_York"),
    next = calendarDate(2026, 2, 9, "America/New_York");
  assert.equal(start.toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(next - start, 23 * 3600000);
  assert.equal(
    calendarDate(2026, 10, 2, "America/New_York") - calendarDate(2026, 10, 1, "America/New_York"),
    25 * 3600000,
  );
  assert.equal(dateKey(calendarDate(2024, 1, 29, "Asia/Tokyo"), "Asia/Tokyo"), "2024-02-29");
  assert.equal(dateKey(calendarDate(2026, 8, 6, "America/Santiago"), "America/Santiago"), "2026-09-06");
  const range = {
    start: start.toISOString(),
    end: new Date(next.getTime() - 1).toISOString(),
    asOf: next.toISOString(),
    calendarZone: "local",
    timeZone: "America/New_York",
  };
  assert.equal(coveredCalendarDays(range), 1);
});

test("timeline quota clocks and covered week/month labels agree with the service calendar", () => {
  const instant = "2026-01-01T01:30:00Z";
  const range = {
    preset: "quota_5h",
    bucket: "quota_30m",
    quotaWindow: true,
    calendarZone: "local",
    timeZone: "America/Los_Angeles",
    start: instant,
    end: "2026-01-01T06:29:59.999Z",
  };
  const labels = timelineAxisLabels([{ key: String(Date.parse(instant)), total: 1 }], { bucket: "quota_30m", range });
  assert.deepEqual(labels, [{ index: 0, label: "17:30" }]);
  const monthRange = {
    bucket: "month",
    calendarZone: "local",
    timeZone: "America/Los_Angeles",
    start: "2026-01-01T08:00:00Z",
    end: "2026-01-25T07:59:59Z",
  };
  assert.equal(timelineSlotRangeTitle({ key: "2026-01" }, monthRange), "2026-01-01 至 2026-01-24");
  assert.equal(
    timelineSlotRangeTitle({ key: "2025-12-29" }, { ...monthRange, bucket: "week" }),
    "2026-01-01 至 2026-01-04",
  );
});
