import { streamHermesDbEvents } from "./hermes-usage.js";

function ledgerTime(value) {
  const time = value === null || value === undefined ? NaN : Math.trunc(Number(value) * 1000);
  return Number.isSafeInteger(time) && time > 0 ? time : null;
}

function withAchievementEvidence(event, row) {
  return {
    ...event,
    achievementEvidence: {
      sourceEventId: event.sourceEventId,
      homeId: event.homeId,
      totalTokens: String(event.usage.total),
      timestampMs: event.timestampMs,
      precision: "interval",
      cumulative: true,
      coverage: {
        start: ledgerTime(row.first_seen) ?? ledgerTime(row.session_started_at),
        end: ledgerTime(row.last_seen) ?? ledgerTime(row.session_last_activity_at) ?? event.timestampMs,
      },
    },
  };
}

export async function streamAchievementHermesEvents(dbFile, source, onEvent, options = {}) {
  return streamHermesDbEvents(dbFile, source, onEvent, { ...options, decorateEvent: withAchievementEvidence });
}
