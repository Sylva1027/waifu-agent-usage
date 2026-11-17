import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { drawTimelineCanvas, tokenTimelineSeries, timelineTokenAriaLabel } from "../public/dashboard-view-utils.js";
import { getLocale, setLocale } from "../public/locale.js";

function fixture() {
  const rects = [];
  const texts = [];
  const strokes = [];
  const reads = [];
  const context = {
    clearRect() {},
    scale() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      strokes.push({ ...this.__codexUsageChartDraw, color: this.strokeStyle, width: this.lineWidth });
    },
    fillRect(...args) {
      rects.push({ color: this.fillStyle, args });
    },
    fillText(text, ...args) {
      texts.push({ text, args });
    },
    save() {},
    translate() {},
    rotate() {},
    restore() {},
    measureText() {
      return { width: 20 };
    },
  };
  const canvas = {
    dataset: {},
    getContext: () => context,
    get clientWidth() {
      reads.push("width");
      return 960;
    },
    get clientHeight() {
      reads.push("height");
      return 320;
    },
    set width(value) {
      reads.push(["backingWidth", value]);
    },
    set height(value) {
      reads.push(["backingHeight", value]);
    },
  };
  const options = {
    styles: { getPropertyValue: () => "" },
    palette: { line: "#777777", text: "#cccccc", fallback: "#aaaaaa" },
    outline: { roleId: "chart.axis-line", lineWidth: 1 },
    ratio: 2,
    range: null,
    bucket: "day",
    messages: { aria: "Tokens", empty: "Empty" },
    timelineBars: new WeakMap(),
    drawnChartBox: new WeakMap(),
  };
  return { context, canvas, options, rects, texts, strokes, reads };
}

function tokenSeries(mode = "model") {
  return tokenTimelineSeries(mode, {
    channelRows: [],
    channelColors: new Map(),
    modelRows: [],
    modelColorsByName: new Map([
      ["small", "#777777"],
      ["large", "#cccccc"],
    ]),
    modelColor: () => "#eeeeee",
    channelColor: "#aaaaaa",
    formatAxis: String,
  });
}

test("shared renderer uses explicit gray palette, exact geometry and ordered stacks without globals", () => {
  const f = fixture();
  const row = {
    key: "2026-11-16",
    total: { total: 100 },
    models: [
      { name: "small", total: { total: 30 } },
      { name: "large", total: { total: 70 } },
    ],
  };
  const original = structuredClone(row);
  drawTimelineCanvas(f.canvas, [row], { ...f.options, series: tokenSeries() });
  assert.deepEqual(f.rects, [
    { color: "#cccccc", args: [488, 96, 30, 182] },
    { color: "#777777", args: [488, 18, 30, 78] },
  ]);
  assert.deepEqual(row, original, "sorting must not mutate source model order");
  assert.deepEqual(f.reads, ["width", "height", ["backingWidth", 1920], ["backingHeight", 640]]);
  assert.deepEqual(f.options.drawnChartBox.get(f.canvas), { width: 960, height: 320 });
  assert.deepEqual(f.options.timelineBars.get(f.canvas), [{ x: 64, y: 18, width: 878, height: 260, row }]);
  assert.equal(f.strokes[0].color, "#777777");
  assert.equal(f.canvas.dataset.chartAriaLabel, "Tokens");
});

test("focusing a series fades other fills without changing the chart geometry or axes", () => {
  const f = fixture();
  const row = {
    key: "2026-11-16",
    total: { total: 100 },
    models: [
      { name: "small", total: { total: 1 } },
      { name: "large", total: { total: 99 } },
    ],
  };
  const alphas = [];
  const fillRect = f.context.fillRect;
  f.context.fillRect = function (...args) {
    alphas.push(this.globalAlpha);
    fillRect.apply(this, args);
  };
  const options = { ...f.options, series: tokenSeries() };
  drawTimelineCanvas(f.canvas, [row], options);
  const before = { rects: f.rects.splice(0), texts: f.texts.splice(0) };
  assert.deepEqual(alphas.splice(0), [1, 1]);
  drawTimelineCanvas(f.canvas, [row], { ...options, focusedSeries: "small" });
  assert.deepEqual(f.rects, before.rects);
  assert.deepEqual(f.texts, before.texts);
  assert.deepEqual(alphas, [0.25, 1]);
  assert.equal(f.context.globalAlpha, 1);
});

test("generic series has no hidden unit conversion and preserves axis outline metadata on failure", () => {
  const f = fixture();
  const previous = { owned: "caller" };
  f.context.__codexUsageChartDraw = previous;
  f.context.stroke = function () {
    assert.deepEqual(this.__codexUsageChartDraw, {
      roleId: "custom.axis",
      points: [
        [64, 18],
        [64, 278],
        [942, 278],
      ],
    });
    throw new Error("injected stroke failure");
  };
  assert.throws(
    () => drawTimelineCanvas(f.canvas, [], { ...f.options, outline: { roleId: "custom.axis", lineWidth: 2 } }),
    /stroke failure/,
  );
  assert.equal(f.context.__codexUsageChartDraw, previous);
  assert.deepEqual(f.options.timelineBars.get(f.canvas), []);

  f.context.stroke = () => {};
  drawTimelineCanvas(f.canvas, [{ key: "2026-11-16" }], {
    ...f.options,
    series: {
      value: () => 2.5,
      segments: () => [{ name: "unit", value: 2.5, color: "#eeeeee" }],
      formatAxis: (value) => `unit:${value}`,
    },
  });
  assert.ok(f.texts.some(({ text }) => text === "unit:2.5"));
  assert.ok(f.texts.some(({ text }) => text === "unit:0"));
});

test("empty/unavailable views do not query series and reset hit targets and aria", () => {
  const f = fixture();
  const series = {
    value() {
      throw new Error("must not inspect rows");
    },
  };
  drawTimelineCanvas(f.canvas, [], {
    ...f.options,
    series,
    messages: { aria: "Tokens", empty: "No quota", emptyAria: true },
  });
  assert.equal(f.canvas.dataset.chartAriaLabel, "No quota");
  drawTimelineCanvas(f.canvas, [{ key: "stale" }], {
    ...f.options,
    series,
    messages: { aria: "Tokens", unavailable: "Restart service" },
  });
  assert.equal(f.canvas.dataset.chartAriaLabel, "Restart service");
  assert.deepEqual(f.options.timelineBars.get(f.canvas), []);
  assert.equal(f.rects.length, 0);
});

test("token adapter ignores foreign fields and rejects an unsupported extension", () => {
  const f = fixture();
  const row = {
    key: "2026-11-16",
    total: { total: 100 },
    models: [{ name: "large", total: { total: 100 } }],
    costEstimate: { totalUsd: 999999 },
  };
  drawTimelineCanvas(f.canvas, [row, { ...row, future: true }], { ...f.options, series: tokenSeries() });
  assert.equal(f.rects.length, 1, "future rows reserve a slot without visible bars or hit targets");
  assert.equal(f.options.timelineBars.get(f.canvas).length, 1);
  assert.ok(f.texts.some(({ text }) => text === "100"));
  assert.throws(() => tokenSeries("cost"), /unsupported timeline mode/);
});

test("both apps delegate canvas drawing to the existing shared module; only Waifu owns extension hooks", () => {
  for (const [relative, waifu] of [
    ["../public/app.js", true],
    ["../public/lite/app.js", false],
  ]) {
    const file = new URL(relative, import.meta.url);
    const source = ts.createSourceFile(file.pathname, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const draw = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "drawTimeline");
    assert.ok(draw);
    const body = draw.getText(source);
    assert.match(body, /drawTimelineCanvas\(canvas, rows,/);
    assert.doesNotMatch(body, /\.getContext\(|\.fillRect\(|\.measureText\(|\.stroke\(/);
    assert.equal(body.includes("timelineCostSegments"), waifu);
  }
});

test("shared accessibility label preserves local calendar dates in both languages", () => {
  const locale = getLocale();
  try {
    const range = { calendarZone: "utc", start: "2026-11-30T00:00:00Z", end: "2026-12-01T00:00:00Z" };
    setLocale("zh-CN");
    assert.match(timelineTokenAriaLabel(range, "model"), /按模型堆叠 tokens，统计范围 2026-11-30 至 2026-12-01/);
    setLocale("en-US");
    assert.match(timelineTokenAriaLabel(range, "channel"), /tokens stacked by source, from 2026-11-30 to 2026-12-01/);
  } finally {
    setLocale(locale);
  }
});
