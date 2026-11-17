// Pure snapshot validation extracted from service-tier-evidence.js; no log discovery or database access.
export const SERVICE_TIER_EVIDENCE_SNAPSHOT_FORMAT_VERSION = 1;
const SNAPSHOT_TIERS = new Set(["fast", "priority", "default", "standard", "unknown"]);

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(", ")}`);
  }
}

export function validateServiceTierEvidenceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("service-tier evidence snapshot must be an object");
  }
  assertExactKeys(snapshot, ["formatVersion", "threads"], "snapshot");
  if (snapshot.formatVersion !== SERVICE_TIER_EVIDENCE_SNAPSHOT_FORMAT_VERSION) {
    throw new TypeError(`unsupported service-tier evidence snapshot ${snapshot.formatVersion}`);
  }
  if (!Array.isArray(snapshot.threads)) throw new TypeError("snapshot threads must be an array");

  const turnsByThread = new Map();
  let previousThreadId = null;
  for (const thread of snapshot.threads) {
    if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
      throw new TypeError("snapshot thread must be an object");
    }
    assertExactKeys(thread, ["threadId", "turns"], "snapshot thread");
    if (typeof thread.threadId !== "string" || thread.threadId.trim() === "") {
      throw new TypeError("snapshot threadId must be a non-empty string");
    }
    if (turnsByThread.has(thread.threadId)) {
      throw new TypeError(`duplicate snapshot threadId ${thread.threadId}`);
    }
    if (previousThreadId !== null && thread.threadId.localeCompare(previousThreadId) <= 0) {
      throw new TypeError("snapshot threads must be sorted by threadId");
    }
    previousThreadId = thread.threadId;
    if (!Array.isArray(thread.turns)) throw new TypeError("snapshot turns must be an array");

    const turns = [];
    let previousTime = -Infinity;
    for (const turn of thread.turns) {
      if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
        throw new TypeError("snapshot turn must be an object");
      }
      assertExactKeys(turn, ["time", "tier"], "snapshot turn");
      if (typeof turn.time !== "number" || !Number.isFinite(turn.time)) {
        throw new TypeError("snapshot turn time must be finite");
      }
      if (!SNAPSHOT_TIERS.has(turn.tier)) throw new TypeError(`unsupported snapshot tier ${turn.tier}`);
      if (turn.time < previousTime) throw new TypeError("snapshot turns must be sorted by time");
      previousTime = turn.time;
      turns.push({ time: turn.time, tier: turn.tier });
    }
    turnsByThread.set(thread.threadId, turns);
  }
  return snapshot;
}
