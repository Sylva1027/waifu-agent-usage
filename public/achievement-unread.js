import { achievementRows } from "./achievement-list.js";

// Keep these paired with the production catalog; the compatibility test detects drift.
const RULES_VERSION = "R7-production-1";
const CATALOG_HASH = "75e83543b974ff9245c0222a01ffab5a50e4c9cb6276054a12ed16518ea30b4c";
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const compatible = (snapshot) => snapshot.rulesVersion === RULES_VERSION && snapshot.catalogHash === CATALOG_HASH;

function valid(snapshot) {
  return (
    snapshot &&
    typeof snapshot.profileId === "string" &&
    snapshot.profileId.trim().length > 0 &&
    ["progressRevision", "awardRevision", "seenAwardRevision"].every((key) => revision(snapshot[key])) &&
    snapshot.seenAwardRevision <= snapshot.awardRevision &&
    typeof snapshot.rulesVersion === "string" &&
    snapshot.rulesVersion.length > 0 &&
    typeof snapshot.catalogHash === "string" &&
    snapshot.catalogHash.length > 0 &&
    ((snapshot.state === "preparing" && snapshot.rows === null) ||
      (snapshot.state === "ready" && achievementRows(snapshot) !== null))
  );
}

export function createAchievementUnread({ onChange = () => {} } = {}) {
  let snapshot = null;
  let generation = 0;
  let pending = new Map();
  let refreshing = null;
  let refreshRevision = 0;

  function accept(next) {
    if (!valid(next)) return false;
    if (snapshot?.profileId === next.profileId) {
      const latest =
        next.progressRevision >= snapshot.progressRevision && next.awardRevision >= snapshot.awardRevision
          ? next
          : snapshot;
      next = {
        ...latest,
        seenAwardRevision: Math.min(latest.awardRevision, Math.max(snapshot.seenAwardRevision, next.seenAwardRevision)),
      };
    } else {
      generation++;
      pending = new Map();
    }
    if (JSON.stringify(snapshot) !== JSON.stringify(next)) {
      snapshot = { ...next };
      onChange(snapshot);
    }
    return true;
  }

  function refresh() {
    refreshRevision++;
    if (refreshing) return refreshing;
    let requested = refreshRevision;
    refreshing = Promise.resolve().then(async () => {
      try {
        while (true) {
          const started = generation;
          try {
            const response = await fetch("/api/achievements", { cache: "no-store", credentials: "same-origin" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const next = await response.json();
            if (started === generation && !accept(next)) throw new Error("Invalid achievement snapshot");
          } catch (error) {
            if (!snapshot && requested === refreshRevision) throw error;
            // Keep the last complete snapshot; the next real refresh can retry.
          }
          if (requested === refreshRevision) break;
          requested = refreshRevision;
        }
        return snapshot;
      } finally {
        refreshing = null;
      }
    });
    return refreshing;
  }

  function markShown({ profileId, seenThroughRevision } = {}) {
    if (
      !snapshot ||
      snapshot.profileId !== profileId ||
      snapshot.state !== "ready" ||
      !compatible(snapshot) ||
      !revision(seenThroughRevision) ||
      seenThroughRevision > snapshot.awardRevision
    )
      return Promise.resolve(false);
    if (seenThroughRevision <= snapshot.seenAwardRevision) return Promise.resolve(true);
    if (pending.has(seenThroughRevision)) return pending.get(seenThroughRevision);
    const started = generation;
    const requests = pending;
    const request = Promise.resolve().then(async () => {
      try {
        if (started !== generation) return false;
        const response = await fetch("/api/achievements/seen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ profileId, seenThroughRevision }),
        });
        if (!response.ok) return false;
        const result = await response.json();
        if (
          started !== generation ||
          !revision(result?.seenThroughRevision) ||
          result.seenThroughRevision < seenThroughRevision
        )
          return false;
        accept({ ...snapshot, seenAwardRevision: Math.min(snapshot.awardRevision, result.seenThroughRevision) });
        return true;
      } catch {
        return false;
      } finally {
        requests.delete(seenThroughRevision);
      }
    });
    requests.set(seenThroughRevision, request);
    return request;
  }

  return { accept, refresh, markShown, getSnapshot: () => snapshot };
}
