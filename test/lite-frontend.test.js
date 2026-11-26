import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { renderDatePickerHtml, selectDateRange } from "../public/calendar.js";
import { assignChartPatternSlots } from "../public/lite/app.js";
import {
  filterPeriodComparisonRows,
  nextComparisonSort,
  renderPeriodComparisonTableHtml,
} from "../public/dashboard-render.js";
import { renderHomesHtml, renderSourceOptionsHtml } from "../public/source-view.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server-lite.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const html = read("lite/index.html");
const css = read("lite/styles.css");
const app = read("lite/app.js");

function moduleEdges(source, name) {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const edges = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) edges.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.equal(node.arguments.length, 1, `${name}: ambiguous dynamic import`);
      assert.ok(ts.isStringLiteralLike(node.arguments[0]), `${name}: computed dynamic import`);
      edges.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return edges;
}

function assertPureGraph(entry, sources = null) {
  const seen = new Set();
  const visit = (name) => {
    assert.doesNotMatch(
      name,
      /(?:^|\/)(?:app|app-state|i18n|waifu[^/]*|pricing[^/]*|achievements?[^/]*|share[^/]*|skin[^/]*)\.js$/i,
    );
    assert.ok(!name.startsWith("../"), `escaped public root: ${name}`);
    if (seen.has(name)) return;
    seen.add(name);
    for (const edge of moduleEdges(sources ? sources[name] : read(name), name)) {
      assert.ok(edge.startsWith("."), `${name}: external dependency ${edge}`);
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(name), edge)));
    }
  };
  // Lite owns these two entry modules; their transitive dependencies must remain pure.
  seen.add(entry);
  for (const edge of moduleEdges(sources ? sources[entry] : read(entry), entry)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), edge));
    if (target === "lite/app-state.js") {
      seen.add(target);
      for (const stateEdge of moduleEdges(sources ? sources[target] : read(target), target)) {
        visit(path.posix.normalize(path.posix.join("lite", stateEdge)));
      }
    } else visit(target);
  }
  return seen;
}

function assertFlatGray(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const declaration of text.matchAll(
    /(?:^|[;{])\s*(?:color|background-color|border(?:-(?:top|right|bottom|left))?-color|outline-color|accent-color)\s*:\s*([^;}]+)/gi,
  )) {
    assert.match(
      declaration[1].trim(),
      /^(?:var\(--[\w-]+\)|#[\da-f]+|rgba?\([^)]+\)|transparent|currentColor|black|white|inherit|initial|unset)(?:\s*!important)?$/i,
      declaration[0],
    );
  }
  assert.doesNotMatch(text, /@import|(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(|url\s*\(/i);
  assert.doesNotMatch(
    text,
    /(?:box-shadow|text-shadow|filter|backdrop-filter|mask-image)\s*:\s*(?!none\s*[;}])[^;}]+/i,
  );
  for (const match of text.matchAll(/#([\da-f]{3,8})\b/gi)) {
    const hex = match[1];
    assert.ok([3, 4, 6, 8].includes(hex.length), `invalid hex ${match[0]}`);
    const channels = hex.length < 5 ? hex.slice(0, 3).split("") : hex.slice(0, 6).match(/../g);
    assert.ok(
      channels.every((channel) => channel === channels[0]),
      `colored value ${match[0]}`,
    );
  }
  for (const match of text.matchAll(/rgba?\(([^)]+)\)/gi)) {
    const channels = match[1]
      .trim()
      .split(/[\s,/]+/)
      .slice(0, 3)
      .map(Number);
    assert.ok(channels.length === 3 && channels.every((v) => Number.isFinite(v) && v === channels[0]), match[0]);
  }
  assert.doesNotMatch(text, /\b(?:hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i);
}

test("Lite module graph reaches shared locale but no Waifu/cost/assets runtime", () => {
  const graph = assertPureGraph("lite/app.js");
  assert.ok(graph.has("locale.js"));
  assert.ok(graph.has("dashboard-view-utils.js"));
  assert.ok(graph.has("dashboard-runtime.js"));
  assert.ok(graph.has("calendar.js"));
});

test("graph guard rejects transitive re-exports, lazy Waifu imports and computed imports", () => {
  for (const injected of ['export * from "./i18n.js";', 'import("./pricing-models.js");', "import(target);"]) {
    assert.throws(() =>
      assertPureGraph("lite/app.js", { "lite/app.js": 'import "../shared.js";', "shared.js": injected }),
    );
  }
});

test("Lite builds six cards and two timeline modes, with no removed controls", () => {
  assert.equal([...html.matchAll(/<article class="metric">/g)].length, 6);
  for (const id of ["totalTokens", "inputTokens", "cachedTokens", "outputTokens", "reasoningTokens", "cacheHitRate"]) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, "g"))].length, 1);
  }
  assert.deepEqual(
    [...html.matchAll(/data-timeline-mode="([^"]+)"/g)].map((m) => m[1]),
    ["channel", "model"],
  );
  assert.doesNotMatch(
    html,
    /id="(?:themeToggle|calendarZone[^" ]*|share[^" ]*|pricing[^" ]*|achievement[^" ]*|cost[^" ]*)"/i,
  );
  assert.match(html, /href="\/lite\/styles\.css"/);
  assert.doesNotMatch(html, /href="\/styles\.css"/);
});

test("first frame fixes dark and preserves only the locale preference", () => {
  const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.match(bootstrap, /dataset\.theme = "dark"/);
  assert.deepEqual(
    [...bootstrap.matchAll(/localStorage\.getItem\("([^"]+)"\)/g)].map((m) => m[1]),
    ["codexUsageLocale"],
  );
  assert.doesNotMatch(
    app,
    /codexUsageTheme|codexUsageCalendarZone|calendarZone=(?:utc|local)|spotlight|materialmask|--mouse|--pointer/i,
  );
});

test("CSS and canvas palette are flat grayscale; pointer handling retains tooltip behavior", () => {
  assertFlatGray(css);
  assertFlatGray(app.match(/#[\da-f]{6}\b/gi).join(" "));
  assert.match(css, /-webkit-text-stroke:/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(app, /timelineChart\.addEventListener\("pointermove"/);
  assert.match(app, /showTimelineTooltip\(row, event\)/);
});

test("visible series use distinct patterns even when filters bring back previously colliding names", () => {
  const slots = new Map();
  const names = Array.from({ length: 19 }, (_, i) => `model-${i}`);
  assignChartPatternSlots(names, slots);
  assert.equal(new Set(names.slice(0, 16).map((name) => slots.get(name))).size, 16);
  assert.equal(slots.get(names[0]), slots.get(names[16]));
  const active = ["new", names[16], names[0], names[12]];
  const remembered = slots.get(names[12]);
  assignChartPatternSlots(active, slots);
  assert.equal(new Set(active.map((name) => slots.get(name))).size, active.length);
  assert.equal(slots.get(names[12]), remembered);
  const previous = new Map(slots);
  assignChartPatternSlots([...active].reverse(), slots);
  assert.deepEqual(slots, previous);
});

test("Lite uses matching patterns in narrow stacked bars, legend and details and can trace one model", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    return t.skip("No local browser runtime");
  }
  const fixture = createLiteEditionFixture();
  let browser;
  const server = createUsageServer(fixture.options);
  t.after(async () => {
    await browser?.close();
    await server.close();
    fixture.close();
  });
  for (const [index, file] of fixture.rolloutFiles.entries()) {
    const lines = fs.readFileSync(file, "utf8").trim().replace("gpt-6-sol", `model-${index}`).split("\n");
    const event = lines.pop();
    for (let day = 1; day <= 16; day++) lines.push(event.replace("11-16", `11-${String(day).padStart(2, "0")}`));
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
  }
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('[data-preset="all"]').click();
  await page.locator('[data-timeline-mode="model"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#timelineLegend button").length === 4);
  const { legend, details } = await page.evaluate(() => ({
    legend: Array.from(document.querySelectorAll(".timeline-legend-swatch"), (node) => node.style.background),
    details: Array.from(document.querySelectorAll(".bar-fill"), (node) => node.style.background),
  }));
  assert.equal(new Set(legend).size, 4);
  assert.deepEqual(legend, details);
  const canvas = page.locator("#timelineChart");
  const barShades = await canvas.evaluate((node) => {
    const ratio = node.width / node.clientWidth;
    const pixels = node
      .getContext("2d")
      .getImageData(66 * ratio, 20 * ratio, node.width - 86 * ratio, node.height - 64 * ratio).data;
    const shades = new Set();
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] === 255) shades.add(pixels[i]);
    return [...shades];
  });
  for (const shade of [0xde, 0x73, 0xf5, 0x40]) assert.ok(barShades.includes(shade), `missing fill/ink level ${shade}`);
  const pixels = () => canvas.evaluate((node) => node.toDataURL());
  const before = await pixels();
  const key = page.locator("#timelineLegend button").nth(1);
  await key.press("Enter");
  assert.equal(await key.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#detailList .series-muted").count(), 3);
  assert.notEqual(await pixels(), before);
  await key.press("Space");
  assert.equal(await pixels(), before);
  assert.equal(await page.locator("#detailList .series-muted").count(), 0);
});

test("style guard rejects color, shadow, gradient and material image counterexamples", () => {
  for (const injected of [
    "color:red",
    "color:#aabbcc",
    "color:rgba(1,2,3,.5)",
    "box-shadow:0 0 3px #fff",
    "filter:url(#other)",
    "background:linear-gradient(#111,#222)",
    'background:url("skin.png")',
  ]) {
    assert.throws(() => assertFlatGray(`.bad{${injected}}`), injected);
  }
});

test("calendar keeps ordered cross-month endpoints and closes a same-day range", () => {
  assert.deepEqual(selectDateRange({ startDate: "2026-12-01", field: "end" }, "2026-11-30"), {
    startDate: "2026-11-30",
    endDate: "2026-12-01",
    field: "start",
    complete: true,
  });
  const same = selectDateRange({ startDate: "2026-11-30", field: "end" }, "2026-11-30");
  const sameHtml = renderDatePickerHtml({ ...same, viewDate: new Date(2026, 10, 1) });
  assert.match(sameHtml, /data-date="2026-11-30" class="[^"]*range-start range-end"/);
  const crossHtml = renderDatePickerHtml({
    viewDate: new Date(2026, 10, 1),
    startDate: "2026-11-30",
    endDate: "2026-12-01",
  });
  assert.match(crossHtml, /data-date="2026-12-01" class="date-picker-day outside-month selected range-end"/);
  assert.equal([...crossHtml.matchAll(/data-date="/g)].length, 42);
});

test("period search/sort/detail preserve escaped names, exact totals and missing-detail evidence", () => {
  const row = (key, total) => ({
    key,
    name: key,
    periods: { today: { total }, all: { total, inputUnavailableTokens: total } },
  });
  const rows = filterPeriodComparisonRows([row("zero", 0), row("ALPHA<script>", 9), row("beta", 20)]);
  assert.equal(rows.length, 2);
  const descending = nextComparisonSort(null, "all");
  const ascending = nextComparisonSort(descending, "all");
  const table = renderPeriodComparisonTableHtml(rows, { sort: ascending });
  assert.ok(table.indexOf("alpha&lt;script&gt;") < table.indexOf("beta"));
  assert.match(table, /aria-sort="ascending"/);
  const filtered = renderPeriodComparisonTableHtml(rows, {
    query: "ALPHA",
    expanded: { kind: "model", key: "ALPHA<script>", period: "all" },
    totals: { all: { total: 29 } },
  });
  assert.match(filtered, /comparison-detail-row/);
  assert.match(filtered, /明细未提供/);
  assert.match(filtered, /title="29"/);
  assert.doesNotMatch(filtered, /<script>|>beta</);
  assert.match(renderPeriodComparisonTableHtml(rows, { query: "missing" }), /没有匹配/);
});

test("source exclusions remain visible, escaped and keyboard-native", () => {
  const homes = [{ id: "own", label: "<fixture>", path: 'E:/fixture/"unsafe"', kind: "codex" }];
  const options = renderSourceOptionsHtml(homes, ["own"]);
  assert.match(options, /type="checkbox" data-source-id="own"/);
  assert.doesNotMatch(options, / checked|<fixture>/);
  assert.match(options, /&lt;fixture&gt;/);
  assert.match(options, /不计入统计/);
  assert.match(renderHomesHtml(homes, { excludedIds: ["own"] }), /home-row excluded/);
});
