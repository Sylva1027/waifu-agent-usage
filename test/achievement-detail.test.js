import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ACHIEVEMENT_CONTENT, achievementCopy, achievementUi } from "../public/achievement-content.js";
import { renderAchievementDetail } from "../public/achievement-detail.js";
import { escapeHtml } from "../public/html-utils.js";

function row(id = "A01", overrides = {}) {
  const content = ACHIEVEMENT_CONTENT.find((entry) => entry.id === id);
  return {
    ...content,
    observedValue: "0",
    nextTarget: content.thresholds[0],
    highestEarned: null,
    earnedAt: {},
    updatedAt: null,
    ...overrides,
  };
}

const swatches = (html) =>
  [...html.matchAll(/<button[^>]+data-preview-grade="[^"]+"[^>]*>.*?<\/button>/g)].map(([button]) => button);
const progress = (html) => html.match(/<div class="progress-meta"><span>(.*?)<\/span>/)[1];
const dateText = (html) => html.match(/<p class="detail-date">(.*?)<\/p>/)[1];

test("locked detail keeps S07 structure, thresholds and accessible bilingual labels without dates", () => {
  for (const locale of ["zh-CN", "en", "en-US"]) {
    const item = row();
    const html = renderAchievementDetail(item, { locale });
    const copy = achievementCopy(item, locale);
    const ui = achievementUi(locale);
    assert.match(html, /^<section class="surface detail-panel is-locked"/);
    assert.ok(html.includes(`aria-label="${escapeHtml(ui.details(copy.name))}"`));
    assert.ok(html.includes(`aria-label="${escapeHtml(ui.progress(copy.name))}"`));
    assert.match(html, /class="badge [^"]*is-locked"/);
    assert.equal(dateText(html), "");
    assert.equal(progress(html), "0 / 50B");
    assert.equal(swatches(html).length, 3);
    swatches(html).forEach((button, index) => {
      assert.equal(button.replace(/<[^>]*>/g, ""), item.levels[index]);
      assert.doesNotMatch(button, /\btitle=|tier-check/);
      assert.ok(button.includes(`aria-pressed="${index === 0}"`));
    });
    assert.ok(!html.includes(escapeHtml(copy.description)));
    assert.doesNotMatch(html, /距.+级|尚未获得|Not yet earned/);
  }
});

test("per-grade API dates survive sequential awards, use archive timezone and omit unearned tooltip", () => {
  const item = row("A01", {
    observedValue: "284000000000",
    nextTarget: "5000000000000",
    highestEarned: "silver",
    earnedAt: { bronze: "2026-11-11T16:00:00Z", silver: "2026-11-15T16:15:00Z", gold: null },
    updatedAt: "2026-11-15T16:15:00Z",
  });
  const html = renderAchievementDetail(item, { timeZone: "Asia/Shanghai" });
  const [bronze, silver, gold] = swatches(html);
  assert.match(bronze, /title="获得日期 2026\.11\.12"/);
  assert.match(silver, /title="获得日期 2026\.11\.16"/);
  assert.match(silver, /aria-pressed="true"/);
  assert.doesNotMatch(gold, /\btitle=|tier-check/);
  assert.equal(dateText(html), "最近更新 2026.11.16");
  assert.equal(progress(html), "284B / 5T");
  assert.ok(Math.abs(Number(html.match(/aria-valuenow="([^"]+)"/)[1]) - 5.68) < 1e-12);
  const english = renderAchievementDetail(item, { locale: "en-US", timeZone: "UTC" });
  assert.match(swatches(english)[0], /title="Earned Nov 11, 2026"/);
  assert.equal(dateText(english), "Updated Nov 15, 2026");
});

test("preview changes only the displayed badge and pressed swatch, never progress or records", (t) => {
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("rendering must not call the API");
  });
  for (const highestEarned of [null, "bronze", "silver", "gold"]) {
    const item = row("A07", {
      highestEarned,
      observedValue: "12",
      nextTarget: highestEarned === "gold" ? null : "30",
      earnedAt: { bronze: "2026-11-12T00:00:00Z", silver: "2026-11-15T00:00:00Z" },
      updatedAt: "2026-11-15T00:00:00Z",
    });
    const original = structuredClone(item);
    Object.freeze(item.earnedAt);
    Object.freeze(item);
    const initial = renderAchievementDetail(item);
    for (const grade of ["bronze", "silver", "gold"]) {
      const html = renderAchievementDetail(item, { previewGrade: grade });
      assert.match(html, new RegExp(`/A07/${grade}\\.webp`));
      const locked = ["bronze", "silver", "gold"].indexOf(grade) > ["bronze", "silver", "gold"].indexOf(highestEarned);
      assert.equal(/class="badge [^"]*is-locked"/.test(html), locked);
      assert.match(swatches(html)[["bronze", "silver", "gold"].indexOf(grade)], /aria-pressed="true"/);
      assert.equal(progress(html), progress(initial));
      assert.equal(dateText(html), dateText(initial));
      assert.equal((html.match(/tier-check/g) || []).length, (initial.match(/tier-check/g) || []).length);
      assert.equal((html.match(/\btitle=/g) || []).length, (initial.match(/\btitle=/g) || []).length);
      assert.deepEqual(item, original);
    }
    assert.equal(renderAchievementDetail(item, { previewGrade: '<img src=x onerror="bad()">' }), initial);
  }
});

test("a simultaneous cross-grade award retains the API date on all newly earned tiers", () => {
  const instant = "2026-11-16T23:30:00Z";
  const html = renderAchievementDetail(
    row("A59", {
      observedValue: "10000000000",
      nextTarget: null,
      highestEarned: "gold",
      earnedAt: { bronze: instant, silver: instant, gold: instant },
      updatedAt: instant,
    }),
    { timeZone: "Asia/Shanghai" },
  );
  assert.equal(swatches(html).length, 3);
  for (const button of swatches(html)) assert.match(button, /title="获得日期 2026\.11\.17"/);
  assert.equal(dateText(html), "最近更新 2026.11.17");
  assert.match(html, /aria-valuenow="100"/);
});

test("stone details ignore grade preview and use the award date rather than updatedAt", () => {
  const item = row("A44", {
    observedValue: "10",
    nextTarget: null,
    highestEarned: "stone",
    earnedAt: { stone: "2024-03-01T00:15:00Z" },
    updatedAt: "2026-11-16T00:00:00Z",
  });
  const html = renderAchievementDetail(item, { locale: "en", timeZone: "America/New_York", previewGrade: "gold" });
  assert.match(html, /class="badge is-stone /);
  assert.match(html, /\/A44\/stone\.webp/);
  assert.equal(dateText(html), "Earned Feb 29, 2024");
  assert.equal(progress(html), "10 / 10");
  assert.doesNotMatch(html, /tier-ladder|data-preview-grade|\btitle=/);
  assert.match(html, /aria-valuenow="100"/);
});

test("missing and invalid dates are never fabricated, even when a tier is earned", () => {
  const html = renderAchievementDetail(
    row("A01", {
      highestEarned: "bronze",
      earnedAt: { bronze: "invalid", silver: null },
      updatedAt: null,
    }),
  );
  assert.doesNotMatch(html, /\btitle=|Invalid Date|1970/);
  assert.equal(dateText(html), "");
  assert.match(swatches(html)[0], /tier-check/);
});

test("calendar dates follow the profile timezone across year and DST boundaries", () => {
  for (const [instant, timeZone, expected] of [
    ["2026-12-31T16:01:00Z", "Asia/Shanghai", "2027.01.01"],
    ["2026-03-08T07:30:00Z", "America/New_York", "2026.03.08"],
    ["2026-11-01T05:30:00Z", "America/New_York", "2026.11.01"],
    ["2026-11-01T06:30:00Z", "America/New_York", "2026.11.01"],
  ]) {
    const html = renderAchievementDetail(
      row("A31", {
        highestEarned: "stone",
        earnedAt: { stone: instant },
      }),
      { timeZone },
    );
    assert.equal(dateText(html), `获得日期 ${expected}`);
  }
});

test("progress uses exact decimal integers with only necessary K/M/B/T suffixes", () => {
  for (const [value, expected] of [
    ["34", "34"],
    ["1234", "1.23K"],
    ["28400000", "28.4M"],
    ["284000000000", "284B"],
    ["5000000000000", "5T"],
    // Number rounds this above the .005T boundary; BigInt must retain the lower value.
    ["90071999994999999999", "90,071,999.99T"],
  ]) {
    const html = renderAchievementDetail(row("A01", { observedValue: value }));
    assert.equal(progress(html), `${expected} / 50B`);
    assert.doesNotMatch(progress(html), /Token|模型|Harness|天|月|成就/);
  }
});

test("flavor preserves escaped text, whole hyphenated words and dash plus attribution", () => {
  const item = row("A07");
  item.en = {
    name: '<img src=x onerror="bad()">',
    description: "never repeat this condition",
    flavor: "A long-term plan <script>bad()</script> — Someone & Friends",
  };
  const html = renderAchievementDetail(item, { locale: "en" });
  assert.match(html, /<span class="flavor-word">long-term<\/span>/);
  assert.match(html, /<span class="flavor-attribution">— Someone &amp; Friends<\/span>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x|never repeat this condition/);
  assert.ok(html.includes(escapeHtml(item.en.name)));
});

test("all 42 production entries render in both languages for locked and completed states", () => {
  assert.equal(ACHIEVEMENT_CONTENT.length, 42);
  for (const content of ACHIEVEMENT_CONTENT) {
    for (const locale of ["zh-CN", "en-US"]) {
      for (const earned of [false, true]) {
        const instant = "2026-11-16T23:30:00Z";
        const item = row(
          content.id,
          earned
            ? {
                observedValue: "0",
                nextTarget: null,
                highestEarned: content.tiered ? "gold" : "stone",
                earnedAt: { bronze: instant, silver: instant, gold: instant, stone: instant },
                updatedAt: instant,
              }
            : {},
        );
        const html = renderAchievementDetail(item, { locale, timeZone: "Asia/Shanghai" });
        assert.ok(html.includes(`<h3>${escapeHtml(achievementCopy(item, locale).name)}</h3>`));
        assert.equal(swatches(html).length, content.tiered ? 3 : 0);
        assert.equal(Boolean(dateText(html)), earned);
        assert.match(html, new RegExp(`aria-valuenow="${earned ? 100 : 0}"`));
        assert.doesNotMatch(html, /undefined|NaN|docs\/validation|\/badges\//);
      }
    }
  }
});

test("detail CSS stays scoped and preserves S07 metal geometry, colors, wrapping and short-height layout", () => {
  const css = readFileSync(new URL("../public/achievement-detail.css", import.meta.url), "utf8");
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector] of rules.matchAll(/([^{}]+)\{/g)) {
    if (selector.trim().startsWith("@media")) continue;
    for (const part of selector.split(",")) assert.ok(part.includes("#achievementDialog"), part);
  }
  assert.doesNotMatch(css, /#achievementDialog\s+\.badge\s*\{/);
  assert.match(css, /width: 75%;/);
  assert.match(css, /aspect-ratio: 16\s*\/\s*9;/);
  assert.match(css, /--metal-dark: #9f9f9e;/);
  assert.match(css, /--metal-mid: #b0aeaf;/);
  assert.match(css, /--metal-light: #c6c4c4;/);
  assert.match(css, /hyphens: none;/);
  assert.match(css, /word-break: normal;/);
  assert.match(css, /white-space: nowrap;/);
  assert.match(css, /@media \(max-height: 680px\)/);
  assert.match(css, /grid-template-columns: 72px minmax\(0, 1fr\);/);
  assert.match(css, /max-height: none;/);
  assert.match(css, /overflow: visible;/);
});
