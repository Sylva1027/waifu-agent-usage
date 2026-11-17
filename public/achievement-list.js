import { ACHIEVEMENT_CONTENT, achievementCopy, achievementUi, categoryOrder } from "./achievement-content.js";
import { escapeHtml } from "./html-utils.js";

const isDecimal = (value) => typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
const complete = (row) => row.highestEarned === "gold" || (!row.tiered && row.highestEarned === "stone");
const group = (row) => (complete(row) ? 0 : row.highestEarned ? 1 : 2);

export function achievementRows(snapshot) {
  if (snapshot?.state !== "ready" || !Array.isArray(snapshot.rows)) return null;
  const byId = new Map(snapshot.rows.map((row) => [row?.id, row]));
  if (byId.size !== ACHIEVEMENT_CONTENT.length || byId.size !== snapshot.rows.length) return null;
  const rows = [];
  for (const content of ACHIEVEMENT_CONTENT) {
    const row = byId.get(content.id);
    if (
      !row ||
      !isDecimal(row.observedValue) ||
      !(row.nextTarget === null || (isDecimal(row.nextTarget) && BigInt(row.nextTarget) > 0n)) ||
      ![null, ...(content.tiered ? ["bronze", "silver", "gold"] : ["stone"])].includes(row.highestEarned) ||
      !row.earnedAt ||
      typeof row.earnedAt !== "object" ||
      !(row.updatedAt === null || typeof row.updatedAt === "string") ||
      (row.nextTarget === null && !complete({ tiered: content.tiered, highestEarned: row.highestEarned }))
    )
      return null;
    rows.push({
      ...content,
      observedValue: row.observedValue,
      nextTarget: row.nextTarget,
      highestEarned: row.highestEarned,
      earnedAt: row.earnedAt,
      updatedAt: row.updatedAt,
    });
  }
  return rows;
}

function progressRatio(row) {
  if (complete(row)) return [1n, 1n];
  const value = BigInt(row.observedValue),
    target = BigInt(row.nextTarget);
  return [value > target ? target : value, target];
}

export function achievementPercent(row) {
  const [value, target] = progressRatio(row);
  return Number(value * 100n) / Number(target);
}

export function visibleAchievements(
  rows,
  { category = "近期获得", filter = "all", query = "", timeZone = "UTC" } = {},
) {
  let candidates;
  if (category === "近期获得") {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const dates = new Map();
    candidates = rows.filter((row) => row.highestEarned !== null);
    for (const row of candidates) {
      const instant = row.tiered ? row.updatedAt : row.earnedAt.stone;
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
      );
      dates.set(row.id, `${parts.year}-${parts.month}-${parts.day}`);
    }
    const rank = { bronze: 1, silver: 2, gold: 3, stone: 3 };
    candidates.sort((a, b) => {
      const dateOrder = dates.get(b.id).localeCompare(dates.get(a.id));
      if (dateOrder) return dateOrder;
      const gradeOrder = rank[b.highestEarned] - rank[a.highestEarned];
      if (gradeOrder) return gradeOrder;
      // Compare exact API integers before converting the display percentage to Number.
      const [av, at] = progressRatio(a),
        [bv, bt] = progressRatio(b);
      const difference = bv * at - av * bt;
      return (
        (difference > 0n ? 1 : difference < 0n ? -1 : 0) ||
        categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) ||
        a.id.localeCompare(b.id)
      );
    });
    candidates = candidates.slice(0, 6);
  } else {
    candidates = rows.filter((row) => row.category === category);
  }
  candidates.sort((a, b) => group(a) - group(b));
  const search = query.trim().toLowerCase();
  return candidates.filter(
    (row) =>
      (filter === "all" || (row.highestEarned !== null) === (filter === "earned")) &&
      (!search ||
        `${row.zh.name} ${row.zh.description} ${row.en.name} ${row.en.description}`.toLowerCase().includes(search)),
  );
}

export function achievementBadge(row, { grade } = {}) {
  const level = grade ?? row.highestEarned ?? "locked";
  const material = !row.tiered ? "stone" : ["bronze", "silver", "gold"].includes(level) ? level : "bronze";
  const locked = row.tiered
    ? ["bronze", "silver", "gold"].indexOf(material) > ["bronze", "silver", "gold"].indexOf(row.highestEarned)
    : row.highestEarned !== "stone";
  return `<img class="badge ${!row.tiered ? "is-stone " : ""}${locked ? "is-locked" : ""}" src="/assets/achievements/${escapeHtml(row.id)}/${material}.webp" width="256" height="256" alt="" aria-hidden="true">`;
}

export function renderAchievementList(rows, { selectedId, locale = "zh-CN", emptyRecent = false } = {}) {
  const ui = achievementUi(locale);
  if (!rows.length)
    return `<div class="empty-state"><h3>${escapeHtml(emptyRecent ? ui.noRecent : ui.noMatches)}</h3><p>${escapeHtml(emptyRecent ? ui.noRecentHint : ui.noMatchesHint)}</p></div>`;
  return rows
    .map((row) => {
      const copy = achievementCopy(row, locale);
      return `<button type="button" class="achievement-row${row.highestEarned === null ? " is-locked" : ""}" data-achievement="${escapeHtml(row.id)}" aria-pressed="${selectedId === row.id}" aria-label="${escapeHtml(ui.view(copy.name))}">${achievementBadge(row)}<div><h3>${escapeHtml(copy.name)}</h3><p>${escapeHtml(copy.description)}</p></div></button>`;
    })
    .join("");
}
