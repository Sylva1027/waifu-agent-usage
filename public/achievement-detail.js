import { achievementCopy, achievementUi } from "./achievement-content.js";
import { achievementBadge, achievementPercent } from "./achievement-list.js";
import { escapeHtml } from "./html-utils.js";

const grades = ["bronze", "silver", "gold"];
const amountFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

export function renderAchievementDetail(row, { locale = "zh-CN", timeZone = "UTC", previewGrade = null } = {}) {
  const copy = achievementCopy(row, locale);
  const ui = achievementUi(locale);
  const english = locale === "en" || locale === "en-US";
  const dateFormatter = new Intl.DateTimeFormat(english ? "en-US" : "zh-CN", {
    timeZone,
    year: "numeric",
    month: english ? "short" : "2-digit",
    day: english ? "numeric" : "2-digit",
  });
  const date = (value) => {
    if (!value) return "";
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) return "";
    if (english) return dateFormatter.format(instant);
    const parts = Object.fromEntries(dateFormatter.formatToParts(instant).map((part) => [part.type, part.value]));
    return `${parts.year}.${parts.month}.${parts.day}`;
  };
  const displayGrade =
    row.tiered && grades.includes(previewGrade)
      ? previewGrade
      : (row.highestEarned ?? (row.tiered ? "bronze" : "stone"));
  const rank = grades.indexOf(row.highestEarned);
  const tiers = row.tiered
    ? `<div class="tier-ladder">${row.levels
        .map((threshold, index) => {
          const grade = grades[index];
          const earned = index <= rank;
          const earnedDate = earned ? date(row.earnedAt?.[grade]) : "";
          const tooltip = earnedDate ? ui.earned(earnedDate) : "";
          return `<div class="tier-slot ${earned ? "achieved" : ""}" aria-label="${escapeHtml(ui.tier(ui.grades[grade], threshold, tooltip))}"><button type="button" class="metal-swatch ${grade}" data-preview-grade="${grade}" aria-label="${escapeHtml(ui.previewGrade(ui.grades[grade], threshold))}" aria-pressed="${displayGrade === grade}"${tooltip ? ` title="${escapeHtml(tooltip)}"` : ""}><span>${escapeHtml(threshold)}</span>${earned ? '<span class="tier-check" aria-hidden="true">✓</span>' : ""}</button></div>`;
        })
        .join("")}</div>`
    : "";
  const explanation = escapeHtml(copy.flavor)
    .replace(/\b[A-Za-z]+(?:-[A-Za-z]+)+\b/g, '<span class="flavor-word">$&</span>')
    .replace(/([—–-][ \t]+[^\n]+)$/, '<span class="flavor-attribution">$1</span>');
  const target = row.nextTarget ?? row.thresholds.at(-1);
  const amount = `${amountFormatter.format(BigInt(row.observedValue))} / ${amountFormatter.format(BigInt(target))}`;
  const percent = achievementPercent(row);
  const recordedDate = row.highestEarned ? date(row.tiered ? row.updatedAt : row.earnedAt?.stone) : "";
  const dateLabel = recordedDate ? (row.tiered ? ui.updated(recordedDate) : ui.earned(recordedDate)) : "";
  return `<section class="surface detail-panel${row.highestEarned ? "" : " is-locked"}" aria-label="${escapeHtml(ui.details(copy.name))}">${achievementBadge(row, { grade: displayGrade, locale })}<h3>${escapeHtml(copy.name)}</h3><p class="detail-flavor">${explanation}</p>${tiers}<div class="detail-progress"><div class="progress-meta"><span>${escapeHtml(amount)}</span></div><div class="progress-track" role="progressbar" aria-label="${escapeHtml(ui.progress(copy.name))}" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><i style="width:${percent}%"></i></div></div><p class="detail-date">${escapeHtml(dateLabel)}</p></section>`;
}
