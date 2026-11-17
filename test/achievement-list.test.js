import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ACHIEVEMENT_CONTENT, achievementUi, categoryOrder } from "../public/achievement-content.js";
import {
  achievementBadge,
  achievementPercent,
  achievementRows,
  renderAchievementList,
  visibleAchievements,
} from "../public/achievement-list.js";

const instant = "2026-11-17T01:00:00.000Z";
const ids = (rows) => rows.map((row) => row.id);
function row(id, overrides = {}) {
  return {
    id,
    category: "模型工具",
    tiered: true,
    unit: "模型",
    levels: ["1", "10", "100"],
    thresholds: ["1", "10", "100"],
    zh: { name: "中文名称", description: "中文条件", flavor: "中文解说" },
    en: { name: "English Name", description: "English condition", flavor: "English flavor" },
    observedValue: "5",
    nextTarget: "10",
    highestEarned: "bronze",
    earnedAt: { bronze: instant, silver: null, gold: null },
    updatedAt: instant,
    ...overrides,
  };
}
function snapshot() {
  return {
    state: "ready",
    timeZone: "Asia/Shanghai",
    rows: ACHIEVEMENT_CONTENT.map((content) => ({
      id: content.id,
      observedValue: "0",
      nextTarget: content.thresholds[0],
      highestEarned: null,
      earnedAt: content.tiered ? { bronze: null, silver: null, gold: null } : { stone: null },
      updatedAt: null,
    })),
  };
}

test("ready snapshots merge by ID in approved catalog order and preserve API precision and dates", () => {
  const input = snapshot();
  const api = input.rows[0];
  Object.assign(api, {
    observedValue: "900719925474099312345678901234567890",
    highestEarned: "gold",
    nextTarget: null,
    earnedAt: { bronze: "2026-11-15T01:00:00Z", silver: instant, gold: instant },
    updatedAt: instant,
    category: "untrusted category",
    zh: { name: "untrusted name" },
    sample: { percent: 0 },
  });
  input.rows.reverse();
  const before = structuredClone(input);
  const actual = achievementRows(input);
  assert.deepEqual(ids(actual), ids(ACHIEVEMENT_CONTENT));
  assert.equal(actual.length, 42);
  for (const field of ["observedValue", "nextTarget", "highestEarned", "earnedAt", "updatedAt"])
    assert.deepEqual(actual[0][field], api[field]);
  for (const field of ["category", "tiered", "unit", "levels", "thresholds", "zh", "en"])
    assert.deepEqual(actual[0][field], ACHIEVEMENT_CONTENT[0][field]);
  assert.equal(Object.hasOwn(actual[0], "sample"), false);
  assert.deepEqual(input, before);
});

test("preparing, absent and incomplete snapshots remain unavailable instead of showing false zeroes", () => {
  const ready = snapshot();
  for (const input of [
    null,
    undefined,
    {},
    { ...ready, state: "preparing" },
    { state: "preparing", rows: null },
    { ...ready, rows: null },
    { ...ready, rows: [] },
    { ...ready, rows: ready.rows.slice(1) },
    { ...ready, rows: [...ready.rows.slice(1), ready.rows[1]] },
    { ...ready, rows: [...ready.rows, { id: "A40" }] },
  ])
    assert.equal(achievementRows(input), null);
  const actual = achievementRows(ready);
  assert.ok(actual.every((entry) => entry.observedValue === "0" && entry.highestEarned === null));
  assert.deepEqual(visibleAchievements(actual), []);
});

test("incomplete or lossy API fields are not accepted as ready rows", () => {
  for (const patch of [
    { observedValue: undefined },
    { observedValue: 9007199254740992 },
    { observedValue: "-1" },
    { observedValue: "1e20" },
    { nextTarget: "0" },
    { nextTarget: undefined },
    { nextTarget: null },
    { highestEarned: undefined },
    { highestEarned: "stone" },
    { earnedAt: null },
    { updatedAt: undefined },
  ]) {
    const input = snapshot();
    Object.assign(input.rows[0], patch);
    assert.equal(achievementRows(input), null, JSON.stringify(patch));
  }
});

test("adapter consumes the isolated production API capture without sample progress", async () => {
  const capture = JSON.parse(
    await readFile(new URL("./fixtures/achievements/api-examples.json", import.meta.url), "utf8"),
  );
  const actual = achievementRows(capture.initial.body);
  assert.equal(actual.length, 42);
  assert.equal(actual.find((entry) => entry.id === "A01").observedValue, "0");
  assert.ok(actual.every((entry) => !Object.hasOwn(entry, "sample")));
});

test("recent selects six by date before prioritizing completion and does not mutate inputs", () => {
  const input = [
    row("old-gold", { highestEarned: "gold", nextTarget: null, updatedAt: "2026-11-01T00:00:00Z" }),
    ...Array.from({ length: 6 }, (_, index) => row(`new-${index}`, { updatedAt: `2026-11-${17 - index}T00:00:00Z` })),
    row("locked", { highestEarned: null, updatedAt: "2026-11-20T00:00:00Z" }),
  ];
  const before = structuredClone(input);
  assert.deepEqual(ids(visibleAchievements(input)), ["new-0", "new-1", "new-2", "new-3", "new-4", "new-5"]);
  input[4].highestEarned = "gold";
  input[4].nextTarget = null;
  assert.deepEqual(ids(visibleAchievements(input)), ["new-3", "new-0", "new-1", "new-2", "new-4", "new-5"]);
  input[4] = before[4];
  assert.deepEqual(input, before);
});

test("recent groups by the profile calendar day rather than the exact timestamp or machine timezone", () => {
  const input = [
    row("earlier-silver", { highestEarned: "silver", updatedAt: "2026-11-16T18:00:00Z" }),
    row("later-bronze", { updatedAt: "2026-11-17T02:00:00Z" }),
  ];
  assert.deepEqual(ids(visibleAchievements(input, { timeZone: "Asia/Shanghai" })), ["earlier-silver", "later-bronze"]);
  assert.deepEqual(ids(visibleAchievements(input, { timeZone: "UTC" })), ["later-bronze", "earlier-silver"]);
  assert.deepEqual(ids(visibleAchievements(input, { timeZone: "America/Los_Angeles" })), [
    "earlier-silver",
    "later-bronze",
  ]);
});

test("recent same-day ties use grade, exact next-target ratio, category and stable ID", () => {
  const input = [
    row("A09", { category: "项目经营" }),
    row("A08"),
    row("A07"),
    row("silver-low", { highestEarned: "silver", observedValue: "1", nextTarget: "100" }),
    row("bronze-high", { observedValue: "9" }),
    row("gold", { highestEarned: "gold", observedValue: "0", nextTarget: null, category: "故事纪念" }),
    row("stone", {
      tiered: false,
      highestEarned: "stone",
      observedValue: "0",
      nextTarget: null,
      earnedAt: { stone: instant },
      category: "用量规模",
    }),
  ];
  assert.deepEqual(ids(visibleAchievements(input)), ["stone", "gold", "silver-low", "bronze-high", "A07", "A08"]);
});

test("recent compares ratios exactly even when Number merges adjacent integers or percentages", () => {
  const input = [
    row("A01", { observedValue: "9007199254740992", nextTarget: "18014398509481984" }),
    row("A02", { observedValue: "9007199254740993", nextTarget: "18014398509481984" }),
    row("A03", { observedValue: "1", nextTarget: "2" }),
    row("A04", { observedValue: "1000000000000000000001", nextTarget: "2000000000000000000000" }),
  ];
  assert.deepEqual(ids(visibleAchievements(input)), ["A02", "A04", "A01", "A03"]);
  assert.deepEqual(ids(visibleAchievements([row("A02", { observedValue: "2", nextTarget: "4" }), row("A01")])), [
    "A01",
    "A02",
  ]);
});

test("recent uses single-award earnedAt and tiered updatedAt, not ordinary progress changes", () => {
  const input = [
    row("single", {
      tiered: false,
      highestEarned: "stone",
      nextTarget: null,
      earnedAt: { stone: "2026-11-01T00:00:00Z" },
      updatedAt: "2026-11-30T00:00:00Z",
    }),
    ...Array.from({ length: 6 }, (_, index) =>
      row(`tiered-${index}`, { updatedAt: `2026-11-${17 - index}T00:00:00Z`, observedValue: "999999999" }),
    ),
  ];
  assert.deepEqual(ids(visibleAchievements(input)), [
    "tiered-0",
    "tiered-1",
    "tiered-2",
    "tiered-3",
    "tiered-4",
    "tiered-5",
  ]);
});

test("ordinary categories keep catalog order within completed, bronze/silver and locked groups", () => {
  const input = [
    row("locked-2", { highestEarned: null }),
    row("bronze"),
    row("gold", { highestEarned: "gold", nextTarget: null }),
    row("silver", { highestEarned: "silver", observedValue: "0" }),
    row("stone", { tiered: false, highestEarned: "stone", nextTarget: null }),
    row("locked-1", { highestEarned: null }),
    row("other-category", { category: "项目经营" }),
  ];
  const before = structuredClone(input);
  assert.deepEqual(ids(visibleAchievements(input, { category: "模型工具" })), [
    "gold",
    "stone",
    "bronze",
    "silver",
    "locked-2",
    "locked-1",
  ]);
  assert.deepEqual(input, before);
  for (const category of categoryOrder)
    assert.ok(visibleAchievements(input, { category }).every((entry) => entry.category === category));
});

test("search matches either language's approved name or description with case-insensitive English", () => {
  const actual = achievementRows(snapshot());
  const category = "用量规模";
  for (const query of ["Token 远征", "累计使用 50B", "tOkEn eXpEdItIoN", "  Use 50B / 200B / 5T  "])
    assert.deepEqual(ids(visibleAchievements(actual, { category, query })), ["A01"]);
  assert.deepEqual(visibleAchievements(actual, { category, query: "Proud partner of FPL" }), []);
  assert.deepEqual(visibleAchievements(actual, { category: "模型工具", query: "Token Expedition" }), []);
});

test("status and search filter only the selected recent six, without backfilling older matches", () => {
  const input = [
    ...Array.from({ length: 6 }, (_, index) => row(`recent-${index}`)),
    row("older", { updatedAt: "2026-11-01T00:00:00Z", en: { name: "Older unique", description: "", flavor: "" } }),
    row("locked", { highestEarned: null }),
  ];
  assert.deepEqual(visibleAchievements(input, { query: "Older unique" }), []);
  assert.deepEqual(visibleAchievements(input, { filter: "locked" }), []);
  assert.equal(visibleAchievements(input, { filter: "earned" }).length, 6);
  assert.deepEqual(ids(visibleAchievements(input, { category: "模型工具", filter: "locked" })), ["locked"]);
  assert.equal(visibleAchievements(input, { category: "模型工具", filter: "earned" }).length, 7);
});

test("percentage uses the next target without decimal truncation and retains earned completion after data removal", () => {
  assert.equal(achievementPercent(row("zero", { observedValue: "0" })), 0);
  assert.equal(achievementPercent(row("fraction", { observedValue: "1", nextTarget: "3" })), 100 / 3);
  assert.equal(achievementPercent(row("A01", { observedValue: "284000000000", nextTarget: "5000000000000" })), 5.68);
  assert.equal(achievementPercent(row("small", { observedValue: "1", nextTarget: "1000000000000" })), 1e-10);
  assert.equal(achievementPercent(row("over", { observedValue: "1000" })), 100);
  assert.equal(achievementPercent(row("gold", { highestEarned: "gold", observedValue: "0", nextTarget: null })), 100);
  assert.equal(
    achievementPercent(row("stone", { tiered: false, highestEarned: "stone", observedValue: "0", nextTarget: null })),
    100,
  );
});

test("badge markup preserves S07 material, locked classes and decorative accessibility", () => {
  const locked = row("A01", { highestEarned: null });
  assert.match(achievementBadge(locked), /class="badge is-locked"/);
  assert.match(achievementBadge(locked, { grade: null }), /class="badge is-locked"/);
  assert.match(achievementBadge(locked), /src="\/assets\/achievements\/A01\/bronze.webp"/);
  assert.match(achievementBadge(locked), /width="256" height="256" alt="" aria-hidden="true"/);
  assert.match(
    achievementBadge(row("A31", { tiered: false, highestEarned: null })),
    /class="badge is-stone is-locked"/,
  );
  assert.match(achievementBadge(row("A31", { tiered: false })), /\/A31\/stone.webp/);
  assert.match(achievementBadge(row("A01")), /\/A01\/bronze.webp/);
  assert.match(achievementBadge(row("A01", { highestEarned: "silver" })), /\/A01\/silver.webp/);
  assert.match(achievementBadge(locked, { grade: "gold", locale: "en-US" }), /\/A01\/gold.webp/);
  assert.match(achievementBadge(locked, { grade: "gold" }), /is-locked/);
  assert.equal(locked.highestEarned, null);
});

test("list HTML preserves S07 rows, selection and approved localized accessible copy without outer frames", () => {
  const actual = achievementRows(snapshot()).filter((entry) => ["A01", "A31"].includes(entry.id));
  for (const locale of ["zh-CN", "en", "en-US"]) {
    const html = renderAchievementList(actual, { selectedId: "A31", locale });
    const copy = actual[0][locale === "zh-CN" ? "zh" : "en"];
    assert.equal((html.match(/class="achievement-row is-locked"/g) || []).length, 2);
    assert.match(html, /data-achievement="A01" aria-pressed="false"/);
    assert.match(html, /data-achievement="A31" aria-pressed="true"/);
    assert.ok(html.includes(`<h3>${copy.name}</h3><p>${copy.description}</p>`));
    assert.ok(html.includes(`aria-label="${achievementUi(locale).view(copy.name)}"`));
    assert.doesNotMatch(html, /list-well|achievement-list-frame|detail-panel|sample|illustrative/);
    assert.equal((html.match(/<button type="button"/g) || []).length, 2);
  }
});

test("empty recent and filtered states retain accepted bilingual S07 copy", () => {
  for (const locale of ["zh-CN", "en", "en-US"]) {
    const ui = achievementUi(locale);
    assert.equal(
      renderAchievementList([], { locale, emptyRecent: true }),
      `<div class="empty-state"><h3>${ui.noRecent}</h3><p>${ui.noRecentHint}</p></div>`,
    );
    assert.equal(
      renderAchievementList([], { locale }),
      `<div class="empty-state"><h3>${ui.noMatches}</h3><p>${ui.noMatchesHint}</p></div>`,
    );
  }
});

test("list labels and content escape HTML rather than creating markup or attributes", () => {
  const content = { name: '<img onerror="alert(1)">', description: "<script>&'", flavor: "" };
  const html = renderAchievementList([row('A01" onclick="bad', { zh: content })]);
  assert.match(html, /data-achievement="A01&quot; onclick=&quot;bad"/);
  assert.match(html, /&lt;img onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;&amp;&#39;/);
  assert.doesNotMatch(html, /<script|<img onerror|" onclick="bad/);
});
