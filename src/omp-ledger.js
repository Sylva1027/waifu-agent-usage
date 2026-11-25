import { stat } from "node:fs/promises";
import path from "node:path";
import { readOmpSnapshot } from "./omp-usage.js";
import { chooseOmpOccurrence, ompIdentityKeys } from "./omp-usage-identity.js";
import { usageSourceIdentity } from "./usage-source-proof.js";

export const OMP_TABLES = ["omp_files", "omp_calls", "omp_aliases", "omp_occurrences"];
export const OMP_LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS omp_files (
    path TEXT PRIMARY KEY, stamp TEXT NOT NULL, status TEXT NOT NULL, diagnostics TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS omp_calls (
    call_key TEXT PRIMARY KEY, owner_path TEXT NOT NULL REFERENCES source_files(path),
    session_id TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, digest TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS omp_aliases (
    alias TEXT PRIMARY KEY, call_key TEXT NOT NULL REFERENCES omp_calls(call_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS omp_alias_owner ON omp_aliases(call_key);
  CREATE TABLE IF NOT EXISTS omp_occurrences (
    path TEXT NOT NULL, native_key TEXT NOT NULL, alias TEXT NOT NULL, digest TEXT NOT NULL,
    conflict INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(path,native_key,alias,digest)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS omp_occ_native ON omp_occurrences(native_key);
  CREATE INDEX IF NOT EXISTS omp_occ_alias ON omp_occurrences(alias);
  CREATE INDEX IF NOT EXISTS omp_disputed_paths ON omp_occurrences(path) WHERE conflict=1;
`;

export function ompSnapshotStamp(info) {
  return JSON.stringify([usageSourceIdentity(info), info.ctimeMs, info.size, info.mtimeMs]);
}

function hinted(file, hints) {
  const normalize = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
  const name = normalize(file);
  return (
    hints?.unknown ||
    hints?.paths?.some((hint) => {
      const notified = normalize(hint.path);
      return name === notified || name.startsWith(notified + path.sep);
    })
  );
}

// Temporary tables contain only usage projections. Parsing never holds a main-database write transaction.
export async function stageOmpFiles(database, files, repositoryResolver, sourceHints, force, warnings) {
  database.exec(`CREATE TEMP TABLE IF NOT EXISTS omp_stage (
    native_key TEXT NOT NULL, path TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS temp.omp_stage_native ON omp_stage(native_key);
    CREATE TEMP TABLE IF NOT EXISTS omp_group (key TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS omp_changes (
      owner_path TEXT NOT NULL, call_key TEXT PRIMARY KEY, timestamp_ms INTEGER NOT NULL, payload TEXT);
    CREATE INDEX IF NOT EXISTS temp.omp_changed_range ON omp_changes(owner_path,timestamp_ms);
    CREATE TEMP TABLE IF NOT EXISTS omp_visible (path TEXT PRIMARY KEY);
    DELETE FROM omp_stage; DELETE FROM omp_group; DELETE FROM omp_changes; DELETE FROM omp_visible;`);
  const insert = database.prepare("INSERT INTO omp_stage VALUES (?,?,?,?)");
  const visible = database.prepare("INSERT OR IGNORE INTO omp_visible VALUES (?)");
  const baseline = database.prepare("SELECT stamp,status FROM omp_files WHERE path=?");
  const binding = database.prepare("SELECT kind,home_id FROM source_files WHERE path=?");
  const sourceIds = new Map();
  for (const { filePath, source } of files) {
    const ids = sourceIds.get(filePath) || new Set();
    ids.add(source.id);
    sourceIds.set(filePath, ids);
  }
  const disputed = new Map(
    database
      .prepare(`SELECT DISTINCT o.path,f.stamp FROM omp_occurrences o
    JOIN omp_files f USING(path) WHERE o.conflict=1`)
      .all()
      .map((r) => [String(r.path), String(r.stamp)]),
  );
  const paths = new Set(files.map((f) => f.filePath));
  const retryConflicts =
    [...disputed.keys()].some((p) => !paths.has(p)) ||
    files.some(
      (f) =>
        disputed.has(f.filePath) &&
        (disputed.get(f.filePath) !== ompSnapshotStamp(f.info) || hinted(f.filePath, sourceHints)),
    );
  const snapshots = [];
  const accepted = new Set();
  for (const file of files) {
    const { filePath, source, info } = file;
    visible.run(filePath);
    const bound = binding.get(filePath);
    if (sourceIds.get(filePath).size > 1 && !(bound?.kind === "omp" && bound.home_id === source.id)) {
      const message = `Oh My Pi: OMP_SOURCE_BINDING_CONFLICT (1): ${filePath}`;
      if (!warnings.includes(message)) warnings.push(message);
      continue;
    }
    if (accepted.has(filePath)) continue;
    accepted.add(filePath);
    const previous = baseline.get(filePath);
    const stamp = ompSnapshotStamp(info);
    if (
      !force &&
      !file.force &&
      (!bound || (bound.kind === "omp" && bound.home_id === source.id)) &&
      !(retryConflicts && disputed.has(filePath)) &&
      !hinted(filePath, sourceHints) &&
      previous?.stamp === stamp &&
      ["complete", "partial", "ignored"].includes(previous.status)
    )
      continue;
    const snapshot = await readOmpSnapshot(filePath, source, {
      repositoryResolver,
      onEvent: (event) => insert.run(event.omp.nativeKey, filePath, event.omp.usageDigest, JSON.stringify(event)),
    });
    if (snapshot.status === "complete" || snapshot.status === "partial") {
      const after = await stat(filePath).catch(() => null);
      if (!after || ompSnapshotStamp(after) !== stamp) {
        database.prepare("DELETE FROM omp_stage WHERE path=?").run(filePath);
        snapshot.status = "error";
        snapshot.diagnostics = { OMP_FILE_CHANGED: 1 };
      }
    }
    snapshots.push({ file, stamp, previousStamp: previous?.stamp, ...snapshot });
  }
  return snapshots;
}

export function ompLedgerWarnings(database) {
  const warnings = [];
  for (const row of database
    .prepare(`SELECT f.path,f.diagnostics FROM omp_files f INNER JOIN omp_visible v USING(path)
    WHERE f.diagnostics <> '{}' ORDER BY f.path`)
    .iterate()) {
    for (const [code, count] of Object.entries(JSON.parse(String(row.diagnostics))))
      warnings.push(`Oh My Pi: ${code} (${count}): ${row.path}`);
  }
  for (const row of database
    .prepare(`SELECT o.path, COUNT(DISTINCT o.native_key) AS n FROM omp_occurrences o
    JOIN omp_visible v USING(path) WHERE o.conflict=1 GROUP BY o.path ORDER BY o.path`)
    .iterate())
    warnings.push(`Oh My Pi: OMP_IDENTITY_CONFLICT (${row.n}): ${row.path}`);
  return warnings;
}

// Each connected component contains aliases for one apparent provider call. Native ids include the logical home.
export function reconcileOmpCalls(database, snapshots, eventRow) {
  const current = database.prepare("SELECT stamp FROM omp_files WHERE path=?");
  const source =
    database.prepare(`INSERT INTO source_files(path,kind,home_id,home_label,home_path,size,mtime_ms,indexed_at)
    VALUES (?,'omp',?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,
    mtime_ms=excluded.mtime_ms,indexed_at=excluded.indexed_at`);
  const baseline = database.prepare(`INSERT INTO omp_files VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET
    stamp=excluded.stamp,status=excluded.status,diagnostics=excluded.diagnostics`);
  const remove = database.prepare("DELETE FROM omp_occurrences WHERE path=?");
  const observation = database.prepare(
    "INSERT OR IGNORE INTO omp_occurrences(path,native_key,alias,digest) VALUES (?,?,?,?)",
  );
  const reliable = new Set();
  for (const { file, stamp, previousStamp, status, diagnostics } of snapshots) {
    const { filePath, source: home, info } = file;
    if (current.get(filePath)?.stamp !== previousStamp)
      throw Object.assign(new Error("OMP source was indexed concurrently"), {
        code: "LIVE_SOURCE_CHANGED",
        retryable: true,
      });
    baseline.run(filePath, stamp, status, JSON.stringify(diagnostics || {}));
    if (status === "complete") {
      reliable.add(filePath);
      remove.run(filePath);
    }
    if (status === "partial" || status === "complete")
      source.run(filePath, home.id, home.label, home.path, info.size, info.mtimeMs, new Date().toISOString());
  }
  for (const row of database.prepare("SELECT payload FROM omp_stage").iterate()) {
    const event = JSON.parse(String(row.payload));
    for (const alias of ompIdentityKeys(event))
      observation.run(event.sourcePath, event.omp.nativeKey, alias, event.omp.usageDigest);
  }

  const first = database.prepare("SELECT native_key FROM omp_stage LIMIT 1");
  const component = database.prepare(`WITH RECURSIVE keys(key) AS (
    VALUES (?) UNION SELECT o.alias FROM omp_occurrences o JOIN keys ON keys.key=o.native_key
    UNION SELECT o.native_key FROM omp_occurrences o JOIN keys ON keys.key=o.alias
    UNION SELECT a.call_key FROM omp_aliases a JOIN keys ON keys.key=a.alias
    UNION SELECT a.alias FROM omp_aliases a JOIN keys ON keys.key=a.call_key
  ) INSERT INTO omp_group SELECT key FROM keys`);
  const calls = database.prepare(
    "SELECT c.* FROM omp_group g CROSS JOIN omp_calls c ON c.call_key=g.key ORDER BY c.rowid",
  );
  const mapped = database.prepare("SELECT call_key FROM omp_aliases WHERE alias=?");
  const staged = database.prepare("SELECT s.payload FROM omp_group g CROSS JOIN omp_stage s ON s.native_key=g.key");
  const digests = database.prepare(`SELECT DISTINCT o.digest FROM omp_group g CROSS JOIN omp_occurrences o
    ON o.native_key=g.key JOIN omp_visible v ON v.path=o.path`);
  const insertCall = database.prepare("INSERT INTO omp_calls VALUES (?,?,?,?,?)");
  const updateCall = database.prepare("UPDATE omp_calls SET digest=? WHERE call_key=?");
  const home = database.prepare("SELECT home_id,home_label FROM source_files WHERE path=?");
  const provenCalls = database.prepare(`WITH RECURSIVE reach(key) AS (
    VALUES (:key)
    UNION SELECT o.alias FROM reach JOIN omp_occurrences o ON o.native_key=reach.key
      JOIN omp_files f USING(path) JOIN omp_visible v USING(path) WHERE o.digest=:digest AND f.status='complete'
    UNION SELECT o.native_key FROM reach JOIN omp_occurrences o ON o.alias=reach.key
      JOIN omp_files f USING(path) JOIN omp_visible v USING(path) WHERE o.digest=:digest AND f.status='complete'
    UNION SELECT a.call_key FROM reach JOIN omp_aliases a ON a.alias=reach.key
    UNION SELECT a.alias FROM reach JOIN omp_aliases a ON a.call_key=reach.key
  ) SELECT COUNT(*) n FROM reach JOIN omp_calls c ON c.call_key=reach.key`);
  const alias = database.prepare("INSERT OR IGNORE INTO omp_aliases(alias,call_key) VALUES (?,?)");
  const change = database.prepare("INSERT INTO omp_changes VALUES (?,?,?,?)");
  const conflict = database.prepare(
    "UPDATE omp_occurrences SET conflict=? WHERE native_key IN (SELECT key FROM omp_group) AND conflict<>?",
  );
  for (;;) {
    const seed = first.get();
    if (!seed) break;
    component.run(seed.native_key);
    const previous = calls.all();
    const events = staged.all().map((row) => JSON.parse(String(row.payload)));
    database.exec("DELETE FROM omp_stage WHERE native_key IN (SELECT key FROM omp_group)");
    const owner = previous[0];
    const observed = digests.all();
    const knownDigest = owner?.digest;
    let winner;
    let unresolved = observed.length > 1;
    if (!owner) {
      if (!unresolved) winner = chooseOmpOccurrence(events).winner;
    } else {
      const owners = events.filter(
        (event) =>
          event.sourcePath === owner.owner_path &&
          event.sessionId === owner.session_id &&
          mapped.get(event.omp.nativeKey)?.call_key === owner.call_key &&
          reliable.has(event.sourcePath),
      );
      const selection = chooseOmpOccurrence(owners);
      if (!selection.conflict) winner = selection.winner;
      if (!winner) winner = events.find((event) => event.omp.usageDigest === knownDigest);
      unresolved ||= previous.slice(1).some((call) => call.digest !== (winner?.omp.usageDigest ?? knownDigest));
    }
    if (!winner) {
      conflict.run(1, 1);
      database.exec("DELETE FROM omp_group");
      continue;
    }

    const digest = winner.omp.usageDigest;
    const key = owner?.call_key || winner.omp.nativeKey;
    const filePath = owner?.owner_path || winner.sourcePath;
    const timestamp = Number(owner?.timestamp_ms ?? winner.timestampMs);
    if (previous.length > 1 && !unresolved) unresolved = provenCalls.get({ key, digest }).n !== previous.length;
    if (!owner || digest !== knownDigest) {
      if (!owner) insertCall.run(key, filePath, winner.sessionId, timestamp, digest);
      else updateCall.run(digest, key);
      const binding = home.get(filePath);
      const row = eventRow(filePath, {
        ...winner,
        homeId: binding.home_id,
        homeLabel: binding.home_label,
        sourceEventId: key,
        sessionId: owner?.session_id || winner.sessionId,
        timestampMs: timestamp,
      });
      change.run(filePath, key, timestamp, JSON.stringify(row));
    }
    // A bridge between previously published calls is accepted only for mutually consistent evidence.
    if (!unresolved && previous.length > 1) {
      for (const duplicate of previous.slice(1)) {
        change.run(duplicate.owner_path, duplicate.call_key, duplicate.timestamp_ms, null);
        database.prepare("UPDATE omp_aliases SET call_key=? WHERE call_key=?").run(key, duplicate.call_key);
        database.prepare("DELETE FROM omp_calls WHERE call_key=?").run(duplicate.call_key);
      }
    }
    for (const event of unresolved && previous.length > 1 ? [] : events) {
      if (event.omp.usageDigest !== digest) continue;
      for (const id of ompIdentityKeys(event)) alias.run(id, key);
    }
    conflict.run(Number(unresolved), Number(unresolved));
    database.exec("DELETE FROM omp_group");
  }
}
