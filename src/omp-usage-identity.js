import path from "node:path";

export function ompIdentityKeys(event) {
  const { nativeKey, responseKey, aliasKeys } = event.omp;
  return [...new Set([nativeKey, responseKey, ...aliasKeys].filter(Boolean))];
}

/** Group by native and alternate identifiers from the same logical OMP home. */
export function groupOmpOccurrences(events) {
  const parents = new Map();
  function root(key) {
    let current = key;
    while (parents.has(current)) current = parents.get(current);
    while (parents.has(key)) {
      const next = parents.get(key);
      parents.set(key, current);
      key = next;
    }
    return current;
  }
  const occurrences = [];
  for (const event of events) {
    const keys = ompIdentityKeys(event);
    if (!keys.length) continue;
    const first = keys[0];
    for (const key of keys) {
      const owner = root(first);
      const related = root(key);
      if (related !== owner) parents.set(related, owner);
    }
    occurrences.push(event);
  }
  const groups = new Map();
  for (const event of occurrences) {
    const key = root(event.omp.nativeKey);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.values()];
}

export function ompUsageCompatible(a, b) {
  return (
    a.model === b.model &&
    a.omp.provider === b.omp.provider &&
    a.omp.api === b.omp.api &&
    a.omp.usageDigest === b.omp.usageDigest
  );
}

function sessionPath(file, home) {
  const dir = path.join(home, "archive", "sessions");
  const relative = path.relative(dir, file);
  const isArchive =
    relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const value = (isArchive ? path.join(home, "sessions", relative) : path.normalize(file)).replace(
    /\.jsonl\.gz$/i,
    ".jsonl",
  );
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Select the visible original before falling back to a stable order of available copies. */
export function chooseOmpOccurrence(occurrences) {
  const first = occurrences[0];
  if (!first) return { winner: null, conflict: false };
  if (occurrences.length === 1) return { winner: first, conflict: false };
  if (occurrences.some((event) => !ompUsageCompatible(first, event))) return { winner: null, conflict: true };

  const byId = new Set(occurrences.map(({ sessionId }) => sessionId));
  const byPath = new Set(occurrences.map(({ sourcePath, homePath }) => sessionPath(sourcePath, homePath)));
  function fork(event) {
    const parent = event.omp.parentSession;
    if (!parent || event.sessionId === parent) return false;
    return byId.has(parent) || (path.isAbsolute(parent) && byPath.has(sessionPath(parent, event.homePath)));
  }
  const ordered = [...occurrences].sort(
    (a, b) =>
      Number(fork(a)) - Number(fork(b)) ||
      compareText(a.sessionId, b.sessionId) ||
      (a.omp.entryTimestampMs || a.timestampMs) - (b.omp.entryTimestampMs || b.timestampMs) ||
      Number(a.omp.discarded) - Number(b.omp.discarded) ||
      Number(a.sourcePath.endsWith(".gz")) - Number(b.sourcePath.endsWith(".gz")) ||
      compareText(a.sourcePath, b.sourcePath) ||
      compareText(a.omp.nativeKey, b.omp.nativeKey),
  );
  const winner = ordered[0];
  if (!winner.omp.discarded) return { winner, conflict: false };
  const assistant = ordered.find((event) => !event.omp.discarded && event.omp.nativeKey === winner.omp.nativeKey);
  if (!assistant) return { winner, conflict: false };
  return {
    winner: {
      ...winner,
      timestamp: assistant.timestamp,
      timestampMs: assistant.timestampMs,
      serviceTier: assistant.serviceTier,
    },
    conflict: false,
  };
}
