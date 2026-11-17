import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeRecentValue,
  parseRecentValue,
  addCalendarDays,
  nextPresetState,
  nextQuotaPresetState,
  nextRecentState,
  shortTimelineLabel,
  timelineSlotRangeTitle,
  timelineAxisLabels,
  renderTokenMetricHtml,
  comparisonLabel,
  renderComparisonHtml,
  usageTooltipPosition,
} from "../public/dashboard-view-utils.js";
import { setLocale, getLocale } from "../public/locale.js";
import { calendarDate } from "../public/calendar.js";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";

test("recent normalization and parsing retain named, numeric and invalid ranges", () => {
  assert.equal(normalizeRecentValue(" 14 "), "14天");
  assert.deepEqual(parseRecentValue("14"), { days: 14 });
  assert.deepEqual(parseRecentValue("2周"), { days: 14 });
  assert.deepEqual(parseRecentValue("2个月"), { months: 2 });
  assert.deepEqual(parseRecentValue("半年"), { months: 6 });
  assert.deepEqual(parseRecentValue("一年"), { months: 12 });
  assert.deepEqual(parseRecentValue("上个月"), { named: "上个月" });
  for (const value of ["", "0天", "-1天", "unknown"]) assert.equal(parseRecentValue(value), null);
});

test("preset transitions use explicit input and retain legacy missing-preset behavior", () => {
  const current = { preset: "quota_week", lastQuotaPreset: "quota_week" };
  assert.deepEqual(nextPresetState(current, "today", current.preset), {
    preset: "today",
    bucket: "hour",
    lastQuotaPreset: "quota_week",
  });
  assert.deepEqual(nextPresetState({}, "week", "today"), { preset: "week", bucket: "day" });
  assert.deepEqual(nextPresetState({}, "today", "quota_week"), {
    preset: "today",
    bucket: "hour",
    lastQuotaPreset: undefined,
  });
  assert.equal(nextQuotaPresetState(current).preset, "quota_5h");
  assert.equal(nextQuotaPresetState({ preset: "today", lastQuotaPreset: "quota_week" }).preset, "quota_week");
  assert.deepEqual(nextRecentState(current, "上一个5h"), {
    preset: "recent",
    recentValue: "上一个5h",
    bucket: "quota_30m",
  });
  assert.deepEqual(nextRecentState(current, "1天"), { preset: "recent", recentValue: "1天", bucket: "hour" });
  assert.deepEqual(current, { preset: "quota_week", lastQuotaPreset: "quota_week" });
});

test("calendar shifts retain calendar days across UTC month ends and 23/25-hour DST days", () => {
  const date = new Date("2026-01-31T12:00:00Z");
  assert.equal(addCalendarDays(date, 1, "utc").toISOString(), "2026-02-01T12:00:00.000Z");
  assert.equal(date.toISOString(), "2026-01-31T12:00:00.000Z");
  const spring = calendarDate(2026, 2, 8, "America/New_York");
  const autumn = calendarDate(2026, 10, 1, "America/New_York");
  assert.equal(addCalendarDays(spring, 1, "America/New_York") - spring, 23 * 3_600_000);
  assert.equal(addCalendarDays(autumn, 1, "America/New_York") - autumn, 25 * 3_600_000);
});

test("axis labels keep the last valid slot, uniform gaps, locale and cross-year identity", () => {
  const previous = getLocale();
  try {
    setLocale("zh-CN", { persist: false });
    const rows = Array.from({ length: 13 }, (_, index) => ({ key: `2026-09-${String(index + 1).padStart(2, "0")}` }));
    const labels = timelineAxisLabels(rows, {
      maxLabels: 4,
      range: { end: "2026-09-11T23:59:59Z", calendarZone: "utc" },
    });
    assert.deepEqual(
      labels.map((label) => label.index),
      [1, 4, 7, 10],
    );
    assert.equal(shortTimelineLabel("2026-09", "month", {}), "9月");
    setLocale("en-US", { persist: false });
    assert.equal(shortTimelineLabel("2026-09", "month", {}), "Sep");
    assert.equal(
      shortTimelineLabel("2025-12", "month", { start: "2025-12-01", end: "2026-01-31", calendarZone: "utc" }),
      "2025-12",
    );
    const hours = Array.from({ length: 24 }, (_, hour) => ({ key: `2026-01-01 ${String(hour).padStart(2, "0")}:00` }));
    assert.equal(
      timelineAxisLabels(hours, {
        bucket: "hour",
        chartWidth: 700,
        range: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T23:59:59Z", calendarZone: "utc" },
      }).length,
      24,
    );
  } finally {
    setLocale(previous, { persist: false });
  }
});

test("slot titles clip week and month coverage to the selected range", () => {
  const previous = getLocale();
  try {
    setLocale("zh-CN", { persist: false });
    assert.equal(
      timelineSlotRangeTitle(
        { key: "2026-03-09" },
        { bucket: "week", start: "2026-03-11T00:00:00Z", end: "2026-03-12T23:59:59Z", calendarZone: "utc" },
      ),
      "2026-03-11 至 2026-03-12",
    );
    setLocale("en-US", { persist: false });
    assert.equal(
      timelineSlotRangeTitle({ key: "2026-04" }, { bucket: "month", calendarZone: "utc" }),
      "2026-04-01 to 2026-04-30",
    );
    assert.equal(timelineSlotRangeTitle({ key: "2026-04-01" }, { bucket: "day" }), null);
  } finally {
    setLocale(previous, { persist: false });
  }
});

test("comparison strips keep three frames, distinguish zero from unavailable and escape labels", () => {
  assert.equal(comparisonLabel(null, "week"), "较上周");
  const unavailable = renderComparisonHtml(null, null, "week");
  assert.equal((unavailable.match(/<article /g) ?? []).length, 3);
  assert.match(unavailable, /上周 tokens/);
  assert.equal((unavailable.match(/<strong>—<\/strong>/g) ?? []).length, 3);
  const zero = renderComparisonHtml(
    {
      label: "较昨日",
      previousRange: {},
      previousTotals: { total: 0 },
      totalDelta: 0,
      averageDelta: 0,
      percentChange: Infinity,
    },
    null,
    "today",
  );
  assert.equal((zero.match(/>0<\/strong>/g) ?? []).length, 3);
  assert.match(zero, /无基准/);
  assert.doesNotMatch(renderComparisonHtml({ label: "<script>" }, null, "today"), /<script>/);
  assert.equal(renderTokenMetricHtml(1e9), '1.00<small class="metric-unit">B</small>');
});

test("measured tooltips stay within every viewport edge", () => {
  for (const [x, y] of [
    [0, 0],
    [319, 239],
    [-20, -20],
    [350, 270],
    [160, 120],
  ]) {
    const { left, top } = usageTooltipPosition(x, y, 268, 224, 320, 240);
    assert.ok(left >= 8 && left + 268 <= 312);
    assert.ok(top >= 8 && top + 224 <= 232);
  }
});

test("pure helpers execute with app state, Waifu copy, pricing and achievements prohibited", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "dashboard-view-utils-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  const probe = createLiteBoundaryProbe(directory, {
    forbiddenModules: [
      "public/app.js",
      "public/lite/app.js",
      "public/app-state.js",
      "public/lite/app-state.js",
      "public/i18n.js",
      "public/waifu-locale.js",
      "public/pricing-models.js",
      "public/waifu-timeline.js",
      "public/share-card.js",
      "public/achievement-dialog.js",
      "src/pricing.js",
    ],
  });
  const script = `import assert from 'node:assert/strict';
    const v=await import(${JSON.stringify(new URL("../public/dashboard-view-utils.js", import.meta.url).href)});
    assert.equal(v.normalizeRecentValue('7'),'7天');
    assert.equal(v.nextPresetState({preset:'quota_week'},'today','quota_week').lastQuotaPreset,'quota_week');
    assert.match(v.renderComparisonHtml(null,null,'week'),/上周 tokens/);
    assert.equal(v.timelineAxisLabels([{key:'2026-01-01'}],{bucket:'day'}).length,1);
    process.stdout.write('pure');`;
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: probe.env,
      encoding: "utf8",
      windowsHide: true,
    }),
    "pure",
  );
  assert.equal(
    probe.read().some((entry) => entry.forbidden),
    false,
  );
});
