import { removeLegacyUsageRecordTriggers } from "./usage-record-migration.js";
import { sourceFactIdentity } from "./usage-fact-identity.js";
import {
  publishedUsageEventFromRow,
  publishedUsageHomesFromDatabase,
  publishedUsageSessionsFromEvents,
  quotaObservationsFromDatabase,
  canonicalizeKind,
} from "./usage-published.js";
import { startOfLocalWeek } from "../public/period-comparison.js";

import { currentLocalRollupZoneIdentity } from "./usage-sql.js";
import { UsageReader } from "./usage-reader.js";
import { localDateKey, usageFromRow, canonicalFactPayload, HISTORY_ARCHIVE_EVENT_AUTHORITY_META } from "./usage-sql.js";
import { rangeHourStart } from "../public/timeline-utils.js";
import { mkdir, open, stat } from "node:fs/promises";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { plainRolloutPath } from "./codex-rollout.js";
import { createUsageInsertBatch } from "./usage-insert-batch.js";
import {
  UsageSourceAcquisition,
  ensureUsageSourceCatalog,
  USAGE_SOURCE_CATALOG_TABLE,
} from "./usage-source-acquisition.js";
import { ensureUsageMetadataSchema, USAGE_METADATA_TABLE_NAMES } from "./usage-metadata-store.js";
import {
  buildUsageFingerprint,
  discoverSessionFiles,
  discoverUsageSources,
  streamUsageFileEvents,
} from "./usage-sources.js";
import { resolveDateRange } from "./usage-query.js";
import { createRepositoryResolver } from "./repository-identity.js";
import {
  createUsageRollups,
  listDirtyUsageRollupDays,
  localUsageRollupDaysForUtcDays,
  rebuildUsageRollups,
  rebuildUsageRollupsFromEvents,
  tryAppendUsageRollups,
  tryInitializeUsageRollups,
  checkpointUsageRollups,
  USAGE_ROLLUP_PROGRESS_TABLES,
} from "./usage-rollups.js";
import {
  loadQuotaSourceEvidence,
  quotaSourceEvidenceSnapshot,
  quotaSourceEvidenceFromSnapshot,
} from "./quota-source-evidence.js";
import { createStoredQuotaSourceResolver } from "./usage-quota-source-store.js";
import { readCodexQuotaObservations } from "./codex-quota-cache.js";
import { isQuotaUsage } from "../public/quota-usage.js";
import { UsageHistoryQuery } from "./usage-history-query.js";
import { UsageSourceRows } from "./usage-source-rows.js";
import { UsageSourceProof, usageSourceIdentity, USAGE_SOURCE_SHA_KIND } from "./usage-source-proof.js";
import {
  ensureUsageSourceProgressSchema,
  markUsageSourceDependents,
  readUsageSourceBaseline,
  readUsageSourceProgress,
  UsageSourceChangeBounds,
  writeUsageSourceBaseline,
  writeUsageSourceProgress,
  USAGE_SOURCE_PROGRESS_TABLE_NAMES,
} from "./usage-source-progress.js";
import { ensureUsageQuotaSchema, USAGE_QUOTA_TABLE_NAMES } from "./usage-quota-store.js";
import { summarizePeriodComparison } from "../public/period-comparison.js";
import { zcodeSourceStat } from "./zcode-usage.js";
import { hermesSourceStat } from "./hermes-usage.js";
import { dshSessionFiles } from "./dsh-usage.js";
import { opencodeDatabaseFiles, opencodeSourceStat } from "./opencode-usage.js";
import { claudeSessionFiles } from "./claude-code-usage.js";
import { workbuddySessionFiles } from "./workbuddy-usage.js";
import { createHash } from "node:crypto";
import { sourceGroup, homeSourceKinds, timelineDateKey } from "../public/timeline-utils.js";

export const STORE_SCHEMA_VERSION = 25;
function addDaysMs(date, days) {
  return date.getTime() + days * 86_400_000;
}

const QUOTA_SOURCES_DDL = `CREATE TABLE IF NOT EXISTS quota_usage_sources (
  source_path TEXT NOT NULL, home_id TEXT NOT NULL, session_id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL, quota_source TEXT NOT NULL, until_ms INTEGER NOT NULL,
  PRIMARY KEY (source_path, session_id, timestamp_ms)
) STRICT;`;

const USAGE_PROJECTION_IGNORED_TABLES = [
  "usage_history_projection_inputs",
  "usage_history_projection_batches",
  USAGE_SOURCE_CATALOG_TABLE,
  "history_replaced_facts",
  "usage_business_revision",

  ...USAGE_QUOTA_TABLE_NAMES,
  ...USAGE_SOURCE_PROGRESS_TABLE_NAMES,

  ...USAGE_METADATA_TABLE_NAMES,
  ...USAGE_ROLLUP_PROGRESS_TABLES,
];
const USAGE_PROJECTION_IGNORED_META = [
  "generated_at",
  "fingerprint",
  "usage_file_fingerprints",
  "perf_file_warnings",
  "perf_missing_sources",
];
const MISSING_SOURCES_META = "perf_missing_sources";
const LOCAL_ROLLUP_ZONE_META = "usage_rollup_local_zone_identity";
const DEFERRED_METADATA_INDEX_META = "usage_metadata_initial_index_pending";
const historyProjectionQueues = new Map();
const HISTORY_ARCHIVE_EVENT_REVISIONS_META = "history_archive_event_revisions";
const PROJECT_LOG_TRUNCATION_WARNING_CODE = "PROJECT_LOG_TRUNCATED";
const PROJECT_LOG_MALFORMED_LINE_WARNING_CODE = "PROJECT_LOG_MALFORMED_JSONL";

function historyArchiveError(code, message) {
  return Object.assign(new Error(message), { code });
}

function schemaMismatchError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertHistoryArchiveRecordMatches(record, verified) {
  const segmentId = String(record.segment_id);
  if (
    verified.manifest.database.sha256 !== segmentId ||
    verified.manifest.database.sha256 !== String(record.database_sha256) ||
    verified.candidate.startMs !== Number(record.start_ms) ||
    verified.candidate.endMs !== Number(record.end_ms) ||
    verified.candidate.events.rows !== Number(record.event_count)
  ) {
    throw historyArchiveError(
      "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
      `archive segment ${segmentId} does not match its registered metadata`,
    );
  }
  return segmentId;
}

/**
 * v20: recoverable old event payloads replaced by a successful reparse.
 * There is deliberately no foreign key to source_files: these facts must
 * outlive the current source identity.
 */
const HISTORY_REPLACED_FACTS_DDL = `
  CREATE TABLE IF NOT EXISTS history_replaced_facts (
    fact_table TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    home_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
    payload TEXT NOT NULL,
    source_home_label TEXT NOT NULL,
    source_home_path TEXT NOT NULL,
    method_version TEXT NOT NULL,
    revision_reason TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (fact_table, source_kind, home_id, source_path, payload_digest)
  ) STRICT;
`;

const HISTORY_REPLACED_FACT_METHOD_VERSION = "events.v1";
const HISTORY_REPLACED_QUOTA_METHOD_VERSION = "rate_limit_observations.v1";
const HISTORY_REPLACED_FACT_INSERT_SQL = `
  INSERT INTO history_replaced_facts (
    fact_table, source_kind, home_id, source_path, payload_digest, occurrence_count, payload,
    source_home_label, source_home_path, method_version, revision_reason, recorded_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(fact_table, source_kind, home_id, source_path, payload_digest) DO UPDATE SET
    occurrence_count = MAX(history_replaced_facts.occurrence_count, excluded.occurrence_count)
`;

const HISTORY_REPLACED_FACT_COLUMNS = Object.freeze([
  ["fact_table", "TEXT", 1, 1],
  ["source_kind", "TEXT", 2, 1],
  ["home_id", "TEXT", 3, 1],
  ["source_path", "TEXT", 4, 1],
  ["payload_digest", "TEXT", 5, 1],
  ["occurrence_count", "INTEGER", 0, 1],
  ["payload", "TEXT", 0, 1],
  ["source_home_label", "TEXT", 0, 1],
  ["source_home_path", "TEXT", 0, 1],
  ["method_version", "TEXT", 0, 1],
  ["revision_reason", "TEXT", 0, 1],
  ["recorded_at", "TEXT", 0, 1],
]);

/** v21 reserves segment metadata only; a row is evidence that a later owner registered it. */
const ARCHIVE_SEGMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS archive_segments (
    segment_id TEXT PRIMARY KEY,
    database_path TEXT NOT NULL,
    database_sha256 TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    registered_at_ms INTEGER NOT NULL,
    CHECK (end_ms > start_ms),
    CHECK (event_count >= 0)
  ) STRICT;
`;

const ARCHIVE_SEGMENT_COLUMNS = Object.freeze([
  ["segment_id", "TEXT", 1, 1],
  ["database_path", "TEXT", 0, 1],
  ["database_sha256", "TEXT", 0, 1],
  ["start_ms", "INTEGER", 0, 1],
  ["end_ms", "INTEGER", 0, 1],
  ["event_count", "INTEGER", 0, 1],
  ["registered_at_ms", "INTEGER", 0, 1],
]);

function assertArchiveSegmentsSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(archive_segments)").all();
  if (actualColumns.length !== ARCHIVE_SEGMENT_COLUMNS.length) {
    throw schemaMismatchError(
      "ARCHIVE_SEGMENTS_SCHEMA_MISMATCH",
      `archive_segments 列数 ${actualColumns.length} ≠ 冻结 ${ARCHIVE_SEGMENT_COLUMNS.length}`,
    );
  }
  for (const [index, [name, type, pk, notNull]] of ARCHIVE_SEGMENT_COLUMNS.entries()) {
    const row = actualColumns[index];
    if (
      String(row.name) !== name ||
      String(row.type || "").toUpperCase() !== type ||
      Number(row.pk) !== pk ||
      Number(row.notnull) !== notNull
    ) {
      throw schemaMismatchError(
        "ARCHIVE_SEGMENTS_SCHEMA_MISMATCH",
        `archive_segments 列 ${index} 实际 ${String(row.name)}/${String(row.type)}/pk=${Number(row.pk)}/notnull=${Number(row.notnull)} ≠ 冻结 ${name}/${type}/pk=${pk}/notnull=${notNull}`,
      );
    }
  }
  const ddl = String(
    database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'archive_segments'").get()?.sql ??
      "",
  );
  if (
    !ddl.includes("STRICT") ||
    !ddl.includes("CHECK (end_ms > start_ms)") ||
    !ddl.includes("CHECK (event_count >= 0)")
  ) {
    throw schemaMismatchError("ARCHIVE_SEGMENTS_SCHEMA_MISMATCH", "archive_segments 不是带冻结 CHECK 的 STRICT 表");
  }
}

function assertHistoryReplacedFactsSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(history_replaced_facts)").all();
  if (actualColumns.length !== HISTORY_REPLACED_FACT_COLUMNS.length) {
    throw schemaMismatchError(
      "HISTORY_REPLACED_FACTS_SCHEMA_MISMATCH",
      `history_replaced_facts 列数 ${actualColumns.length} ≠ 冻结 ${HISTORY_REPLACED_FACT_COLUMNS.length}`,
    );
  }
  for (const [index, [name, type, pk, notNull]] of HISTORY_REPLACED_FACT_COLUMNS.entries()) {
    const row = actualColumns[index];
    if (
      String(row.name) !== name ||
      String(row.type || "").toUpperCase() !== type ||
      Number(row.pk) !== pk ||
      Number(row.notnull) !== notNull
    ) {
      throw schemaMismatchError(
        "HISTORY_REPLACED_FACTS_SCHEMA_MISMATCH",
        `history_replaced_facts 列 ${index} 实际 ${String(row.name)}/${String(row.type)}/pk=${Number(row.pk)}/notnull=${Number(row.notnull)} ≠ 冻结 ${name}/${type}/pk=${pk}/notnull=${notNull}`,
      );
    }
  }
  const ddl = String(
    database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'history_replaced_facts'").get()
      ?.sql ?? "",
  );
  if (!ddl.includes("STRICT")) {
    throw schemaMismatchError("HISTORY_REPLACED_FACTS_SCHEMA_MISMATCH", "history_replaced_facts 不是 STRICT 表");
  }
}

function historyPayloadDigest(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function historyArchiveStatementRows(statement, parameters = [], plain = false) {
  if (typeof statement.setReturnArrays !== "function" || typeof statement.columns !== "function") {
    const rows = statement.all(...parameters);
    return plain ? rows.map((row) => ({ ...row })) : rows;
  }
  const columns = statement.columns().map((column) => column.name);
  statement.setReturnArrays(true);
  return Array.from(statement.iterate(...parameters), (values) => {
    // Preserve every SQLite field and prototype without retaining dictionary objects.
    const row = Object.fromEntries(columns.map((name, index) => [name, values[index]]));
    return plain ? row : Object.setPrototypeOf(row, null);
  });
}

function historyArchiveEventRows(database, startMs, endMs) {
  return historyArchiveStatementRows(
    database.prepare("SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY id"),
    [startMs, endMs],
    true,
  );
}

function historyArchiveSourceIdentities(database, startMs, endMs) {
  return database
    .prepare(
      `SELECT sf.path, sf.kind, sf.home_id, sf.home_label, sf.home_path
       FROM source_files sf
       WHERE EXISTS (
         SELECT 1 FROM events e
         WHERE e.source_path = sf.path AND e.timestamp_ms >= ? AND e.timestamp_ms < ?
       )
       ORDER BY sf.path, sf.kind, sf.home_id, sf.home_label, sf.home_path`,
    )
    .all(startMs, endMs)
    .map((row) => ({ ...row }));
}

function historyArchiveEventCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const payload = JSON.stringify(canonicalFactPayload(row, ["id"]));
    counts.set(payload, (counts.get(payload) || 0) + 1);
  }
  return counts;
}

function historyArchiveEventCountsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [payload, count] of left) {
    if (right.get(payload) !== count) return false;
  }
  return true;
}

function historyArchiveRevisionError(message) {
  return historyArchiveError("HISTORY_ARCHIVE_REVISION_INVALID", message);
}

function hasExactObjectKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

const HISTORY_SOURCE_IDENTITY_COLUMNS = Object.freeze(["path", "kind", "home_id", "home_label", "home_path"]);

function historyArchiveRevisionPayload(payload, sourceIdentity, legacy = false) {
  if (
    legacy &&
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    !Object.hasOwn(payload, "source_event_id")
  )
    payload = { ...payload, source_event_id: "" };
  if (!hasExactObjectKeys(payload, EVENT_INSERT_COLUMNS)) {
    throw historyArchiveRevisionError("archive revision payload must contain exactly the event columns without id");
  }
  if (typeof payload.source_path !== "string" || payload.source_path === "") {
    throw historyArchiveRevisionError("archive revision payload source_path must be a non-empty string");
  }
  if (!Number.isSafeInteger(payload.timestamp_ms)) {
    throw historyArchiveRevisionError("archive revision payload timestamp_ms must be a safe integer");
  }
  for (const column of EVENT_INSERT_COLUMNS) {
    if (EVENT_INTEGER_COLUMNS.includes(column)) {
      if (!Number.isSafeInteger(payload[column])) {
        throw historyArchiveRevisionError(`archive revision payload ${column} must be a safe integer`);
      }
    } else if (typeof payload[column] !== "string") {
      throw historyArchiveRevisionError(`archive revision payload ${column} must be a string`);
    }
  }
  for (const column of ["home_id", "home_label"]) {
    if (payload[column] !== sourceIdentity[column]) {
      throw historyArchiveRevisionError(`archive revision payload ${column} does not match its source binding`);
    }
  }
  return payload;
}

function historyArchiveRevisionPayloadKey(payload) {
  return JSON.stringify(canonicalFactPayload({ source_event_id: "", ...payload }, ["id"]));
}

function sameHistoryArchiveSourceIdentity(left, right) {
  return HISTORY_SOURCE_IDENTITY_COLUMNS.every((column) => left[column] === right[column]);
}

function canonicalHistoryArchiveRevisionDeltas(deltas) {
  return deltas
    .map(({ payload, count }) => ({ payload: canonicalFactPayload(payload, ["id"]), count }))
    .sort((left, right) => {
      const leftKey = historyArchiveRevisionPayloadKey(left.payload);
      const rightKey = historyArchiveRevisionPayloadKey(right.payload);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left.count - right.count;
    });
}

function canonicalHistoryArchiveRevisionEntry(entry) {
  return {
    ...(entry.binding ? { binding: entry.binding } : {}),
    sourceIdentity: Object.fromEntries(
      HISTORY_SOURCE_IDENTITY_COLUMNS.map((column) => [column, entry.sourceIdentity[column]]),
    ),
    removed: canonicalHistoryArchiveRevisionDeltas(entry.removed),
    added: canonicalHistoryArchiveRevisionDeltas(entry.added),
  };
}

function historyArchiveRevisionEntryKey(entry) {
  return JSON.stringify(canonicalHistoryArchiveRevisionEntry(entry));
}

function historyRows(rows) {
  return Array.isArray(rows) ? rows : rows.values();
}

function historyArchiveRowsByNativeIdentity(rows, segmentId, byIdentity) {
  for (const row of historyRows(rows)) {
    const key = row.source_event_id
      ? JSON.stringify(["source", row.source_event_id])
      : JSON.stringify([Number(row.timestamp_ms), String(row.session_id)]);
    if (byIdentity.has(key)) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_COLD_REPARSE_CHANGED",
        `archive segment ${segmentId} requires one row per timestamp/session for a cold value revision`,
      );
    }
    byIdentity.set(key, row);
  }
  return byIdentity;
}

function historyArchiveColdRevisionForRows(prefix) {
  const payloadFor = (row) => historyArchiveRevisionPayload(canonicalFactPayload(row, ["id"]), prefix.sourceIdentity);
  // Unchanged duplicates are legal; compare streams before requiring unique native identities.
  const previous = historyRows(prefix.effectiveRows)[Symbol.iterator]();
  const observed = historyRows(prefix.observedRows)[Symbol.iterator]();
  let unchanged = true;
  try {
    for (;;) {
      const left = previous.next(),
        right = observed.next();
      if (left.done || right.done) {
        unchanged = left.done === right.done;
        break;
      }
      if (
        JSON.stringify(sourceFactIdentity(payloadFor(left.value))) !==
        JSON.stringify(sourceFactIdentity(payloadFor(right.value)))
      ) {
        unchanged = false;
        break;
      }
    }
  } finally {
    previous.return?.();
    observed.return?.();
  }
  if (unchanged) return null;
  const originalByIdentity = new UsageSourceRows(0),
    effectiveByIdentity = new UsageSourceRows(0);
  const observedByIdentity = new UsageSourceRows(0),
    deltas = new UsageSourceRows(0);
  try {
    historyArchiveRowsByNativeIdentity(prefix.originalRows, prefix.segmentId, originalByIdentity);
    historyArchiveRowsByNativeIdentity(prefix.effectiveRows, prefix.segmentId, effectiveByIdentity);
    historyArchiveRowsByNativeIdentity(prefix.observedRows, prefix.segmentId, observedByIdentity);
    let removedColdEventCount = 0,
      addedCount = 0;
    for (const identity of effectiveByIdentity.keys()) if (!observedByIdentity.has(identity)) removedColdEventCount++;
    for (const identity of observedByIdentity.keys()) if (!effectiveByIdentity.has(identity)) addedCount++;
    if (
      prefix.sourceIdentity.kind !== "hermes" &&
      (observedByIdentity.size === 0 ||
        (removedColdEventCount > 0 && addedCount > 0) ||
        (removedColdEventCount > 0 && prefix.sourceIdentity.kind !== "project-log"))
    ) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_COLD_REPARSE_CHANGED",
        `reparsed source removes or migrates cold events in authorized segment ${prefix.segmentId}`,
      );
    }

    const previousChangedRows = [],
      currentChangedRows = [];
    for (const [identity, row] of effectiveByIdentity.entries()) {
      const current = observedByIdentity.get(identity);
      if (
        !current ||
        JSON.stringify(sourceFactIdentity(payloadFor(row))) !== JSON.stringify(sourceFactIdentity(payloadFor(current)))
      ) {
        previousChangedRows.push(row);
        if (current) currentChangedRows.push(current);
      }
    }
    for (const [identity, row] of observedByIdentity.entries())
      if (!effectiveByIdentity.has(identity)) currentChangedRows.push(row);
    if (!previousChangedRows.length && !currentChangedRows.length) return null;
    const addPayload = (row, side) => {
      const payload = payloadFor(row);
      const key = historyArchiveRevisionPayloadKey(payload);
      const delta = deltas.get(key) || { payload, originalCount: 0, observedCount: 0 };
      delta[side] += 1;
      deltas.set(key, delta);
    };
    for (const row of originalByIdentity.values()) addPayload(row, "originalCount");
    for (const row of observedByIdentity.values()) addPayload(row, "observedCount");

    const removed = [];
    const added = [];
    for (const { payload, originalCount, observedCount } of deltas.values()) {
      if (originalCount > observedCount) removed.push({ payload, count: originalCount - observedCount });
      else if (observedCount > originalCount) added.push({ payload, count: observedCount - originalCount });
    }
    // Keep the effective payload for recovery; the stored delta remains cumulative from the immutable candidate.
    return {
      entry: {
        ...(prefix.binding ? { binding: prefix.binding } : {}),
        sourceIdentity: { ...prefix.sourceIdentity },
        removed: canonicalHistoryArchiveRevisionDeltas(removed),
        added: canonicalHistoryArchiveRevisionDeltas(added),
      },
      removedColdEventCount,
      previousChangedRows,
      currentChangedRows,
    };
  } finally {
    originalByIdentity.close();
    effectiveByIdentity.close();
    observedByIdentity.close();
    deltas.close();
  }
}

function writeHistoryArchiveEventRevisionState(database, revisionState) {
  const revisions = [];
  for (const [segmentId, entries] of revisionState.revisionsBySegment) {
    const segment = revisionState.segmentsById.get(segmentId);
    for (const entry of entries) {
      revisions.push({
        segmentId,
        databaseSha256: String(segment.database_sha256),
        ...canonicalHistoryArchiveRevisionEntry(entry),
      });
    }
  }
  const statement = database.prepare(
    `INSERT INTO store_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  if (revisions.length === 0) {
    database.prepare("DELETE FROM store_meta WHERE key = ?").run(HISTORY_ARCHIVE_EVENT_REVISIONS_META);
  } else {
    const formatVersion = revisions.some((entry) => entry.binding) ? 2 : 1;
    if (formatVersion === 2) for (const entry of revisions) entry.binding ||= "base";
    statement.run(HISTORY_ARCHIVE_EVENT_REVISIONS_META, JSON.stringify({ formatVersion, revisions }));
  }
}

function markHistoryArchiveRevisionRollupDays(database, previousRows, currentRows) {
  createUsageRollups(database);
  const insertDirty = database.prepare("INSERT OR IGNORE INTO usage_rollup_dirty_days (day_key) VALUES (?)");
  const deleteCoveringDays = database.prepare("DELETE FROM usage_rollup_days WHERE ? >= start_ms AND ? < end_ms");
  const timestamps = new Set([...previousRows, ...currentRows].map((row) => Number(row.timestamp_ms)));
  for (const timestampMs of timestamps) {
    insertDirty.run(new Date(timestampMs).toISOString().slice(0, 10));
    deleteCoveringDays.run(timestampMs, timestampMs);
  }
}

function historyArchiveEventRevisions(rawValue, segmentsById) {
  if (rawValue === undefined) return new Map();
  let root;
  try {
    root = JSON.parse(String(rawValue));
  } catch {
    throw historyArchiveRevisionError("history archive event revisions are not valid JSON");
  }
  if (!hasExactObjectKeys(root, ["formatVersion", "revisions"]) || ![1, 2].includes(root.formatVersion)) {
    throw historyArchiveRevisionError("history archive event revisions must be a version-1 revisions list");
  }
  if (!Array.isArray(root.revisions)) {
    throw historyArchiveRevisionError("history archive event revisions must be an array");
  }

  const revisionsBySegment = new Map();
  const bindings = new Set();
  for (const revision of root.revisions) {
    if (
      !hasExactObjectKeys(
        revision,
        root.formatVersion === 2
          ? ["segmentId", "databaseSha256", "sourceIdentity", "removed", "added", "binding"]
          : ["segmentId", "databaseSha256", "sourceIdentity", "removed", "added"],
      ) ||
      (root.formatVersion === 2 && !["base", "introduced"].includes(revision.binding)) ||
      typeof revision.segmentId !== "string" ||
      typeof revision.databaseSha256 !== "string"
    ) {
      throw historyArchiveRevisionError("archive revision entry is malformed");
    }
    const segment = segmentsById.get(revision.segmentId);
    if (!segment) {
      throw historyArchiveRevisionError(`archive revision targets unregistered segment ${revision.segmentId}`);
    }
    if (revision.databaseSha256 !== segment.database_sha256) {
      throw historyArchiveRevisionError(`archive revision digest does not match segment ${revision.segmentId}`);
    }
    const sourceIdentity = revision.sourceIdentity;
    if (
      !hasExactObjectKeys(sourceIdentity, HISTORY_SOURCE_IDENTITY_COLUMNS) ||
      HISTORY_SOURCE_IDENTITY_COLUMNS.some((key) => typeof sourceIdentity[key] !== "string") ||
      sourceIdentity.path === ""
    ) {
      throw historyArchiveRevisionError(
        `archive revision source binding is malformed for segment ${segment.segment_id}`,
      );
    }
    const binding = JSON.stringify([revision.segmentId, sourceIdentity.path]);
    if (bindings.has(binding)) {
      throw historyArchiveRevisionError(
        `archive revision duplicates segment-source binding ${revision.segmentId}:${sourceIdentity.path}`,
      );
    }
    bindings.add(binding);

    const normalizeDeltas = (value, label) => {
      if (!Array.isArray(value)) {
        throw historyArchiveRevisionError(`archive revision ${label} must be an array`);
      }
      return value.map((delta) => {
        if (
          !hasExactObjectKeys(delta, ["payload", "count"]) ||
          !Number.isSafeInteger(delta.count) ||
          delta.count <= 0
        ) {
          throw historyArchiveRevisionError(`archive revision ${label} entries require a positive integer count`);
        }
        const payload = historyArchiveRevisionPayload(delta.payload, sourceIdentity, root.formatVersion === 1);
        if (payload.source_path !== sourceIdentity.path) {
          throw historyArchiveRevisionError(
            `archive revision ${label} payload source does not match its source binding`,
          );
        }
        if (payload.timestamp_ms < Number(segment.start_ms) || payload.timestamp_ms >= Number(segment.end_ms)) {
          throw historyArchiveRevisionError(
            `archive revision ${label} payload is outside segment ${segment.segment_id}`,
          );
        }
        return { payload, count: delta.count };
      });
    };
    const entry = {
      ...(root.formatVersion === 2 ? { binding: revision.binding } : {}),
      sourceIdentity: { ...sourceIdentity },
      removed: normalizeDeltas(revision.removed, "removed"),
      added: normalizeDeltas(revision.added, "added"),
    };
    if (
      entry.binding === "introduced" &&
      (entry.removed.length || entry.added.some((delta) => !delta.payload.source_event_id))
    ) {
      throw historyArchiveRevisionError("introduced source requires stable identities and cannot remove base events");
    }
    const entries = revisionsBySegment.get(revision.segmentId) || [];
    entries.push(entry);
    revisionsBySegment.set(revision.segmentId, entries);
  }
  return revisionsBySegment;
}

function applyHistoryArchiveEventRevisions(segment, cold, revisions) {
  if (!revisions?.length) return cold.rows;
  let rows = cold.rows;
  for (const revision of revisions) {
    const sourceIdentity = cold.sourceIdentities.find((identity) =>
      sameHistoryArchiveSourceIdentity(identity, revision.sourceIdentity),
    );
    if (!sourceIdentity && revision.binding !== "introduced") {
      throw historyArchiveRevisionError(`archive revision source binding does not match segment ${segment.segment_id}`);
    }
    const removedCounts = new Map();
    for (const removed of revision.removed) {
      const key = historyArchiveRevisionPayloadKey(removed.payload);
      const count = (removedCounts.get(key) || 0) + removed.count;
      removedCounts.set(key, count);
    }

    const remainingRemovals = new Map(removedCounts);
    const revised = [];
    for (const row of rows) {
      if (String(row.source_path) !== revision.sourceIdentity.path) {
        revised.push(row);
        continue;
      }
      const key = historyArchiveRevisionPayloadKey(row);
      const remaining = remainingRemovals.get(key) || 0;
      if (remaining > 0) {
        remainingRemovals.set(key, remaining - 1);
        continue;
      }
      revised.push(row);
    }
    if ([...remainingRemovals.values()].some((count) => count > 0)) {
      throw historyArchiveRevisionError(
        `archive revision removes more payloads than segment ${segment.segment_id} contains`,
      );
    }
    for (const added of revision.added) {
      for (let index = 0; index < added.count; index += 1) {
        revised.push({ id: null, ...added.payload });
      }
    }
    rows = revised;
  }
  return rows;
}

function validateHistoryArchiveSourceRevisions(database, segmentId, sourceIdentities, revisions) {
  if (!revisions?.length) return;
  const eventColumns = new Set(
    database
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((column) => column.name),
  );
  const matchColumns = EVENT_INSERT_COLUMNS.filter((column) => eventColumns.has(column));
  const matches = database.prepare(
    `SELECT * FROM events WHERE ${matchColumns.map((column) => `${column} = ?`).join(" AND ")}`,
  );
  for (const revision of revisions) {
    const source = sourceIdentities.find((identity) => identity.path === revision.sourceIdentity.path);
    if (
      (revision.binding === "introduced" && source) ||
      (revision.binding !== "introduced" &&
        (!source || !sameHistoryArchiveSourceIdentity(source, revision.sourceIdentity)))
    ) {
      throw historyArchiveRevisionError(`archive revision source binding does not match segment ${segmentId}`);
    }
    const removals = new Map();
    for (const removed of revision.removed) {
      const key = historyArchiveRevisionPayloadKey(removed.payload);
      let count = removals.get(key);
      if (!count) {
        count = { needed: 0, available: 0 };
        for (const row of matches.iterate(...matchColumns.map((column) => removed.payload[column]))) {
          // Preserve the original JS payload equality across SQLite string binding.
          if (historyArchiveRevisionPayloadKey(row) === key) count.available++;
        }
        removals.set(key, count);
      }
      count.needed += removed.count;
      if (count.needed > count.available) {
        throw historyArchiveRevisionError(`archive revision removes more payloads than segment ${segmentId} contains`);
      }
    }
  }
}

function* revisedHistorySourceRows(database, sourcePath, revisions) {
  const removals = new UsageSourceRows(0);
  try {
    const revision = revisions.find((entry) => entry.sourceIdentity.path === sourcePath);
    for (const removed of revision?.removed || []) {
      const key = historyArchiveRevisionPayloadKey(removed.payload);
      removals.set(key, Number(removals.get(key) || 0) + removed.count);
    }
    for (const row of database.prepare("SELECT * FROM events WHERE source_path=? ORDER BY id").iterate(sourcePath)) {
      const key = historyArchiveRevisionPayloadKey(row),
        remaining = Number(removals.get(key) || 0);
      if (remaining > 0) removals.set(key, remaining - 1);
      else yield row;
    }
    for (const remaining of removals.values())
      if (remaining > 0) throw historyArchiveRevisionError("archive source revision removes too many payloads");
    for (const added of revision?.added || []) for (let index = 0; index < added.count; index++) yield added.payload;
  } finally {
    removals.close();
  }
}

function publishedUsageEventsFromUnion(union, serviceTierEvidence, resolveQuotaSource) {
  // This request owns the rows; release raw facts as their public projection replaces them.
  for (let index = 0; index < union.rows.length; index += 1) {
    const row = union.rows[index];
    const sourceKind = union.sourceKinds.get(String(row.source_path));
    if (sourceKind === undefined) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_SOURCE_CHANGED",
        `published source ${String(row.source_path)} has no verified source identity`,
      );
    }
    union.rows[index] = publishedUsageEventFromRow(row, sourceKind, serviceTierEvidence, resolveQuotaSource);
  }
  return union.rows;
}

function historyArchiveAuthorizedSegmentIds(database) {
  const authorityValue = database
    .prepare("SELECT value FROM store_meta WHERE key = ?")
    .get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)?.value;
  if (authorityValue === undefined) return new Set();
  let authority;
  try {
    authority = JSON.parse(String(authorityValue));
  } catch {
    throw historyArchiveError("HISTORY_ARCHIVE_AUTHORITY_INVALID", "history archive event authority is not valid JSON");
  }
  if (
    !authority ||
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    Object.keys(authority).sort().join(",") !== "formatVersion,segmentIds" ||
    authority.formatVersion !== 1 ||
    !Array.isArray(authority.segmentIds) ||
    authority.segmentIds.some((segmentId) => typeof segmentId !== "string" || !/^[a-f0-9]{64}$/.test(segmentId)) ||
    new Set(authority.segmentIds).size !== authority.segmentIds.length
  ) {
    throw historyArchiveError(
      "HISTORY_ARCHIVE_AUTHORITY_INVALID",
      "history archive event authority must be a version-1 unique segment id list",
    );
  }
  const registeredSegmentIds = new Set(
    database
      .prepare("SELECT segment_id FROM archive_segments")
      .all()
      .map((segment) => String(segment.segment_id)),
  );
  for (const segmentId of authority.segmentIds) {
    if (!registeredSegmentIds.has(segmentId)) {
      throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_NOT_FOUND", `archive segment ${segmentId} is not registered`);
    }
  }
  return new Set(authority.segmentIds);
}

const EVENT_INSERT_COLUMNS = Object.freeze([
  "source_path",
  "timestamp_ms",
  "session_id",
  "home_id",
  "home_label",
  "channel",
  "project",
  "model",
  "hour_key",
  "day_key",
  "week_key",
  "month_key",
  "cwd",
  "repository_key",
  "repository_path",
  "repository_kind",
  "detail_mask",
  "reconciliation_gap",
  "cache_write_tokens",
  "cache_write_known",
  "request_input_tokens",
  "context_level",
  "service_tier",
  "price_version",
  "total",
  "input",
  "cached",
  "output",
  "reasoning",
  "source_event_id",
]);

const EVENT_INTEGER_COLUMNS = Object.freeze([
  "timestamp_ms",
  "detail_mask",
  "reconciliation_gap",
  "cache_write_tokens",
  "cache_write_known",
  "request_input_tokens",
  "total",
  "input",
  "cached",
  "output",
  "reasoning",
]);

function saveMissingHistoryFacts(
  insertReplacedFact,
  { factTable, source, previousRows, currentRows, methodVersion, excludedColumns = [] },
) {
  const currentCounts = new UsageSourceRows(0),
    previousCounts = new UsageSourceRows(0);
  try {
    for (const row of historyRows(currentRows)) {
      const payloadDigest = historyPayloadDigest(sourceFactIdentity(row, excludedColumns));
      currentCounts.set(payloadDigest, (currentCounts.get(payloadDigest) || 0) + 1);
    }
    for (const row of historyRows(previousRows)) {
      const payload = canonicalFactPayload(row, excludedColumns);
      const payloadDigest = historyPayloadDigest(payload);
      const existing = previousCounts.get(payloadDigest);
      previousCounts.set(payloadDigest, {
        payload,
        count: (existing?.count || 0) + 1,
      });
    }
    const recordedAt = new Date().toISOString();
    for (const [payloadDigest, previous] of previousCounts.entries()) {
      const identity = historyPayloadDigest(sourceFactIdentity(previous.payload));
      const available = currentCounts.get(identity) || 0;
      const matched = Math.min(previous.count, available);
      currentCounts.set(identity, available - matched);
      const missingCount = previous.count - matched;
      if (missingCount <= 0) continue;
      insertReplacedFact.run(
        factTable,
        String(source.kind),
        String(source.home_id),
        String(source.path),
        payloadDigest,
        missingCount,
        JSON.stringify(previous.payload),
        String(source.home_label),
        String(source.home_path),
        methodVersion,
        "reparse_replaced",
        recordedAt,
      );
    }
  } finally {
    currentCounts.close();
    previousCounts.close();
  }
}

const CODEX_ROLLOUT_READER_VERSION = "zstd-jsonl-v1";

/** Source replacement retains an exact multiset on disk instead of two event arrays and JS maps. */
class UsageReplacementFacts {
  constructor(sourceDatabase) {
    this.sourceDatabase = sourceDatabase;
    this.database = null;
  }

  capture(table, sourcePath) {
    for (const row of this.sourceDatabase.prepare(`SELECT * FROM ${table} WHERE source_path=?`).iterate(sourcePath)) {
      if (!this.database) {
        this.database = new DatabaseSync("");
        this.database.exec(`PRAGMA cache_size=-1024; PRAGMA temp_store=FILE;
          CREATE TABLE facts(fact_table TEXT,source_path TEXT,digest TEXT,payload TEXT,identity TEXT,
            previous_count INTEGER,current_count INTEGER DEFAULT 0,
            PRIMARY KEY(fact_table,source_path,digest)) WITHOUT ROWID;
          CREATE INDEX facts_identity ON facts(fact_table,source_path,identity,digest); BEGIN`);
      }
      const payload = JSON.stringify(canonicalFactPayload(row, table === "events" ? ["id"] : []));
      const digest = createHash("sha256").update(payload).digest("hex");
      this.database
        .prepare(`INSERT INTO facts(fact_table,source_path,digest,payload,identity,previous_count)
        VALUES (?,?,?,?,?,1) ON CONFLICT(fact_table,source_path,digest)
        DO UPDATE SET previous_count=previous_count+1`)
        .run(
          table,
          sourcePath,
          digest,
          payload,
          historyPayloadDigest(sourceFactIdentity(row, table === "events" ? ["id"] : [])),
        );
    }
  }

  save(insert, table, source, methodVersion) {
    if (!this.database) return { previousCount: 0, currentCount: 0 };
    const previousCount = Number(
      this.database
        .prepare(`SELECT COALESCE(SUM(previous_count),0) AS n
      FROM facts WHERE fact_table=? AND source_path=?`)
        .get(table, source.path).n,
    );
    if (!previousCount) return { previousCount: 0, currentCount: 0 };
    const update = this.database.prepare(`UPDATE facts SET current_count=current_count+1
      WHERE fact_table=? AND source_path=? AND digest=(SELECT digest FROM facts WHERE fact_table=? AND source_path=? AND identity=? AND current_count<previous_count ORDER BY digest LIMIT 1)`);
    let currentCount = 0;
    for (const row of this.sourceDatabase.prepare(`SELECT * FROM ${table} WHERE source_path=?`).iterate(source.path)) {
      const payload = canonicalFactPayload(row, table === "events" ? ["id"] : []);
      update.run(table, source.path, table, source.path, historyPayloadDigest(sourceFactIdentity(payload)));
      currentCount += 1;
    }
    const at = new Date().toISOString();
    for (const row of this.database
      .prepare(`SELECT digest,payload,previous_count-current_count AS missing
      FROM facts WHERE fact_table=? AND source_path=? AND previous_count>current_count`)
      .iterate(table, source.path)) {
      insert.run(
        table,
        String(source.kind),
        String(source.home_id),
        String(source.path),
        row.digest,
        Number(row.missing),
        row.payload,
        String(source.home_label),
        String(source.home_path),
        methodVersion,
        "reparse_replaced",
        at,
      );
    }
    return { previousCount, currentCount };
  }

  coversRelocated(table, previousPath, currentPath) {
    if (!this.database) return true;
    this.database.exec("CREATE TABLE relocation(digest TEXT PRIMARY KEY,remaining INTEGER) WITHOUT ROWID");
    try {
      // price_version is stamped by the local catalog, not read from the rollout; retain its old value in replaced facts.
      const excluded = table === "events" ? ["id", "price_version"] : [];
      const insert = this.database.prepare(`INSERT INTO relocation VALUES (?,?)
        ON CONFLICT(digest) DO UPDATE SET remaining=remaining+excluded.remaining`);
      for (const row of this.database
        .prepare("SELECT payload,previous_count FROM facts WHERE fact_table=? AND source_path=?")
        .iterate(table, previousPath)) {
        insert.run(
          historyPayloadDigest(sourceFactIdentity(JSON.parse(String(row.payload)), excluded)),
          row.previous_count,
        );
      }
      const consume = this.database.prepare(
        "UPDATE relocation SET remaining=remaining-1 WHERE digest=? AND remaining>0",
      );
      for (const row of this.sourceDatabase
        .prepare(`SELECT * FROM ${table} WHERE source_path=?`)
        .iterate(currentPath)) {
        const payload = sourceFactIdentity({ ...row, source_path: previousPath }, excluded);
        consume.run(historyPayloadDigest(payload));
      }
      return !this.database.prepare("SELECT 1 FROM relocation WHERE remaining>0 LIMIT 1").get();
    } finally {
      this.database.exec("DROP TABLE relocation");
    }
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function localHourKey(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  return `${localDateKey(date)} ${hour}:00`;
}

function sourceEventRow(filePath, event) {
  const date = new Date(event.timestampMs);
  return {
    source_path: filePath,
    timestamp_ms: event.timestampMs,
    session_id: event.sessionId,
    home_id: event.homeId,
    home_label: event.homeLabel,
    channel: event.channel,
    project: event.project || "Unknown cwd",
    model: event.model || "Unknown model",
    hour_key: localHourKey(date),
    day_key: localDateKey(date),
    week_key: localDateKey(startOfLocalWeek(date)),
    month_key: localDateKey(date).slice(0, 7),
    cwd: event.project || "",
    repository_key: event.repositoryKey || "unknown:cwd",
    repository_path: event.repositoryPath || "Unknown cwd",
    repository_kind: event.repositoryKind || "unknown",
    detail_mask: Number(event.detailMask || 0),
    reconciliation_gap: Number(event.reconciliationGap || 0),
    cache_write_tokens: Number(event.cacheWriteTokens || 0),
    cache_write_known: event.cacheWriteKnown ? 1 : 0,
    request_input_tokens: Number(event.requestInputTokens || 0),
    context_level: event.contextLevel || "unknown",
    service_tier: event.serviceTier || "unknown",
    price_version: event.priceVersion || "",
    total: event.usage.total,
    input: event.usage.input,
    cached: event.usage.cached,
    output: event.usage.output,
    reasoning: event.usage.reasoning,
    source_event_id: event.sourceEventId || "",
  };
}

function addCumulativeFingerprint(hash, row) {
  hash.update(
    JSON.stringify([
      row.home_id,
      row.session_id,
      row.timestamp_ms,
      row.total,
      row.input,
      row.cached,
      row.output,
      row.reasoning,
      Number(row.detail_mask) & 15,
      row.cache_write_tokens,
      row.cache_write_known,
    ]),
  );
  hash.update("\n");
}

function sourceSessionId(checkpoint, filePath) {
  return checkpoint.adapter === "codex-jsonl"
    ? checkpoint.state.meta.id
    : checkpoint.state.header.id || path.basename(path.dirname(filePath));
}

function sameSourceBinding(existing, source) {
  return (
    existing &&
    existing.kind === (source.kind || "codex") &&
    existing.home_id === source.id &&
    existing.home_label === source.label &&
    existing.home_path === source.path
  );
}

// Bound the probe as before; use it for usage-file stability and rename identity.
function usageSourceFingerprint(filePath) {
  let handle;
  try {
    const info = statSync(filePath);
    const wal = statSync(`${filePath}-wal`, { throwIfNoEntry: false });
    const hash = createHash("sha256");
    handle = openSync(filePath, "r");
    const length = Math.min(info.size, 64 * 1024);
    for (const offset of info.size > length ? [0, info.size - length] : [0]) {
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = readSync(handle, bytes, read, length - read, offset + read);
        if (!count) return null;
        read += count;
      }
      hash.update(bytes);
    }
    return `${info.size + (wal?.size || 0)}:${Math.max(info.mtimeMs, wal?.size ? wal.mtimeMs : 0)}:${hash.digest("hex")}`;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

// The round can overlap I/O; transaction-bound checks keep the synchronous reader above.
async function asyncUsageSourceFingerprint(filePath) {
  let handle;
  try {
    const info = await stat(filePath);
    const wal = await stat(`${filePath}-wal`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    const hash = createHash("sha256");
    handle = await open(filePath, "r");
    const length = Math.min(info.size, 64 * 1024);
    const bytes = Buffer.alloc(length);
    for (const offset of info.size > length ? [0, info.size - length] : [0]) {
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
        if (!bytesRead) return null;
        read += bytesRead;
      }
      hash.update(bytes);
    }
    return `${info.size + (wal?.size || 0)}:${Math.max(info.mtimeMs, wal?.size ? wal.mtimeMs : 0)}:${hash.digest("hex")}`;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Decode retained-but-missing source identities. Missing sources keep their
 * `source_files` row so facts and native ownership remain queryable; this
 * metadata only adds the current physical-availability state.
 */
function decodeMissingSources(raw) {
  if (raw === undefined || raw === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry) => entry && typeof entry === "object" && typeof entry.path === "string" && entry.path !== "")
    .map((entry) => ({
      path: String(entry.path),
      kind: String(entry.kind ?? ""),
      homeId: String(entry.homeId ?? ""),
      homeLabel: String(entry.homeLabel ?? ""),
      homePath: String(entry.homePath ?? ""),
      missingSinceMs: Number.isSafeInteger(Number(entry.missingSinceMs)) ? Number(entry.missingSinceMs) : 0,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizePublishedFileWarnings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (
      entry?.sourceKind !== "project-log" ||
      ![PROJECT_LOG_TRUNCATION_WARNING_CODE, PROJECT_LOG_MALFORMED_LINE_WARNING_CODE].includes(entry?.code)
    )
      return [];
    const normalized = {
      sourceKind: String(entry?.sourceKind ?? "").trim(),
      homeId: String(entry?.homeId ?? "").trim(),
      code: String(entry?.code ?? "").trim(),
      count: Number.isFinite(Number(entry?.count)) ? Number(entry?.count) : 0,
    };
    if (normalized.sourceKind === "" && normalized.homeId === "" && normalized.code === "") return [];
    if (normalized.code !== PROJECT_LOG_MALFORMED_LINE_WARNING_CODE) return [normalized];
    const lineNumbers = Array.isArray(entry?.lineNumbers)
      ? [...new Set(entry.lineNumbers.map(Number).filter((line) => Number.isSafeInteger(line) && line > 0))].sort(
          (left, right) => left - right,
        )
      : [];
    return [{ ...normalized, lineNumbers }];
  });
}

function formatProjectLogTruncationWarning(filePath, lostEvents) {
  return `project-log 来源文件缩短（截断）：${filePath}（丢失 ${Number(lostEvents)} 条事件）`;
}

function formatProjectLogMalformedLineWarning(filePath, lineNumber) {
  return `project-log 来源存在无法解析的 JSONL 行：${filePath}（第 ${Number(lineNumber)} 行）`;
}

function completeHistoryRollupDays(database, events, calendarZone = "utc") {
  const days = new Set();
  let firstMs = Infinity;
  let lastMs = -Infinity;
  if (events === null) {
    const bounds = database
      .prepare("SELECT MIN(timestamp_ms) AS first_ms, MAX(timestamp_ms) AS last_ms FROM events")
      .get();
    if (bounds.first_ms !== null) {
      firstMs = Number(bounds.first_ms);
      lastMs = Number(bounds.last_ms);
    }
  } else {
    for (const event of events) {
      const timestamp = Date.parse(event.timestamp);
      if (!Number.isFinite(timestamp)) throw new TypeError("complete history contains an invalid event timestamp");
      firstMs = Math.min(firstMs, timestamp);
      lastMs = Math.max(lastMs, timestamp);
    }
  }
  if (firstMs <= lastMs) {
    const firstUtcDay = new Date(Math.floor(firstMs / 86_400_000) * 86_400_000);
    const lastUtcDay = new Date(Math.floor(lastMs / 86_400_000) * 86_400_000);
    const utcDays = [];
    for (let cursor = firstUtcDay; cursor.getTime() <= lastUtcDay.getTime(); cursor = new Date(addDaysMs(cursor, 1))) {
      utcDays.push(cursor.toISOString().slice(0, 10));
    }
    if (calendarZone === "utc") {
      for (const day of utcDays) days.add(day);
    } else {
      // The module owns local calendar iteration so DST days are not fixed 24h steps.
      const firstLocalDay = localDateKey(new Date(firstMs));
      const lastLocalDay = localDateKey(new Date(lastMs));
      for (const day of localUsageRollupDaysForUtcDays(utcDays)) {
        if (day >= firstLocalDay && day <= lastLocalDay) days.add(day);
      }
    }
  }
  const tables = ["usage_rollup_days", "usage_rollup_daily", "usage_rollup_sessions"];
  // Model rows are lazily created by a non-empty rebuild, so a fresh store may not have this table yet.
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_rollup_models'").get()) {
    tables.splice(2, 0, "usage_rollup_models");
  }
  const sources = tables.map((table) => `SELECT day_key FROM ${table} WHERE calendar_zone = ?`).join(" UNION ");
  for (const row of database.prepare(sources).all(...tables.map(() => calendarZone))) {
    days.add(String(row.day_key));
  }
  return [...days].sort();
}

export function createUsageFactStoreClass(QueryOwner) {
  return class UsageStore extends QueryOwner {
    constructor(options = {}) {
      super();
      this.options = options;
      this.queryReadView = null;
      this.metadataCache = null;
      this.businessProjectionIgnoredChanges = 0;

      /** Period-comparison results keyed by time scope and the catalog used for model normalization. */
      this.periodComparisonCache = new Map();
      this.ownsPeriodComparisonCache = true;
      /** @type {{ query: UsageHistoryQuery, key: string, cache: Map<string, any> } | null} */
      this.historyPeriodComparisonCache = null;

      this.databaseFile =
        options.databaseFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "usage-index.sqlite");
      this.database = null;
      /** Per-read model catalog context for the `usage_model_group` UDF. */
      this.ownsDatabase = true;
      this.homes = [];
      this.warnings = [];
      this.generatedAt = "";
      this.fingerprint = "";
      this.checkedAt = "";
      this.repositoryResolver = createRepositoryResolver();
      this.sourceProof = new UsageSourceProof();
      this.sourceAcquisition = null;
      this.lastSyncSourceWork = null;
      this.quotaSourceEvidence = null;
      /** @type {ReturnType<typeof createStoredQuotaSourceResolver> | null} */
      this.quotaSourceLookup = null;
      this.quotaSourceDatabase = null;
      this.quotaSourceRevision = -1;
      /**
       * Per-sync cache of the ordinary project-log diagnostics sidecar.
       * @type {{ warnings: Record<string, {sourceKind: string, homeId: string, code: string, count: number, lineNumbers?: number[]}[]> | null } | null}
       */
      this.publishedFileWarningsView = null;
      // ── D1 卡：实例修订 + 外部提交检测 ────────────────────────────────────────────────────────

      this.storeRevision = 0;
      /** D1：派生缓存（`metadataCache` / `periodComparisonCache`）当前对齐到的修订。 */
      this.derivedRevision = 0;
      /** 内部读快照：命中时跳过嵌套修订探测；共享缓存仍按快照前修订读写。 */
      this.periodComparisonSnapshotRead = false;
      /** Metadata history reads pin the marker and synchronous metadata in one savepoint. */
      this.metadataSnapshotRead = false;
      /** Summary history reads use the same guard for their marker + hot-summary savepoint. */
      this.summarySnapshotRead = false;
      /** D1：本连接上一次观察到的 `PRAGMA data_version`（外部提交检测的基准，`open()` 里取初值）。 */
      this.observedDataVersion = 0;
      /** D1：检出过多少次**外部提交**（诊断用；不落盘、不进 report、不建计数表）。 */
      this.externalCommitCount = 0;
      /** D1：最近一次推进修订的理由（诊断用；同上）。 */
      this.lastCommitReason = "";
      /**
       * D1：本连接上**自己开的**写事务深度（只有 `replaceFile` 会跨 `await`，因此只需要它）。
       * `> 0` ⇒ 读路径读到的是**未提交**状态 ⇒ `metadata()` / `periodComparison()` **不落**派生缓存
       * （验收："事务内已读的派生缓存被安全清理"；预防 + 回滚时再清一次，见
       * {@link UsageStore#rollbackReplaceFileTransaction}）。
       */
      this.writeTransactionDepth = 0;

      /**
       * C19 static summary projection: one instance-private all-hot entry for
       * timeline/cost and grouped detail rows. Dynamic range/quota/clock/status
       * remain outside this slot.
       * @type {{ key: string, factsKey: string, publicationKey?: string, contextKey?: string, context?: any, guard?: any, evidence?: any, projection: object, quoteInputs: any } | null}
       */
      this.summaryProjectionCache = null;
      /** @type {{ database: DatabaseSync, owned: boolean, mainSchema: number, tempSchema: number, tempCatalog: string } | null} */
      this.usageProjectionTracker = null;
      this.observedUsageProjectionChanges = "";
      this.observedPublicationChanges = -1;
      this.summaryProjectionTransferableRead = false;
      this.openedUsageProjectionIdentity = null;
      this.openedUsageProjectionChanges = -1;
      /** SQL history projections stay separate from every hot-only public reader. */
      this.historySqlDashboardCache = null;
      this.verifiedHistorySqlRead = false;
      this.historyDiskRead = false;
      this.historyPersistentRead = false;
      this.publishedHistoryProjection = false;
      this.historyProjectionInput = null;
      this.historyProjectionModule = null;
      this.historyProjectionStore = null;
      /** @type {UsageStore | null} */
      this.historyVerificationOwner = null;
      this.historySourceKinds = null;
      /**
       * D3：**已提交 quota 观测的规范映射**（单槽，见 {@link UsageStore#quotaObservations}）。
       *
       * 契约（本卡红线）：缓存里**只有静态输入**——`rate_limit_observations` 已提交行的字段映射。
       * **不含**任何时间派生字段（窗口边界 / `state` / `percentStale` / 倒计时 / reset 语义）：
       * 那些一律由消费者**每次**用当前或冻结的 `asOf` 现算（`selectQuotaWindows(rows, asOf)`、
       * `resolveDateRange({ …filters, now: asOf, quota })`），因此"冻结快照"与"live 读数"各按自己的
       * `asOf` 成立。
       *
       * 键 = D1 的实例修订（`storeRevision`）；`syncDerivedRevision()` / `open()` / `close()` 复位；
       * 写事务内（`writeTransactionDepth > 0`）**不读也不写**（D1 的回滚语义）。
       * @type {{ revision: number, rows: object[] } | null}
       */
      this.quotaObservationCache = null;
    }

    async open() {
      if (this.database) {
        return;
      }
      this.sourceProof ||= new UsageSourceProof();
      this.clearEditionQueryCaches?.("open");
      this.ownsDatabase = true;
      this.metadataCache = null;
      if (!this.ownsPeriodComparisonCache) {
        this.periodComparisonCache = new Map();
        this.ownsPeriodComparisonCache = true;
      }
      this.periodComparisonCache.clear();
      // D4：观测聚合缓存同为连接级状态（键含实例修订，但连接/库可能已换）⇒ 重开时一并复位。
      // D2：历史冠军 memo 是**连接级**状态（键含实例修订，但连接/库可能已换）⇒ 重开时一并复位。
      this.summaryProjectionCache = null;
      // D3：quota 观测映射同为连接级状态（键含实例修订，但连接/库可能已换）⇒ 重开时一并复位。
      this.quotaObservationCache = null;
      await mkdir(path.dirname(this.databaseFile), { recursive: true });
      this.database = new DatabaseSync(
        this.databaseFile === ":memory:" ? this.databaseFile : path.toNamespacedPath(this.databaseFile),
      );
      removeLegacyUsageRecordTriggers(this.database);
      this.registerReadFunctions();
      this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA journal_size_limit = 67108864;
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        home_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        channel TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        hour_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        repository_key TEXT NOT NULL DEFAULT 'unknown:cwd',
        repository_path TEXT NOT NULL DEFAULT 'Unknown cwd',
        repository_kind TEXT NOT NULL DEFAULT 'unknown',
        detail_mask INTEGER NOT NULL DEFAULT 0,
        reconciliation_gap INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_known INTEGER NOT NULL DEFAULT 0,
        request_input_tokens INTEGER NOT NULL DEFAULT 0,
        context_level TEXT NOT NULL DEFAULT 'unknown',
        service_tier TEXT NOT NULL DEFAULT 'unknown',
        price_version TEXT NOT NULL DEFAULT '',
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL,
        source_event_id TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rate_limit_observations (
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        line_number INTEGER NOT NULL CHECK (line_number > 0),
        role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
        observed_at_ms INTEGER NOT NULL,
        limit_id TEXT NOT NULL,
        limit_name TEXT,
        plan_type TEXT,
        window_minutes REAL NOT NULL CHECK (window_minutes > 0),
        resets_at_ms INTEGER NOT NULL,
        used_percent REAL CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
        PRIMARY KEY (source_path, line_number, role)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_home_idx ON events(home_id);
      CREATE INDEX IF NOT EXISTS events_channel_idx ON events(channel);
      CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);
      CREATE INDEX IF NOT EXISTS events_model_idx ON events(model);
      CREATE INDEX IF NOT EXISTS rate_limit_window_lookup_idx ON rate_limit_observations(limit_id, window_minutes, observed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS rate_limit_source_line_idx ON rate_limit_observations(source_path, line_number);
    `);
      let version = Number(this.database.prepare("PRAGMA user_version").get().user_version || 0);
      /**
       * 独立事务的迁移段：`BEGIN IMMEDIATE` → SQL → **事务内自检** → 抬版本 → `COMMIT`。
       * `verify` 可选：只在事务内核对"实际 schema 等于冻结 DDL"，不符即抛 ⇒ `ROLLBACK` ⇒
       * 版本保持旧值（不得把旧索引当成已升级；`CREATE TABLE IF NOT EXISTS` 会静默接受错形状的旧表）。
       * @param {string} sql @param {number} nextVersion @param {(() => void) | undefined} [verify]
       */
      const migrate = (sql, nextVersion, verify) => {
        this.database.exec("BEGIN IMMEDIATE");
        try {
          this.database.exec(sql);
          if (verify) verify();
          this.database.exec(`PRAGMA user_version = ${nextVersion}`);
          this.database.exec("COMMIT");
        } catch (error) {
          this.database.exec("ROLLBACK");
          this.database.close();
          this.database = null;
          throw error;
        }
      };
      if (version === 1) {
        migrate(
          [
            "ALTER TABLE events ADD COLUMN cwd TEXT NOT NULL DEFAULT '';",
            "ALTER TABLE events ADD COLUMN repository_key TEXT NOT NULL DEFAULT 'unknown:cwd';",
            "ALTER TABLE events ADD COLUMN repository_path TEXT NOT NULL DEFAULT 'Unknown cwd';",
            "ALTER TABLE events ADD COLUMN repository_kind TEXT NOT NULL DEFAULT 'unknown';",
            "ALTER TABLE events ADD COLUMN detail_mask INTEGER NOT NULL DEFAULT 0;",
            "ALTER TABLE events ADD COLUMN reconciliation_gap INTEGER NOT NULL DEFAULT 0;",
            "UPDATE events SET cwd = project;",
            "UPDATE source_files SET size = -1, mtime_ms = -1;",
          ].join("\n"),
          2,
        );
        version = 2;
      }
      if (version === 2) {
        migrate(
          [
            "ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;",
            "ALTER TABLE events ADD COLUMN cache_write_known INTEGER NOT NULL DEFAULT 0;",
            "ALTER TABLE events ADD COLUMN request_input_tokens INTEGER NOT NULL DEFAULT 0;",
            "ALTER TABLE events ADD COLUMN context_level TEXT NOT NULL DEFAULT 'unknown';",
            "ALTER TABLE events ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'unknown';",
            "ALTER TABLE events ADD COLUMN price_version TEXT NOT NULL DEFAULT '';",
            "UPDATE source_files SET size = -1, mtime_ms = -1;",
          ].join("\n"),
          3,
        );
        version = 3;
      }
      if (version === 3) {
        migrate(
          `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE path IN (SELECT DISTINCT source_path FROM events WHERE context_level = 'unknown' AND total > 0);
      `,
          4,
        );
        version = 4;
      }
      if (version === 4) {
        migrate(
          `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE path IN (
          SELECT source_path FROM events WHERE session_id IN (
            SELECT session_id FROM events GROUP BY session_id HAVING COUNT(DISTINCT source_path) > 1
          )
        );
      `,
          5,
        );
        version = 5;
      }
      if (version === 5) {
        migrate(
          `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `,
          6,
        );
        version = 6;
      }
      if (version === 6) {
        // Earlier quota parsing looked for limit_id inside primary/secondary.
        // Codex writes it on rate_limits, so unchanged session files need a reindex.
        migrate(
          `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `,
          7,
        );
        version = 7;
      }
      if (version === 7) {
        // A new rollout can inherit cumulative token counters from another
        // conversation. Recompute Codex events from their first request usage.
        migrate(
          `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `,
          8,
        );
        version = 8;
      }
      if (version === 8) {
        // v9 新增 DSH 数据源。表结构没变，因此无需重扫既有数据；
        // 旧索引里不存在 kind='dsh' 的行，升级后第一次 sync 会直接纳入它们。
        // 这里只抬版本号，为将来真正需要重扫的迁移留出位置。
        // 落点必须用字面量：若用 STORE_SCHEMA_VERSION 常量，后续抬版本会静默跳过新迁移。
        migrate("SELECT 1;", 9);
        version = 9;
      }
      if (version === 9) {
        // v10 新增 OpenCode 数据源。同 v9，表结构没变，只抬版本号；
        // 旧索引里不存在 kind='opencode' 的行，升级后第一次 sync 会直接纳入它们。
        migrate("SELECT 1;", 10);
        version = 10;
      }
      if (version === 10) {
        // DSH v4 input is uncached input. Re-read unchanged source files so
        // nonzero cache writes become part of total input in historical events.
        migrate("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind = 'dsh';", 11);
        version = 11;
      }
      if (version >= 11 && version < 15) {
        // Skip the retired TPS tables while retaining the subsequent Claude usage migration.
        migrate("SELECT 1;", 15);
        version = 15;
      }
      if (version === 15) {
        // v16: Claude usage events use the served model rather than the requested alias.
        migrate("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind = 'claude';", 16);
        version = 16;
      }
      if (version >= 16 && version < 20) {
        // v17-v19 retired TPS migrations are skipped.
        migrate(HISTORY_REPLACED_FACTS_DDL, 20, () => assertHistoryReplacedFactsSchema(this.database));
        version = 20;
      }
      if (version === 20) {
        migrate(ARCHIVE_SEGMENTS_DDL, 21, () => assertArchiveSegmentsSchema(this.database));
        version = 21;
      }
      if (version === 21) {
        // v22 previously rebuilt a TPS table. Keep its rows untouched.
        migrate("SELECT 1;", 22);
        version = 22;
      }
      if (version === 22) {
        migrate(
          `${QUOTA_SOURCES_DDL}
        UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind IN ('main', 'jetbrains', 'extra', 'codex');`,
          23,
        );
        version = 23;
      }
      if (version === 23) {
        // schema 24 removes TPS from the runtime schema without rewriting legacy tables.
        migrate("SELECT 1;", 24);
        version = 24;
      }
      if (version === 24) {
        const hasIdentity = this.database
          .prepare("PRAGMA table_info(events)")
          .all()
          .some((row) => row.name === "source_event_id");
        migrate(
          `${hasIdentity ? "" : "ALTER TABLE events ADD COLUMN source_event_id TEXT NOT NULL DEFAULT '';"}
        CREATE INDEX IF NOT EXISTS events_source_event_id ON events(source_path, source_event_id)
        WHERE source_event_id <> '';`,
          25,
        );
        version = 25;
      }
      if (version !== 0 && version !== STORE_SCHEMA_VERSION) {
        this.database.close();
        this.database = null;
        throw new Error(`不支持的用量索引版本：${version}`);
      }
      if (version === 0) {
        this.database.exec(`${QUOTA_SOURCES_DDL}\n${HISTORY_REPLACED_FACTS_DDL}\n${ARCHIVE_SEGMENTS_DDL}`);
        assertHistoryReplacedFactsSchema(this.database);
        assertArchiveSegmentsSchema(this.database);
        this.database.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
      }
      const identityIndex = this.database
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='events_source_event_id'")
        .get();
      if (/\bUNIQUE\b/i.test(String(identityIndex?.sql || ""))) this.database.exec("DROP INDEX events_source_event_id");
      this.database.exec(`CREATE INDEX IF NOT EXISTS events_source_event_id ON events(source_path, source_event_id) WHERE source_event_id <> '';
      CREATE TRIGGER IF NOT EXISTS events_source_event_id_insert BEFORE INSERT ON events
      WHEN NEW.source_event_id <> '' AND EXISTS(SELECT 1 FROM events WHERE source_path=NEW.source_path
        AND source_event_id=NEW.source_event_id AND (NEW.id=-1 OR id<>NEW.id))
      BEGIN SELECT RAISE(ABORT,'duplicate source event identity'); END;
      CREATE TRIGGER IF NOT EXISTS events_source_event_id_update BEFORE UPDATE OF source_path,source_event_id ON events
      WHEN NEW.source_event_id <> '' AND EXISTS(SELECT 1 FROM events WHERE source_path=NEW.source_path
        AND source_event_id=NEW.source_event_id AND id<>OLD.id)
      BEGIN SELECT RAISE(ABORT,'duplicate source event identity'); END;`);
      this.database.exec(`${QUOTA_SOURCES_DDL}\n${HISTORY_REPLACED_FACTS_DDL}\n${ARCHIVE_SEGMENTS_DDL}`);
      assertHistoryReplacedFactsSchema(this.database);
      assertArchiveSegmentsSchema(this.database);
      this.database.exec("CREATE INDEX IF NOT EXISTS events_repository_idx ON events(repository_key)");
      this.database.exec("CREATE INDEX IF NOT EXISTS events_source_path_idx ON events(source_path)");
      this.database.exec(`CREATE INDEX IF NOT EXISTS quota_sources_thread_time_idx
      ON quota_usage_sources(home_id, session_id, timestamp_ms)`);
      this.database.exec(`CREATE INDEX IF NOT EXISTS quota_sources_account_time_idx
      ON quota_usage_sources(home_id, timestamp_ms) WHERE quota_source IN ('credits', 'plan')`);
      this.database.exec(
        "CREATE INDEX IF NOT EXISTS events_session_home_time_idx ON events(session_id, home_id, timestamp_ms)",
      );
      createUsageRollups(this.database);
      this.prepareEditionSchema?.();
      ensureUsageQuotaSchema(this.database);
      ensureUsageSourceProgressSchema(this.database);
      ensureUsageSourceCatalog(this.database);
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS usage_business_revision (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL
      ) STRICT;
    `);
      if (!this.database.prepare("SELECT 1 FROM usage_business_revision WHERE singleton = 1").get()) {
        this.database.exec("INSERT INTO usage_business_revision VALUES (1, 0)");
      }
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        this.database.exec(`CREATE TRIGGER IF NOT EXISTS usage_business_events_${operation}
        AFTER ${operation} ON events BEGIN
          UPDATE usage_business_revision SET revision = revision + 1 WHERE singleton = 1;
        END`);
      }
      this.prepareEditionSummarySchema?.();
      this.deferredMetadataIndex = this.readMetaRaw(DEFERRED_METADATA_INDEX_META) === "1";
      if (
        !this.deferredMetadataIndex &&
        !this.database.prepare("SELECT 1 FROM events LIMIT 1").get() &&
        !this.database.prepare("SELECT 1 FROM source_files LIMIT 1").get() &&
        !this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='events_metadata_group_time_idx'").get() &&
        !this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)
      ) {
        this.writeMeta(DEFERRED_METADATA_INDEX_META, "1");
        this.deferredMetadataIndex = true;
      }
      ensureUsageMetadataSchema(this.database, { deferIndex: this.deferredMetadataIndex });
      if (this.readMetaRaw("codex_rollout_reader_version") !== CODEX_ROLLOUT_READER_VERSION) {
        // Re-read existing Codex events once: readline used to split valid Unicode JSON strings.
        this.database.exec("BEGIN");
        try {
          this.database.exec(
            "UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')",
          );
          this.writeMeta("codex_rollout_reader_version", CODEX_ROLLOUT_READER_VERSION);
          this.database.exec("COMMIT");
        } catch (error) {
          this.database.exec("ROLLBACK");
          throw error;
        }
      }
      this.generatedAt = this.readMeta("generated_at");
      const quotaEvidence = this.readMetaRaw("quota_source_log_evidence");
      if (quotaEvidence) this.quotaSourceEvidence = quotaSourceEvidenceFromSnapshot(JSON.parse(quotaEvidence));
      this.quotaSourceRevision = -1;
      this.fingerprint = this.readMeta("fingerprint");
      // ── D1 卡：外部提交检测的**基准** ──────────────────────────────────────────────────────────
      // 必须在**所有迁移/建表之后**取：上面那些 `BEGIN IMMEDIATE … COMMIT` 是**本连接**的提交，
      // `PRAGMA data_version` 不会因它们而变；而基准取早了会把"自己迁移"误判成"外部提交"。
      this.observedDataVersion = this.readDataVersion();
      // 两个派生缓存刚在上面清空 ⇒ 它们与当前修订是**对齐**的（`open()` 不是一次提交）。
      this.derivedRevision = this.storeRevision;
      this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
      this.openedUsageProjectionIdentity = this.usageProjectionDatabaseIdentity();
      this.openedUsageProjectionChanges = Number(this.database.prepare("SELECT total_changes() AS value").get().value);
      this.observedPublicationChanges = this.openedUsageProjectionChanges;
    }

    usageProjectionDatabaseIdentity() {
      try {
        const file = this.database
          .prepare("PRAGMA database_list")
          .all()
          .find((row) => row.name === "main")?.file;
        if (!file) return null;
        const physical = realpathSync(String(file));
        if (physical !== realpathSync(path.toNamespacedPath(this.databaseFile))) return null;
        const info = statSync(physical, { bigint: true });
        return `${physical}\u0000${info.dev}\u0000${info.ino}`;
      } catch {
        return null;
      }
    }

    // Only acquisition may ignore owned cold bookkeeping; transferable query caches keep the default gate.
    usageProjectionGuard({ includeHistory = false } = {}) {
      try {
        if (
          this.verifiedHistorySqlRead ||
          !this.usageProjectionChangeKey(undefined, includeHistory).startsWith("usage:")
        )
          return null;
        const identity = this.usageProjectionDatabaseIdentity();
        if (!identity || identity !== this.openedUsageProjectionIdentity) return null;
        // A failed version read cannot certify a transferable snapshot.
        const dataVersion = Number(this.database.prepare("PRAGMA data_version").get().data_version);
        if (!Number.isSafeInteger(dataVersion)) return null;
        return { database: this.database, identity, dataVersion, ...this.queryEvidenceGuard?.() };
      } catch {
        return null;
      }
    }

    installUsageProjectionTracker() {
      if (this.usageProjectionTracker?.database === this.database) {
        for (const table of [...USAGE_PROJECTION_IGNORED_TABLES, ...(this.editionProjectionTables || []), "store_meta"])
          for (const operation of ["INSERT", "UPDATE", "DELETE"])
            this.database.exec(`DROP TRIGGER IF EXISTS temp.usage_projection_${table}_${operation}`);
        this.database.exec("DROP TABLE temp.usage_projection_ignored_rows");
        this.businessProjectionIgnoredChanges = 0;
      }
      this.usageProjectionTracker = null;
      this.database.exec(`CREATE TEMP TABLE usage_projection_ignored_rows (value INTEGER NOT NULL, owned INTEGER NOT NULL) STRICT;
      INSERT INTO usage_projection_ignored_rows VALUES (0, 0);`);
      const keys = USAGE_PROJECTION_IGNORED_META.map((key) => `'${key}'`).join(",");
      for (const table of [...USAGE_PROJECTION_IGNORED_TABLES, ...(this.editionProjectionTables || []), "store_meta"]) {
        if (
          table.startsWith("usage_history_projection_") &&
          !this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
        )
          continue;
        for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
          // REPLACE can silently remove an unrelated metadata row through its hidden rowid.
          if (table === "store_meta" && operation === "INSERT") continue;
          const references = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
          const metadata =
            table === "store_meta" ? references.map((row) => `${row}.key IN (${keys})`).join(" AND ") : "1";
          const rowid = table === "store_meta" && operation === "UPDATE" ? " AND OLD.rowid = NEW.rowid" : "";
          const when = `(SELECT owned FROM usage_projection_ignored_rows) = 0
          AND (SELECT recursive_triggers FROM pragma_recursive_triggers) = 0 AND ${metadata}${rowid}`;
          this.database.exec(`CREATE TEMP TRIGGER usage_projection_${table}_${operation}
          AFTER ${operation} ON main.${table} WHEN ${when}
          BEGIN UPDATE usage_projection_ignored_rows SET value = value + 1; END;`);
        }
      }
      this.usageProjectionTracker = {
        database: this.database,
        owned: false,
        mainSchema: Number(this.database.prepare("PRAGMA main.schema_version").get().schema_version),
        tempSchema: Number(this.database.prepare("PRAGMA temp.schema_version").get().schema_version),
        tempCatalog: JSON.stringify(
          this.database.prepare("SELECT type, name, tbl_name, sql FROM temp.sqlite_master ORDER BY type, name").all(),
        ),
      };
    }

    usageProjectionChangeKey(
      totalChanges = Number(this.database.prepare("SELECT total_changes() AS value").get().value),
      includeHistory = false,
    ) {
      const tracker = this.usageProjectionTracker;
      if (!tracker || tracker.database !== this.database) return `full:${totalChanges}`;
      const mainSchema = Number(this.database.prepare("PRAGMA main.schema_version").get().schema_version);
      const tempSchema = Number(this.database.prepare("PRAGMA temp.schema_version").get().schema_version);
      const recursive = Number(this.database.prepare("PRAGMA recursive_triggers").get().recursive_triggers);
      const fallback = `full:${mainSchema}:${tempSchema}:${recursive}:${totalChanges}`;
      // REPLACE's implicit delete is omitted from total_changes even when DELETE triggers fire.
      if (mainSchema !== tracker.mainSchema || tempSchema !== tracker.tempSchema || recursive !== 0) return fallback;
      if (
        !includeHistory &&
        this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)
      )
        return fallback;
      const ignored = Number(this.database.prepare("SELECT value FROM usage_projection_ignored_rows").get()?.value);
      const changes = totalChanges - 2 * ignored - this.businessProjectionIgnoredChanges;
      return Number.isSafeInteger(ignored) && ignored >= 0 && Number.isSafeInteger(changes) && changes >= 0
        ? `usage:${changes}:${Number(this.database.prepare("SELECT revision FROM usage_business_revision WHERE singleton=1").get().revision)}`
        : fallback;
    }

    // ── D1 卡：实例修订 / 外部提交检测 / 写事务卫生 ────────────────────────────────────────────

    /**
     * D1：读**同连接**的 `PRAGMA data_version`。
     *
     * SQLite 语义（这是本卡成立的前提）：**别的连接**提交过 ⇒ 该值变化；**本连接自己**的提交
     * **不**改它。⇒ 自身提交必须走 {@link UsageStore#commitStoreRevision} 的**显式修订**，
     * 外部提交才走这里的比对（卡面："自身提交仍用显式修订"）。
     *
     * 读不到（未 `open()` / 库刚被关掉）时返回上次观察值 ⇒ **永不抛**（读路径不得因它失败）。
     * @returns {number}
     */
    readDataVersion() {
      if (!this.database) return this.observedDataVersion;
      try {
        return Number(this.database.prepare("PRAGMA data_version").get()?.data_version ?? 0) || 0;
      } catch {
        return this.observedDataVersion;
      }
    }

    commitStoreRevision(reason = "commit") {
      this.storeRevision += 1;
      this.lastCommitReason = String(reason);
      return this.storeRevision;
    }

    /**
     * D1：检出**外部提交**（同连接 `PRAGMA data_version` 变化 ⇒ 别的连接提交过）。
     *
     * 命中 ⇒ ① 修订 +1（这是一次**真实的、已提交的**视图变化）② **重载必要元数据**：
     * `generated_at` / `fingerprint` 由**提交方**写进 `store_meta`，本实例内存里的副本已过期。
     * 派生缓存不在这里直接清 —— 统一由 {@link UsageStore#syncDerivedRevision} 按"修订对齐"清。
     * @returns {boolean} 本次是否检出外部提交
     */
    detectExternalCommit() {
      if (!this.database) return false;
      const observed = this.readDataVersion();
      if (observed === this.observedDataVersion) return false;
      this.observedDataVersion = observed;
      this.externalCommitCount += 1;
      if (this.publishedFileWarningsView) this.publishedFileWarningsView.warnings = null;
      this.commitStoreRevision("external");
      try {
        this.generatedAt = this.readMeta("generated_at");
        this.fingerprint = this.readMeta("fingerprint");
        const quotaEvidence = this.readMetaRaw("quota_source_log_evidence");
        if (quotaEvidence) this.quotaSourceEvidence = quotaSourceEvidenceFromSnapshot(JSON.parse(quotaEvidence));
      } catch {
        // 库在两步之间被换掉/关掉 ⇒ 保持原值：读路径不得因为"元数据重载"而抛错。
      }
      return true;
    }

    syncDerivedRevision() {
      if (this.summarySnapshotRead || this.writeTransactionDepth > 0) return false;
      this.detectExternalCommit();
      const totalChanges = Number(this.database.prepare("SELECT total_changes() AS value").get().value);
      if (this.observedPublicationChanges !== totalChanges) {
        this.generatedAt = this.readMeta("generated_at");
        this.fingerprint = this.readMeta("fingerprint");
        this.observedPublicationChanges = totalChanges;
      }
      const usageChanges = this.usageProjectionChangeKey(totalChanges);
      const localUsageChanged = this.observedUsageProjectionChanges !== usageChanges;
      if (this.derivedRevision === this.storeRevision && !localUsageChanged) return false;
      this.metadataCache = null;
      this.periodComparisonCache.clear();
      // D4：观测聚合缓存同为"用量侧静态输入"派生物 ⇒ 与上面两个缓存同一失效入口。
      // D3：quota 观测的**规范映射**同为"用量侧静态输入"派生物 ⇒ 与上面两个缓存同一失效入口。
      this.quotaObservationCache = null;
      if (localUsageChanged) this.summaryProjectionCache = null;
      this.observedUsageProjectionChanges = usageChanges;
      // W4-b1 / D1：事件计价 memo 的输入是"事件内容 + 生效价目"，**不含**修订；这里清空是**保守**的
      // 内存卫生（旧修订的事件可能已被删除/重写），不是正确性的必要条件 —— 键不同就绝不会命中。
      this.clearEditionQueryCaches?.("store-revision");
      this.derivedRevision = this.storeRevision;
      return true;
    }

    /**
     * D1：`replaceFile` 的回滚出口（**唯一的跨 `await` 写事务**）。
     *
     * 验收明文："回滚 ⇒ **不伪造成功变更**；事务内已读的派生缓存被**安全清理**"。
     *   * 这里**不**推进修订（那次替换没有提交）；
     *   * 事务内可能被读到的派生缓存**一律清掉**（配合 `writeTransactionDepth > 0` 时的"不落缓存"，
     *     保证不会留下与已提交状态不符的缓存）。
     */
    rollbackReplaceFileTransaction() {
      if (this.writeTransactionDepth > 0) this.writeTransactionDepth -= 1;
      this.metadataCache = null;
      this.periodComparisonCache.clear();
      // D4：回滚后派生缓存一并失效（含观测聚合）。
    }

    readMeta(key) {
      return String(this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key)?.value || "");
    }

    /** 与 {@link UsageStore#readMeta} 同义，但**保留 `undefined`** —— 用于区分"键缺失"与"空串"（AN-6）。 */
    readMetaRaw(key) {
      const row = this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key);
      return row === undefined ? undefined : String(row.value);
    }

    writeMeta(key, value) {
      this.database
        .prepare(
          "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(key, String(value));
    }

    /** Read the diagnostics committed with the current source representations. */
    readPublishedFileWarnings() {
      const raw = this.readMetaRaw("perf_file_warnings");
      if (typeof raw !== "string" || raw === "") return {};
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        /** @type {Record<string, {sourceKind: string, homeId: string, code: string, count: number, lineNumbers?: number[]}[]>} */
        const out = {};
        for (const [filePath, warnings] of Object.entries(parsed)) {
          const entries = normalizePublishedFileWarnings(warnings);
          if (entries.length > 0) out[filePath] = entries;
        }
        return out;
      } catch {
        return {};
      }
    }

    publishedFileWarningsForRound() {
      const view = this.publishedFileWarningsView;
      if (view === null) return this.readPublishedFileWarnings();
      if (view.warnings === null) view.warnings = this.readPublishedFileWarnings();
      return { ...view.warnings };
    }

    sourceState() {
      return {
        missingSources: decodeMissingSources(this.readMetaRaw(MISSING_SOURCES_META)),
      };
    }

    captureArchiveMaintenanceGuard() {
      if (this.database.isTransaction || this.writeTransactionDepth)
        throw new Error("Archive maintenance requires an idle connection");
      return {
        database: this.database,
        identity: this.usageProjectionDatabaseIdentity(),
        version: this.readDataVersion(),
        changes: this.database.prepare("SELECT total_changes() AS n").get().n,
      };
    }

    /** Called after the maintenance coordinator has verified both packages and their complete logical equivalence. */
    rebindHistoryArchiveReferences(replacements, guard) {
      if (this.database.isTransaction || this.writeTransactionDepth)
        throw new Error("Archive maintenance requires an idle connection");
      this.database.exec("BEGIN IMMEDIATE");
      this.writeTransactionDepth++;
      try {
        if (
          guard.database !== this.database ||
          guard.identity !== this.usageProjectionDatabaseIdentity() ||
          guard.version !== this.readDataVersion() ||
          guard.changes !== this.database.prepare("SELECT total_changes() AS n").get().n
        )
          throw historyArchiveError(
            "HISTORY_ARCHIVE_COMPACTION_CHANGED",
            "database changed during archive maintenance",
          );
        const records = this.database.prepare("SELECT * FROM archive_segments").all();
        const segmentsById = new Map(records.map((row) => [String(row.segment_id), row]));
        const authority = historyArchiveAuthorizedSegmentIds(this.database);
        const revisionsBySegment = historyArchiveEventRevisions(
          this.readMetaRaw(HISTORY_ARCHIVE_EVENT_REVISIONS_META),
          segmentsById,
        );
        const before = this.historyProjectionModule.readHistoryProjectionStamp(this.database);
        for (const { previous, next } of replacements) {
          const from = previous.segment_id,
            to = next.segment_id;
          if (JSON.stringify(segmentsById.get(from)) !== JSON.stringify(previous) || segmentsById.has(to))
            throw historyArchiveError(
              "HISTORY_ARCHIVE_COMPACTION_CHANGED",
              "archive registry changed during maintenance",
            );
          this.database
            .prepare("UPDATE archive_segments SET segment_id=?,database_path=?,database_sha256=? WHERE segment_id=?")
            .run(to, next.database_path, to, from);
          segmentsById.delete(from);
          segmentsById.set(to, next);
          if (authority.delete(from)) authority.add(to);
          if (revisionsBySegment.has(from)) {
            revisionsBySegment.set(to, revisionsBySegment.get(from));
            revisionsBySegment.delete(from);
          }
        }
        if (this.readMetaRaw(HISTORY_ARCHIVE_EVENT_AUTHORITY_META) !== undefined)
          this.writeMeta(
            HISTORY_ARCHIVE_EVENT_AUTHORITY_META,
            JSON.stringify({ formatVersion: 1, segmentIds: [...authority].sort() }),
          );
        writeHistoryArchiveEventRevisionState(this.database, { revisionsBySegment, segmentsById });
        this.historyProjectionModule.recordHistoryProjectionBatch(this.database, before, {
          mode: "rebind",
          rebindings: replacements.map(({ previous, next }) => [previous.segment_id, next.segment_id]),
        });
        this.database.exec("COMMIT");
        this.writeTransactionDepth--;
        this.commitStoreRevision("history-archive-rebind");
        this.syncDerivedRevision();
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } finally {
          this.rollbackReplaceFileTransaction();
        }
        throw error;
      }
    }

    async registerHistoryArchiveCandidate(candidateFile, manifestFile = undefined) {
      await this.open();
      // Keep archive verification lazy for normal index startup.
      const { assertHistoryArchiveSourceMatches, verifyHistoryArchiveCandidate } = await import("./history-archive.js");
      const verified = await verifyHistoryArchiveCandidate(candidateFile, manifestFile);
      if (!verified.ok || !verified.candidate) {
        throw new TypeError("verifiedCandidate must be the result of verifyHistoryArchiveCandidate");
      }
      const segmentId = String(verified.manifest.database.sha256);
      const databasePath = path.resolve(verified.databaseFile);
      const { startMs, endMs } = verified.candidate;
      const eventCount = Number(verified.candidate.events.rows);
      const registeredAtMs = Date.now();
      if (historyArchiveAuthorizedSegmentIds(this.database).size) await this.ensureHistoryProjectionTracking();

      this.database.exec("BEGIN IMMEDIATE");
      try {
        const projectionBefore = this.historyProjectionModule?.readHistoryProjectionStamp(this.database);
        assertHistoryArchiveSourceMatches(this.database, verified);
        const existing = this.database
          .prepare(
            `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
           FROM archive_segments WHERE segment_id = ?`,
          )
          .get(segmentId);
        if (existing) {
          if (
            String(existing.database_sha256) !== segmentId ||
            Number(existing.start_ms) !== startMs ||
            Number(existing.end_ms) !== endMs ||
            Number(existing.event_count) !== eventCount
          ) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_SEGMENT_CONFLICT",
              `archive segment ${segmentId} is already registered with different metadata`,
            );
          }
          this.database.exec("COMMIT");
          return {
            inserted: false,
            segmentId,
            databasePath: String(existing.database_path),
            databaseSha256: String(existing.database_sha256),
            startMs: Number(existing.start_ms),
            endMs: Number(existing.end_ms),
            eventCount: Number(existing.event_count),
            registeredAtMs: Number(existing.registered_at_ms),
          };
        }

        const overlap = this.database
          .prepare(
            `SELECT segment_id, start_ms, end_ms FROM archive_segments
           WHERE start_ms < ? AND end_ms > ? LIMIT 1`,
          )
          .get(endMs, startMs);
        if (overlap) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_SEGMENT_OVERLAP",
            `archive range overlaps registered segment ${String(overlap.segment_id)}`,
          );
        }

        this.database
          .prepare(
            `INSERT INTO archive_segments (
             segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(segmentId, databasePath, segmentId, startMs, endMs, eventCount, registeredAtMs);
        if (projectionBefore)
          this.historyProjectionModule.recordHistoryProjectionBatch(this.database, projectionBefore, {
            mode: "archive",
          });
        this.database.exec("COMMIT");
        return {
          inserted: true,
          segmentId,
          databasePath,
          databaseSha256: segmentId,
          startMs,
          endMs,
          eventCount,
          registeredAtMs,
        };
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }

    /**
     * Atomically publish one prepared archive segment and remove its hot events.
     * @param {Record<string, any>} plan
     */
    async commitHistoryArchiveEvents(plan) {
      await this.open();
      if (this.database.isTransaction) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_COMMIT_TRANSACTION_ACTIVE",
          "archive commit requires no active source transaction",
        );
      }
      this.syncDerivedRevision();
      const { assertHistoryArchiveCommitPlan, prepareHistoryArchiveCommit, verifyHistoryArchiveCandidate } =
        await import("./history-archive.js");
      if (realpathSync.native(path.resolve(this.databaseFile)) !== plan?.source?.databaseFile) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_COMMIT_SOURCE_MISMATCH",
          "archive commit plan was prepared for a different source database",
        );
      }
      this.database.exec("BEGIN IMMEDIATE");
      this.writeTransactionDepth += 1;
      try {
        const segmentId = String(plan?.candidate?.databaseSha256 ?? "");
        const existing = this.database
          .prepare(
            `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count
           FROM archive_segments WHERE segment_id = ?`,
          )
          .get(segmentId);
        const authorized = historyArchiveAuthorizedSegmentIds(this.database);
        const candidate = plan?.candidate;
        if (existing && authorized.has(segmentId)) {
          const verified = await verifyHistoryArchiveCandidate(
            String(candidate?.databaseFile),
            candidate?.manifestFile === undefined ? undefined : String(candidate.manifestFile),
          );
          if (
            String(existing.database_path) !== path.resolve(verified.databaseFile) ||
            String(existing.database_sha256) !== verified.manifest.database.sha256 ||
            Number(existing.start_ms) !== verified.candidate.startMs ||
            Number(existing.end_ms) !== verified.candidate.endMs ||
            Number(existing.event_count) !== verified.candidate.events.rows ||
            candidate.databaseSha256 !== verified.manifest.database.sha256 ||
            candidate.databaseFile !== verified.databaseFile ||
            candidate.manifestFile !== verified.manifestFile ||
            candidate.startMs !== verified.candidate.startMs ||
            candidate.endMs !== verified.candidate.endMs ||
            JSON.stringify(candidate.events) !== JSON.stringify(verified.candidate.events) ||
            JSON.stringify(candidate.sources) !== JSON.stringify(verified.candidate.sources)
          ) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_COMMIT_CANDIDATE_MISMATCH",
              "registered archive segment no longer matches the supplied plan",
            );
          }
          const remaining = Number(
            this.database
              .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
              .get(verified.candidate.startMs, verified.candidate.endMs).count,
          );
          if (remaining !== 0) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
              `archive replay left ${remaining} hot event(s) in the sealed range`,
            );
          }
          this.database.exec("ROLLBACK");
          this.writeTransactionDepth -= 1;
          this.syncDerivedRevision();
          return {
            segmentId,
            inserted: false,
            replay: true,
            startMs: verified.candidate.startMs,
            endMs: verified.candidate.endMs,
            deletedEventCount: 0,
            eventCount: verified.candidate.events.rows,
          };
        }
        if (existing) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_COMMIT_CANDIDATE_MISMATCH",
            `archive segment ${segmentId} is registered without authority`,
          );
        }

        const prepared = await prepareHistoryArchiveCommit(this.database, String(candidate?.databaseFile));
        assertHistoryArchiveCommitPlan(prepared, plan);
        if (authorized.size) await this.ensureHistoryProjectionTracking();
        const projectionBefore = this.historyProjectionModule?.readHistoryProjectionStamp(this.database);
        const overlap = this.database
          .prepare(
            `SELECT segment_id FROM archive_segments
           WHERE start_ms < ? AND end_ms > ? LIMIT 1`,
          )
          .get(candidate.endMs, candidate.startMs);
        if (overlap) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_SEGMENT_OVERLAP",
            `archive range overlaps registered segment ${String(overlap.segment_id)}`,
          );
        }
        this.database
          .prepare(
            `INSERT INTO archive_segments (
             segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            segmentId,
            String(candidate.databaseFile),
            segmentId,
            candidate.startMs,
            candidate.endMs,
            candidate.events.rows,
            Date.now(),
          );
        authorized.add(segmentId);
        this.writeMeta(
          HISTORY_ARCHIVE_EVENT_AUTHORITY_META,
          JSON.stringify({ formatVersion: 1, segmentIds: [...authorized].sort() }),
        );

        createUsageRollups(this.database);
        const rollupDays = this.database.prepare("SELECT * FROM usage_rollup_days").all();
        const dirtyDays = this.database.prepare("SELECT day_key FROM usage_rollup_dirty_days").all();
        const deleteEvent = this.database.prepare(
          "DELETE FROM events WHERE id = ? AND timestamp_ms >= ? AND timestamp_ms < ?",
        );
        let deleted = 0;
        for (const id of plan.deletion.ids) {
          deleted += Number(deleteEvent.run(id, candidate.startMs, candidate.endMs).changes);
        }
        if (deleted !== plan.deletion.ids.length) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
            `archive commit deleted ${deleted} event(s), expected ${plan.deletion.ids.length}`,
          );
        }
        const remaining = Number(
          this.database
            .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
            .get(candidate.startMs, candidate.endMs).count,
        );
        if (remaining !== 0) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
            `archive commit left ${remaining} hot event(s) in the sealed range`,
          );
        }
        // Moving verified, unchanged facts preserves rollups; retain any dirty work that predates the move.
        this.database.exec("DELETE FROM usage_rollup_days; DELETE FROM usage_rollup_dirty_days");
        const restoreDay = this.database.prepare("INSERT INTO usage_rollup_days VALUES (?, ?, ?, ?)");
        for (const day of rollupDays) restoreDay.run(day.calendar_zone, day.day_key, day.start_ms, day.end_ms);
        const restoreDirty = this.database.prepare("INSERT INTO usage_rollup_dirty_days (day_key) VALUES (?)");
        for (const day of dirtyDays) restoreDirty.run(day.day_key);
        if (projectionBefore)
          this.historyProjectionModule.recordHistoryProjectionBatch(this.database, projectionBefore, {
            sources: prepared.source.sources.map((source) => String(source.path)),
            mode: "archive",
          });
        this.database.exec("COMMIT");
        this.writeTransactionDepth -= 1;
        this.commitStoreRevision("history-archive-commit");
        this.syncDerivedRevision();
        return {
          segmentId,
          inserted: true,
          replay: false,
          startMs: candidate.startMs,
          endMs: candidate.endMs,
          deletedEventCount: deleted,
          eventCount: candidate.events.rows,
        };
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } finally {
          this.rollbackReplaceFileTransaction();
        }
        throw error;
      }
    }

    /**
     * Read one registered archive segment without merging it into hot facts.
     * @param {string} segmentId
     * @returns {Promise<Array<Record<string, unknown>>>}
     */
    async readHistoryArchiveEvents(segmentId) {
      if (typeof segmentId !== "string" || segmentId.length === 0) {
        throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_NOT_FOUND", "archive segment id is required");
      }
      await this.open();
      const record = this.database
        .prepare(
          `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         FROM archive_segments WHERE segment_id = ?`,
        )
        .get(segmentId);
      if (!record) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
          `archive segment ${segmentId} is not registered`,
        );
      }

      const snapshot = await this.readHistoryArchiveSnapshot(record);
      return snapshot.rows;
    }

    /**
     * Read one keyset page of original sealed events without hot/overlay data.
     * @param {string} segmentId
     * @param {{startMs: number, endMs: number, afterId?: number, limit?: number} | undefined} range
     */
    async readHistoryArchiveEventPage(segmentId, range) {
      const { startMs, endMs, afterId = 0, limit = 100 } = range ?? {};
      if (typeof segmentId !== "string" || segmentId.length === 0) {
        throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_NOT_FOUND", "archive segment id is required");
      }
      if (
        !Number.isSafeInteger(startMs) ||
        !Number.isSafeInteger(endMs) ||
        startMs >= endMs ||
        !Number.isSafeInteger(afterId) ||
        afterId < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500
      ) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_EVENT_PAGE_INVALID",
          "event page requires safe integer startMs < endMs, afterId >= 0, and limit 1..500",
        );
      }
      await this.open();
      const record = this.database
        .prepare(
          `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         FROM archive_segments WHERE segment_id = ?`,
        )
        .get(segmentId);
      if (!record) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
          `archive segment ${segmentId} is not registered`,
        );
      }
      const page = await this.readHistoryArchiveSnapshot(record, { startMs, endMs, afterId, limit });
      return {
        segmentId,
        view: "sealed",
        range: { startMs, endMs },
        events: page.rows,
        nextAfterId: page.nextAfterId,
      };
    }

    /**
     * Read one captured registry record and its source identities from one
     * verified cold snapshot. Internal to archived range reads.
     * @param {Record<string, unknown>} record
     * @param {{startMs: number, endMs: number, afterId: number, limit: number} | null} [page]
     * @param {{path: string, revisions: any[], onRow?: (row: any) => void} | null} [sourceScope]
     * @returns {Promise<{
     *   rows: Array<Record<string, unknown>>,
     *   sourceIdentities: Array<Record<string, unknown>>,
     *   nextAfterId?: number | null
     * }>}
     */
    async readHistoryArchiveSnapshot(record, page = null, sourceScope = null) {
      const { withVerifiedHistoryArchiveCandidate } = await import("./history-archive.js");
      const eventCount = Number(record.event_count);
      return withVerifiedHistoryArchiveCandidate(String(record.database_path), undefined, (database, verified) => {
        const segmentId = assertHistoryArchiveRecordMatches(record, verified);
        if (sourceScope) {
          const total = Number(database.prepare("SELECT COUNT(*) AS count FROM events").get().count);
          if (total !== eventCount) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
              `archive segment ${segmentId} contains ${total} event(s), expected ${eventCount}`,
            );
          }
          const sourceIdentities = historyArchiveSourceIdentities(
            database,
            Number(record.start_ms),
            Number(record.end_ms),
          );
          validateHistoryArchiveSourceRevisions(database, segmentId, sourceIdentities, sourceScope.revisions);
          const statement = database.prepare("SELECT * FROM events WHERE source_path = ? ORDER BY id");
          if (sourceScope.onRow) {
            for (const row of statement.iterate(sourceScope.path)) sourceScope.onRow(row);
            return { rows: [], sourceIdentities };
          }
          return { rows: historyArchiveStatementRows(statement, [sourceScope.path]), sourceIdentities };
        }
        if (page) {
          const total = Number(database.prepare("SELECT COUNT(*) AS count FROM events").get().count);
          if (total !== eventCount) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
              `archive segment ${segmentId} contains ${total} event(s), expected ${eventCount}`,
            );
          }
          const rows = historyArchiveStatementRows(
            database.prepare(
              `SELECT * FROM events
             WHERE timestamp_ms >= ? AND timestamp_ms < ? AND id > ?
             ORDER BY id LIMIT ?`,
            ),
            [page.startMs, page.endMs, page.afterId, page.limit + 1],
          );
          const hasMore = rows.length > page.limit;
          if (hasMore) rows.pop();
          return {
            rows,
            nextAfterId: hasMore ? Number(rows[rows.length - 1].id) : null,
            sourceIdentities: [],
          };
        }
        const rows = historyArchiveStatementRows(database.prepare("SELECT * FROM events ORDER BY id"));
        if (rows.length !== eventCount) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
            `archive segment ${segmentId} contains ${rows.length} event(s), expected ${eventCount}`,
          );
        }
        return {
          rows,
          sourceIdentities: historyArchiveSourceIdentities(database, Number(record.start_ms), Number(record.end_ms)),
        };
      });
    }

    /**
     * Load the authorized cold prefixes for one source reparse. The returned
     * rows are the only part of the re-parsed file allowed to stay cold.
     * @param {string} filePath
     * @param {Record<string, unknown>} source
     * @param {{reuseProjection?: boolean}} [options]
     * @returns {Promise<{prefixes: any[], revisionState: any | null, usedProjection?: boolean}>}
     */
    async historyArchiveReparsePrefixes(filePath, source, { reuseProjection = false } = {}) {
      const authorizedSegmentIds = historyArchiveAuthorizedSegmentIds(this.database);
      if (authorizedSegmentIds.size === 0) return { prefixes: [], revisionState: null };
      const allRecords = this.database
        .prepare(
          `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         FROM archive_segments
         ORDER BY start_ms, segment_id`,
        )
        .all();
      const segmentsById = new Map(allRecords.map((record) => [String(record.segment_id), record]));
      const revisionsBySegment = historyArchiveEventRevisions(
        this.readMetaRaw(HISTORY_ARCHIVE_EVENT_REVISIONS_META),
        segmentsById,
      );
      const records = allRecords.filter((record) => authorizedSegmentIds.has(String(record.segment_id)));
      const prefixes = [];
      const owned = new Set();
      let published = null;
      const projectionIdentity =
        reuseProjection && this.historyProjectionModule && source.kind !== "hermes"
          ? this.usageProjectionDatabaseIdentity()
          : null;
      if (
        projectionIdentity &&
        ![...revisionsBySegment.values()].some((rows) => rows.some((row) => row.sourceIdentity.path === filePath))
      ) {
        this.historyProjectionStore ||= new this.historyProjectionModule.HistoryProjectionStore(
          this.databaseFile,
          canonicalFactPayload,
        );
        published = this.historyProjectionStore.openPublished(
          this.database,
          projectionIdentity,
          currentLocalRollupZoneIdentity(),
        );
      }
      try {
        for (const record of records) {
          const revisions = revisionsBySegment.get(String(record.segment_id)) || [];
          const originalRows = new UsageSourceRows(0);
          owned.add(originalRows);
          const startMs = Number(record.start_ms),
            endMs = Number(record.end_ms);
          let ordinal = 0;
          const onRow = (row) => {
            if (Number(row.timestamp_ms) >= startMs && Number(row.timestamp_ms) < endMs)
              originalRows.set(String(ordinal++), { ...row });
          };
          let snapshot;
          if (published) {
            for (const row of published.database
              .prepare("SELECT payload FROM history_query_rows WHERE segment_id=? AND source_path=? ORDER BY rowid")
              .iterate(String(record.segment_id), filePath))
              onRow({ id: null, ...JSON.parse(String(row.payload)) });
            const identity = ordinal
              ? published.database
                  .prepare("SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?")
                  .get(filePath)
              : null;
            snapshot = { sourceIdentities: identity ? [identity] : [] };
          } else
            snapshot = await this.readHistoryArchiveSnapshot(record, null, {
              path: filePath,
              revisions,
              onRow,
            });
          const coldSource = snapshot.sourceIdentities.find((source) => String(source.path) === filePath);
          if (!coldSource && source.kind !== "hermes") {
            originalRows.close();
            owned.delete(originalRows);
            continue;
          }
          const liveIdentity = {
            path: filePath,
            kind: String(source.kind || "codex"),
            home_id: String(source.id ?? ""),
            home_label: String(source.label ?? ""),
            home_path: String(source.path ?? ""),
          };
          if (coldSource && !sameHistoryArchiveSourceIdentity(liveIdentity, coldSource)) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_COLD_REPARSE_CHANGED",
              `live source identity no longer matches authorized archive segment ${String(record.segment_id)}`,
            );
          }
          const revision = revisions.find((entry) => entry.sourceIdentity.path === filePath);
          if (revision && !sameHistoryArchiveSourceIdentity(liveIdentity, revision.sourceIdentity)) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_COLD_REPARSE_CHANGED",
              "archive revision source identity changed",
            );
          }
          let effectiveRows = originalRows;
          if (revision) {
            effectiveRows = new UsageSourceRows(0);
            owned.add(effectiveRows);
            const removals = new UsageSourceRows(0);
            try {
              for (const removed of revision.removed)
                removals.set(historyArchiveRevisionPayloadKey(removed.payload), removed.count);
              ordinal = 0;
              for (const row of originalRows.values()) {
                const key = historyArchiveRevisionPayloadKey(row),
                  count = Number(removals.get(key) || 0);
                if (count) removals.set(key, count - 1);
                else effectiveRows.set(String(ordinal++), row);
              }
              for (const count of removals.values())
                if (count) throw historyArchiveRevisionError("archive source revision removes too many payloads");
              for (const added of revision.added)
                for (let index = 0; index < added.count; index++) {
                  const row = { id: null, ...added.payload };
                  if (Number(row.timestamp_ms) >= startMs && Number(row.timestamp_ms) < endMs)
                    effectiveRows.set(String(ordinal++), row);
                }
            } finally {
              removals.close();
            }
          }
          const observedRows = new UsageSourceRows(0);
          owned.add(observedRows);
          prefixes.push({
            segmentId: String(record.segment_id),
            startMs,
            endMs,
            sourceIdentity: { ...(coldSource || liveIdentity) },
            ...(source.kind === "hermes" ? { binding: coldSource ? "base" : "introduced" } : {}),
            originalRows,
            effectiveRows,
            observedRows,
            observedCount: 0,
          });
        }
        return { prefixes, revisionState: { segmentsById, revisionsBySegment }, usedProjection: Boolean(published) };
      } catch (error) {
        for (const rows of owned) rows.close();
        throw error;
      } finally {
        published?.database.close();
      }
    }

    /**
     * Return raw event rows for a range, using a cold segment only when the
     * committed authority marker explicitly lists it and its hot range is empty.
     * @param {{startMs: number, endMs: number}} range
     * @returns {Promise<Array<Record<string, unknown>>>}
     */
    async mergeHistoryArchiveEventsForRange(range) {
      return (await this.historyArchiveEventUnionForRange(range)).rows;
    }

    /**
     * Return the range union together with source kinds captured from the same
     * verified snapshot, so callers can project cold rows without a second read.
     * @param {{startMs: number, endMs: number}} range
     * @param {{completeHistory?: boolean, includeUsageCarrier?: boolean, includeMetadataCarrier?: boolean}} [options]
     * @returns {Promise<{
     *   rows: Array<Record<string, unknown>>,
     *   sourceKinds: Map<string, string>,
     *   homes?: Array<{ id: string, label: string, path: string, kind: string }>,
     *   rateLimitObservations?: import("./usage-types.js").RateLimitObservation[],
     *   metadataCarrier?: {generatedAt: string, homes: any[], warnings: string[]}
     * }>}
     */
    async historyArchiveEventUnionForRange(
      range,
      { completeHistory = false, includeUsageCarrier = false, includeMetadataCarrier = false } = {},
    ) {
      let startMs;
      let endMs;
      if (!completeHistory) {
        if (
          !range ||
          typeof range !== "object" ||
          Array.isArray(range) ||
          !Number.isSafeInteger(range.startMs) ||
          !Number.isSafeInteger(range.endMs) ||
          range.startMs >= range.endMs
        ) {
          throw new TypeError("startMs and endMs must be safe integer milliseconds with startMs < endMs");
        }
        startMs = range.startMs;
        endMs = range.endMs;
      }
      await this.open();

      let snapshot;
      this.assertSourceRepairsComplete();
      this.database.exec("SAVEPOINT history_archive_union_read");
      try {
        const usageCarrier = includeUsageCarrier
          ? {
              homes: publishedUsageHomesFromDatabase(this.database),
              rateLimitObservations: quotaObservationsFromDatabase(this.database),
            }
          : {};
        const metadataCarrier = includeMetadataCarrier
          ? {
              generatedAt: this.generatedAt,
              homes: structuredClone(this.homes),
              warnings: structuredClone(this.warnings),
            }
          : undefined;
        const revisionRawValue = this.database
          .prepare("SELECT value FROM store_meta WHERE key = ?")
          .get(HISTORY_ARCHIVE_EVENT_REVISIONS_META)?.value;
        const revisionSegmentsById = new Map(
          this.database
            .prepare(
              `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
             FROM archive_segments`,
            )
            .all()
            .map((segment) => [String(segment.segment_id), { ...segment }]),
        );
        const authorizedSegmentIds = historyArchiveAuthorizedSegmentIds(this.database);
        const eventRevisions = historyArchiveEventRevisions(revisionRawValue, revisionSegmentsById);
        if (completeHistory) {
          const hotBounds = this.database
            .prepare("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events")
            .get();
          const archiveBounds = this.database
            .prepare("SELECT MIN(start_ms) AS minimum, MAX(end_ms) AS maximum FROM archive_segments")
            .get();
          const starts = [hotBounds.minimum, archiveBounds.minimum].filter((value) => value !== null).map(Number);
          const ends = [hotBounds.maximum === null ? null : Number(hotBounds.maximum) + 1, archiveBounds.maximum]
            .filter((value) => value !== null)
            .map(Number);
          if (starts.length === 0 || ends.length === 0) {
            this.database.exec("RELEASE history_archive_union_read");
            return {
              rows: [],
              sourceKinds: new Map(),
              ...usageCarrier,
              ...(metadataCarrier === undefined ? {} : { metadataCarrier }),
            };
          }
          startMs = Math.min(...starts);
          endMs = Math.max(...ends);
        }
        const hotRows = historyArchiveEventRows(this.database, startMs, endMs);
        const segments = this.database
          .prepare(
            `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
           FROM archive_segments
           WHERE start_ms < ? AND end_ms > ?
           ORDER BY start_ms, segment_id`,
          )
          .all(endMs, startMs)
          .map((segment) => {
            const record = {
              segment_id: String(segment.segment_id),
              database_path: String(segment.database_path),
              database_sha256: String(segment.database_sha256),
              start_ms: Number(segment.start_ms),
              end_ms: Number(segment.end_ms),
              event_count: Number(segment.event_count),
              registered_at_ms: Number(segment.registered_at_ms),
            };
            return {
              segmentId: record.segment_id,
              record,
              hotRows: historyArchiveEventRows(this.database, record.start_ms, record.end_ms),
              sourceIdentities: historyArchiveSourceIdentities(this.database, record.start_ms, record.end_ms),
              authorized: authorizedSegmentIds.has(record.segment_id),
            };
          });
        const liveSourceIdentities = new Map(
          this.database
            .prepare(
              `SELECT path, kind, home_id, home_label, home_path
             FROM source_files
             ORDER BY path, kind, home_id, home_label, home_path`,
            )
            .all()
            .map((row) => [String(row.path), { ...row }]),
        );
        this.database.exec("RELEASE history_archive_union_read");
        snapshot = {
          hotRows,
          segments,
          liveSourceIdentities,
          usageCarrier,
          metadataCarrier,
          eventRevisions,
        };
      } catch (error) {
        this.database.exec("ROLLBACK TO history_archive_union_read");
        this.database.exec("RELEASE history_archive_union_read");
        throw error;
      }

      const rows = snapshot.hotRows;
      for (const segment of snapshot.segments) {
        if (segment.authorized && segment.hotRows.length > 0) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
            `authorized archive segment ${segment.segmentId} still has hot facts`,
          );
        }
        const cold = await this.readHistoryArchiveSnapshot(segment.record);
        if (segment.authorized) {
          const coldSourceByPath = new Map(cold.sourceIdentities.map((source) => [String(source.path), source]));
          const coldSourcePaths = new Set(cold.rows.map((row) => String(row.source_path)));
          if (
            coldSourceByPath.size !== coldSourcePaths.size ||
            [...coldSourcePaths].some((sourcePath) => !coldSourceByPath.has(sourcePath))
          ) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
              `archive segment ${segment.segmentId} does not contain complete source identities`,
            );
          }
          for (const source of cold.sourceIdentities) {
            const liveSource = snapshot.liveSourceIdentities.get(String(source.path));
            if (!liveSource || JSON.stringify(liveSource) !== JSON.stringify(source)) {
              throw historyArchiveError(
                "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
                `live source identity no longer matches archive segment ${segment.segmentId}`,
              );
            }
          }
          for (const revision of snapshot.eventRevisions.get(segment.segmentId) || []) {
            if (revision.binding !== "introduced") continue;
            const live = snapshot.liveSourceIdentities.get(revision.sourceIdentity.path);
            if (
              !live ||
              !sameHistoryArchiveSourceIdentity(live, revision.sourceIdentity) ||
              coldSourceByPath.has(revision.sourceIdentity.path)
            )
              throw historyArchiveRevisionError("introduced archive source identity does not match");
          }
          const revisedColdRows = applyHistoryArchiveEventRevisions(
            segment.record,
            cold,
            snapshot.eventRevisions.get(segment.segmentId),
          );
          for (const row of revisedColdRows) {
            if (Number(row.timestamp_ms) >= startMs && Number(row.timestamp_ms) < endMs) rows.push(row);
          }
          continue;
        }
        const hotCounts = historyArchiveEventCounts(segment.hotRows);
        const coldCounts = historyArchiveEventCounts(cold.rows);
        if (!historyArchiveEventCountsEqual(hotCounts, coldCounts)) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
            `hot facts do not mirror archive segment ${segment.segmentId}`,
          );
        }

        if (JSON.stringify(cold.sourceIdentities) !== JSON.stringify(segment.sourceIdentities)) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
            `hot source identities do not mirror archive segment ${segment.segmentId}`,
          );
        }
      }

      rows.sort((left, right) => {
        const timeDelta = Number(left.timestamp_ms) - Number(right.timestamp_ms);
        if (timeDelta !== 0) return timeDelta;
        const leftPayload = JSON.stringify(canonicalFactPayload(left, ["id"]));
        const rightPayload = JSON.stringify(canonicalFactPayload(right, ["id"]));
        return leftPayload < rightPayload ? -1 : leftPayload > rightPayload ? 1 : 0;
      });
      const sourceKinds = new Map();
      for (const row of rows) {
        const sourcePath = String(row.source_path);
        const source = snapshot.liveSourceIdentities.get(sourcePath);
        if (source) sourceKinds.set(sourcePath, String(source.kind));
      }
      return {
        rows,
        sourceKinds,
        ...snapshot.usageCarrier,
        ...(snapshot.metadataCarrier === undefined ? {} : { metadataCarrier: snapshot.metadataCarrier }),
      };
    }

    async usageFiles(homes) {
      const files = [];
      const warnings = [];
      /** @type {any[]} */
      const failedHomes = [];
      /** @param {string[]} paths @param {any} source @param {(filePath: string) => Promise<any>} [readInfo] */
      const addFiles = async (paths, source, readInfo = stat) => {
        for (let offset = 0; offset < paths.length; offset += 32) {
          const results = await Promise.allSettled(
            paths.slice(offset, offset + 32).map(async (filePath) => ({
              filePath,
              source,
              info: await readInfo(filePath),
            })),
          );
          for (const result of results) {
            if (result.status === "rejected") throw result.reason;
            files.push(result.value);
          }
        }
      };
      for (const home of homes) {
        try {
          if (home.kind === "project-log" && home.usageLogPath) {
            files.push({ filePath: home.usageLogPath, source: home, info: await stat(home.usageLogPath) });
            continue;
          }
          if ((home.kind === "zcode" || home.kind === "hermes") && home.usageLogPath) {
            files.push({
              filePath: home.usageLogPath,
              source: home,
              info: await (home.kind === "hermes" ? hermesSourceStat : zcodeSourceStat)(home.usageLogPath),
            });
            continue;
          }
          if (home.kind === "dsh") {
            // DSH 的用量按会话分散在多个日志文件里，逐个纳入增量索引
            // （每个文件各自按 size+mtime 判定是否需要重解析）。
            await addFiles(await dshSessionFiles(home.path), home);
            continue;
          }
          if (home.kind === "opencode") {
            // 单个数据目录下可能有多个数据库（opencode.db、opencode-<channel>.db），
            // 逐个纳入增量索引（含 -wal 指纹）。
            await addFiles(await opencodeDatabaseFiles(home.path), home, opencodeSourceStat);
            continue;
          }
          if (home.kind === "claude") {
            // Claude Code 的用量按会话转录分散在 projects/**/*.jsonl（含 subagents），
            // 每个文件各自按 size+mtime 判定是否需要重解析。
            await addFiles(await claudeSessionFiles(home.path), home);
            continue;
          }
          if (home.kind === "workbuddy") {
            // WorkBuddy 同样是逐会话转录；会话文件是普通 jsonl。
            await addFiles(await workbuddySessionFiles(home.path), home);
            continue;
          }
          await addFiles(await discoverSessionFiles(home.path), home);
        } catch (error) {
          failedHomes.push({ id: home.id, path: home.path });
          warnings.push(`无法读取 ${home.path}: ${error.message}`);
        }
      }
      return { files, warnings, failedHomes };
    }

    async usageFileFingerprints(files) {
      const fingerprints = new Map();
      for (let offset = 0; offset < files.length; offset += 32) {
        const batch = files.slice(offset, offset + 32);
        const results = await Promise.allSettled(batch.map((file) => asyncUsageSourceFingerprint(file.filePath)));
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") throw result.reason;
          fingerprints.set(batch[index].filePath, result.value);
        }
      }
      return fingerprints;
    }

    /**
     * Reuse an unchanged source tail only when replacement preserves IDs and order.
     * @param {any} file
     * @param {{ onWarning?: (warning: string) => void }} [options]
     */
    async reuseSourcePrefix({ filePath, source, info }, { onWarning } = {}) {
      const database = this.database;
      if (
        !["claude", "workbuddy", "zcode", "opencode"].includes(source.kind) ||
        typeof database?.isTransaction !== "boolean" ||
        database.isTransaction ||
        this.writeTransactionDepth
      )
        return null;
      const last = database.prepare("SELECT source_path FROM events ORDER BY id DESC LIMIT 1").get();
      const present = database.prepare("SELECT 1 FROM events WHERE source_path=? LIMIT 1").get(filePath);
      if (present && last?.source_path !== filePath) return null;

      const mismatch = new Error("Source facts require complete replacement");
      let previous;
      const closePrevious = () => {
        previous?.return?.();
        previous = null;
      };
      const warnings = [];
      let warningsPublished = false;
      const publishWarnings = () => {
        warningsPublished = true;
        for (const warning of warnings) onWarning?.(warning);
      };
      let reusedEvents = 0,
        insertedEvents = 0;
      database.exec("BEGIN IMMEDIATE");
      this.writeTransactionDepth += 1;
      try {
        const binding = database
          .prepare("SELECT kind,home_id,home_label,home_path FROM source_files WHERE path=?")
          .get(filePath);
        if (
          !sameSourceBinding(binding, source) ||
          database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META) ||
          database.prepare("SELECT 1 FROM archive_segments LIMIT 1").get() ||
          database.prepare("SELECT 1 FROM temp.sqlite_schema WHERE name IN ('events','source_files') LIMIT 1").get() ||
          database
            .prepare("PRAGMA main.table_xinfo(events)")
            .all()
            .map((column) => column.name)
            .join(",") !== ["id", ...EVENT_INSERT_COLUMNS].join(",") ||
          database
            .prepare(`SELECT 1 FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='source_files'
          AND name NOT IN ('usage_source_progress_source_update',
            'usage_source_catalog_source_files_INSERT','usage_source_catalog_source_files_UPDATE',
            'usage_source_catalog_source_files_DELETE','usage_all_source_insert',
            'usage_all_source_update','usage_all_source_delete',
            'usage_all_usage_source_insert','usage_all_usage_source_update','usage_all_usage_source_delete') LIMIT 1`)
            .get() ||
          /\bAUTOINCREMENT\b/i.test(
            String(database.prepare("SELECT sql FROM main.sqlite_schema WHERE name='events'").get()?.sql),
          )
        )
          throw mismatch;
        for (const table of [
          "rate_limit_observations",
          "quota_usage_sources",
          "usage_source_progress",
          "usage_source_baselines",
          "usage_source_reparse",
        ]) {
          if (database.prepare(`SELECT 1 FROM ${table} WHERE source_path=? LIMIT 1`).get(filePath)) throw mismatch;
        }
        const tail = database
          .prepare("SELECT COUNT(*) n,MIN(id) first,MAX(id) last FROM events WHERE source_path=?")
          .get(filePath);
        if (Number(tail.n) > 0) {
          const maximum = database.prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1").get();
          const earlier = database.prepare("SELECT id FROM events WHERE id<? ORDER BY id DESC LIMIT 1").get(tail.first);
          if (
            tail.last !== maximum?.id ||
            Number(tail.last) - Number(tail.first) + 1 !== Number(tail.n) ||
            Number(tail.first) !== Number(earlier?.id ?? 0) + 1
          )
            throw mismatch;
        }
        const statement = database.prepare(
          `SELECT ${EVENT_INSERT_COLUMNS.join(",")} FROM events WHERE source_path=? ORDER BY id`,
        );
        statement.setReturnArrays(true);
        previous = statement.iterate(filePath);
        let exhausted = false;
        const insert = createUsageInsertBatch(database, {
          sqlPrefix: `INSERT INTO events (${EVENT_INSERT_COLUMNS.join(",")}) VALUES`,
          columns: EVENT_INSERT_COLUMNS.length,
        });
        await streamUsageFileEvents(
          filePath,
          source,
          (event) => {
            const row = sourceEventRow(filePath, event),
              values = EVENT_INSERT_COLUMNS.map((column) => row[column]);
            const old = exhausted ? null : previous.next();
            if (old && !old.done) {
              if (
                values.some((value, index) => {
                  const column = EVENT_INSERT_COLUMNS[index];
                  if (column === "price_version") return false;
                  const previous = old.value[index];
                  if (column === "context_level" && value === "known" && (previous === "short" || previous === "long"))
                    return false;
                  return value !== previous;
                })
              )
                throw mismatch;
              reusedEvents += 1;
            } else {
              exhausted = true;
              insert.add(values);
              insertedEvents += 1;
            }
          },
          { repositoryResolver: this.repositoryResolver, onWarning: (warning) => warnings.push(String(warning)) },
        );
        if (!exhausted && !previous.next().done) throw mismatch;
        closePrevious();
        insert.flush();
        database
          .prepare("UPDATE source_files SET size=?,mtime_ms=?,indexed_at=? WHERE path=?")
          .run(info.size, info.mtimeMs, new Date().toISOString(), filePath);
        const nextFileWarnings = this.publishedFileWarningsForRound();
        delete nextFileWarnings[filePath];
        this.writeMeta("perf_file_warnings", JSON.stringify(nextFileWarnings));
        publishWarnings();
        database.exec("COMMIT");
        this.writeTransactionDepth -= 1;
        if (this.publishedFileWarningsView) this.publishedFileWarningsView.warnings = { ...nextFileWarnings };
        return {
          committed: true,
          appended: false,
          quotaWritten: false,
          reusedPrefix: true,
          reusedEvents,
          insertedEvents,
          checkedEvents: reusedEvents + insertedEvents,
          parsedBytes: info.size,
          prefixBytesRead: 0,
          journalBytes: 0,
        };
      } catch (error) {
        closePrevious();
        database.exec("ROLLBACK");
        this.rollbackReplaceFileTransaction();
        if (error === mismatch) return null;
        if (!warningsPublished) publishWarnings();
        throw error;
      } finally {
        closePrevious();
      }
    }

    /**
     * Replace one discovered source file's ordinary usage facts atomically.
     * @param {any} file
     * @param {{ onWarning?: (warning: string) => void, progress?: boolean, reuseHistoryProjection?: boolean }} [options]
     */
    async replaceFile(
      { filePath, source, info, relocatedFrom },
      { onWarning, progress = true, reuseHistoryProjection = false } = {},
    ) {
      const reused = !relocatedFrom && (await this.reuseSourcePrefix({ filePath, source, info }, { onWarning }));
      if (reused) return reused;
      const database = this.database;
      const codexThreaded = canonicalizeKind(source.kind || "codex") === "codex";
      const hot = !database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META);
      if (!hot) await this.ensureHistoryProjectionTracking();
      const proofEligible =
        (hot || this.sourceAppendArchiveEnd() !== null) &&
        typeof database.isTransaction === "boolean" &&
        ((codexThreaded && filePath.endsWith(".jsonl")) || source.kind === "dsh");
      const progressEligible = progress && proofEligible;
      const sourceFence = proofEligible ? await this.sourceProof.begin(filePath, info) : null;
      const parsedHash = progressEligible && !sourceFence ? createHash("sha256") : null;
      let parsedOffset = 0;
      /** @type {any} */
      let checkpoint = null;
      let sourceBaseline = null;
      let proofWork = null;
      const sourceBounds = new UsageSourceChangeBounds();
      const replacementFacts = new UsageReplacementFacts(database);
      const oldCumulative = createHash("sha256"),
        nextCumulative = createHash("sha256");
      const parserWarnings = [];
      const siblingPath =
        relocatedFrom || (filePath.endsWith(".jsonl.zst") ? plainRolloutPath(filePath) : `${filePath}.zst`);
      const representationFingerprint = codexThreaded ? usageSourceFingerprint(filePath) : undefined;
      const insertSource = database.prepare(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        home_id = excluded.home_id,
        home_label = excluded.home_label,
        home_path = excluded.home_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `);
      const insertEvent = createUsageInsertBatch(database, {
        sqlPrefix: `INSERT INTO events (${EVENT_INSERT_COLUMNS.join(",")}) VALUES`,
        columns: EVENT_INSERT_COLUMNS.length,
      });
      const insertRateLimitObservation = createUsageInsertBatch(database, {
        sqlPrefix: `
      INSERT INTO rate_limit_observations (
        source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      ) VALUES`,
        columns: 10,
      });
      const insertQuotaSource = database.prepare(`INSERT OR REPLACE INTO quota_usage_sources
      (source_path, home_id, session_id, timestamp_ms, quota_source, until_ms) VALUES (?, ?, ?, ?, ?, ?)`);
      const previousQuotaSources = new Map();
      const rememberQuotaSource = (event) => {
        if (canonicalizeKind(source.kind) !== "codex" || !Number.isFinite(event.timestampMs)) return;
        const value = `${event.quotaSource || "unknown"}:${event.quotaSourceUntil || 0}`;
        if (previousQuotaSources.get(event.sessionId) === value) return;
        insertQuotaSource.run(
          filePath,
          event.homeId,
          event.sessionId,
          event.timestampMs,
          event.quotaSource || "unknown",
          event.quotaSourceUntil || 0,
        );
        previousQuotaSources.set(event.sessionId, value);
      };
      const insertReplacedFact = database.prepare(HISTORY_REPLACED_FACT_INSERT_SQL);
      const previousStatement = database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total,
        COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached,
        COALESCE(SUM(output), 0) AS output, COALESCE(SUM(reasoning), 0) AS reasoning,
        MIN(detail_mask & 1) AS input_known, MIN(detail_mask & 2) AS cached_known,
        MIN(detail_mask & 4) AS output_known, MIN(detail_mask & 8) AS reasoning_known,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        MIN(cache_write_known) AS cache_write_known
      FROM events WHERE session_id = ? AND home_id = ? AND source_path <> ? AND timestamp_ms < ?
    `);
      const previousCumulativeForSession = (sessionId, timestamp) => {
        const timestampMs = Date.parse(timestamp);
        if (!Number.isFinite(timestampMs)) return null;
        insertEvent.flush();
        sourceBaseline = { homeId: source.id, sessionId: String(sessionId), beforeMs: timestampMs };
        const earlier = previousStatement.get(sessionId, source.id, filePath, timestampMs);
        if (!earlier.count) return null;
        return {
          usage: usageFromRow(earlier),
          detailMask:
            Number(earlier.input_known || 0) |
            Number(earlier.cached_known || 0) |
            Number(earlier.output_known || 0) |
            Number(earlier.reasoning_known || 0),
          cacheWrite: { tokens: Number(earlier.cache_write_tokens || 0), known: Boolean(earlier.cache_write_known) },
        };
      };
      let quotaWritten = false;
      let truncationWarning;
      let truncationEventCount = 0;
      let coldRemovedEventCount = 0;
      let coldReparsePrefixes = [];
      let usedProjectionPrefix = false;
      const projectLogWarnings = [];
      const projectLogMalformedLines = new Set();
      database.exec("BEGIN IMMEDIATE");
      this.writeTransactionDepth += 1;
      const projectionBefore = !hot ? this.historyProjectionModule.readHistoryProjectionStamp(database) : null;
      try {
        const previousSource = database
          .prepare("SELECT path, kind, home_id, home_label, home_path, size FROM source_files WHERE path = ?")
          .get(filePath);
        const coldReparse = await this.historyArchiveReparsePrefixes(filePath, source, {
          reuseProjection: reuseHistoryProjection,
        });
        usedProjectionPrefix = Boolean(coldReparse.usedProjection);
        coldReparsePrefixes = coldReparse.prefixes;
        replacementFacts.capture("events", filePath);
        replacementFacts.capture("rate_limit_observations", filePath);
        const previousSiblingSource = codexThreaded
          ? database
              .prepare(
                "SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ? AND home_id = ?",
              )
              .get(siblingPath, source.id)
          : null;
        if (previousSiblingSource) {
          replacementFacts.capture("events", previousSiblingSource.path);
          replacementFacts.capture("rate_limit_observations", previousSiblingSource.path);
        }
        if (hot && codexThreaded) {
          for (const row of database
            .prepare("SELECT * FROM events WHERE source_path IN (?,?) ORDER BY source_path,id")
            .iterate(filePath, previousSiblingSource?.path || filePath)) {
            addCumulativeFingerprint(oldCumulative, row);
            sourceBounds.add(row.home_id, row.session_id, Number(row.timestamp_ms));
          }
        }
        insertSource.run(
          filePath,
          source.kind || "codex",
          source.id,
          source.label,
          source.path,
          info.size,
          info.mtimeMs,
          new Date().toISOString(),
        );
        database.prepare("DELETE FROM events WHERE source_path = ?").run(filePath);
        database.prepare("DELETE FROM rate_limit_observations WHERE source_path = ?").run(filePath);
        database.prepare("DELETE FROM quota_usage_sources WHERE source_path = ?").run(filePath);
        if (previousSiblingSource) {
          database.prepare("DELETE FROM events WHERE source_path = ?").run(previousSiblingSource.path);
          database.prepare("DELETE FROM rate_limit_observations WHERE source_path = ?").run(previousSiblingSource.path);
          database.prepare("DELETE FROM quota_usage_sources WHERE source_path = ?").run(previousSiblingSource.path);
          database.prepare("DELETE FROM source_files WHERE path = ?").run(previousSiblingSource.path);
        }
        await streamUsageFileEvents(
          filePath,
          source,
          (event) => {
            rememberQuotaSource(event);
            const row = sourceEventRow(filePath, event);
            const coldPrefix = coldReparsePrefixes.find(
              (prefix) => row.timestamp_ms >= prefix.startMs && row.timestamp_ms < prefix.endMs,
            );
            if (coldPrefix) {
              coldPrefix.observedRows.set(String(coldPrefix.observedCount++), { ...row });
              return;
            }
            insertEvent.add(EVENT_INSERT_COLUMNS.map((column) => row[column]));
            if (hot && codexThreaded) {
              addCumulativeFingerprint(nextCumulative, row);
              sourceBounds.add(row.home_id, row.session_id, Number(row.timestamp_ms));
            }
          },
          {
            repositoryResolver: this.repositoryResolver,
            previousCumulativeForSession,
            ...(progressEligible
              ? {
                  endOffset: info.size,
                  onSourceBytes: parsedHash
                    ? (bytes) => {
                        parsedHash.update(bytes);
                        parsedOffset += bytes.length;
                      }
                    : undefined,
                  onProgress: (value) => {
                    checkpoint = value;
                  },
                }
              : {}),
            onQuotaSource: rememberQuotaSource,
            onRateLimit: ["main", "jetbrains", "extra", "codex"].includes(source.kind)
              ? (observation) => {
                  insertRateLimitObservation.add([
                    filePath,
                    observation.lineNumber,
                    observation.role,
                    observation.observedAtMs,
                    observation.limitId,
                    observation.limitName,
                    observation.planType,
                    observation.windowMinutes,
                    observation.resetsAtMs,
                    observation.usedPercent,
                  ]);
                  quotaWritten = true;
                }
              : undefined,
            onWarning:
              String(source.kind ?? "") === "project-log"
                ? (warning, details) => {
                    projectLogWarnings.push(String(warning));
                    const lineNumber = Number(details?.lineNumber);
                    if (Number.isSafeInteger(lineNumber) && lineNumber > 0) {
                      projectLogMalformedLines.add(lineNumber);
                    }
                  }
                : progressEligible
                  ? (warning) => parserWarnings.push(String(warning))
                  : onWarning,
          },
        );
        insertEvent.flush();
        insertRateLimitObservation.flush();
        if (source.kind === "hermes" && info.contentDigest) {
          const after = await hermesSourceStat(filePath);
          if (after.contentDigest !== info.contentDigest || after.sqliteObservation !== info.sqliteObservation) {
            throw Object.assign(new Error("Hermes source changed while indexing"), {
              code: "LIVE_SOURCE_CHANGED",
              retryable: true,
            });
          }
        }
        if (
          relocatedFrom &&
          (!previousSiblingSource ||
            !hot ||
            !replacementFacts.coversRelocated("events", relocatedFrom, filePath) ||
            !replacementFacts.coversRelocated("rate_limit_observations", relocatedFrom, filePath))
        ) {
          throw Object.assign(new Error("Archived rollout does not preserve its indexed history"), {
            code: "SOURCE_RELOCATION_MISMATCH",
          });
        }
        let coldRevisionStateChanged = false;
        for (const prefix of coldReparsePrefixes) {
          const revision = historyArchiveColdRevisionForRows(prefix);
          if (revision) coldRemovedEventCount += revision.removedColdEventCount;
          if (!revision || !coldReparse.revisionState) continue;
          const { revisionsBySegment } = coldReparse.revisionState;
          const entries = revisionsBySegment.get(prefix.segmentId) || [];
          const existingIndex = entries.findIndex((entry) =>
            sameHistoryArchiveSourceIdentity(entry.sourceIdentity, revision.entry.sourceIdentity),
          );
          const existing = existingIndex < 0 ? null : entries[existingIndex];
          if (existing && historyArchiveRevisionEntryKey(existing) === historyArchiveRevisionEntryKey(revision.entry)) {
            continue;
          }
          if (existing || prefix.sourceIdentity.kind === "hermes") {
            saveMissingHistoryFacts(insertReplacedFact, {
              factTable: "events",
              source: prefix.sourceIdentity,
              previousRows: prefix.effectiveRows,
              currentRows: prefix.observedRows,
              methodVersion: HISTORY_REPLACED_FACT_METHOD_VERSION,
              excludedColumns: ["id"],
            });
          }
          if (revision.entry.removed.length === 0 && revision.entry.added.length === 0) {
            if (existingIndex >= 0) entries.splice(existingIndex, 1);
          } else if (existingIndex >= 0) {
            entries[existingIndex] = revision.entry;
          } else {
            entries.push(revision.entry);
          }
          revisionsBySegment.set(prefix.segmentId, entries);
          markHistoryArchiveRevisionRollupDays(database, revision.previousChangedRows, revision.currentChangedRows);
          coldRevisionStateChanged = true;
        }
        if (coldRevisionStateChanged && coldReparse.revisionState) {
          writeHistoryArchiveEventRevisionState(database, coldReparse.revisionState);
        }
        if (previousSource) {
          const counts = replacementFacts.save(
            insertReplacedFact,
            "events",
            previousSource,
            HISTORY_REPLACED_FACT_METHOD_VERSION,
          );
          if (
            String(previousSource.kind ?? "") === "project-log" &&
            String(source.kind ?? "") === "project-log" &&
            info.size < Number(previousSource.size) &&
            counts.currentCount < counts.previousCount
          ) {
            truncationEventCount = counts.previousCount - counts.currentCount;
          }
        }
        if (String(source.kind ?? "") === "project-log") {
          truncationEventCount += coldRemovedEventCount;
          if (truncationEventCount > 0) {
            truncationWarning = formatProjectLogTruncationWarning(filePath, truncationEventCount);
          }
        }
        if (previousSiblingSource) {
          replacementFacts.save(
            insertReplacedFact,
            "events",
            previousSiblingSource,
            HISTORY_REPLACED_FACT_METHOD_VERSION,
          );
          replacementFacts.save(
            insertReplacedFact,
            "rate_limit_observations",
            previousSiblingSource,
            HISTORY_REPLACED_QUOTA_METHOD_VERSION,
          );
        }
        if (previousSource) {
          replacementFacts.save(
            insertReplacedFact,
            "rate_limit_observations",
            previousSource,
            HISTORY_REPLACED_QUOTA_METHOD_VERSION,
          );
        }
        const nextFileWarnings = this.publishedFileWarningsForRound();
        if (String(source.kind ?? "") === "project-log") {
          let projectLogFileWarnings = (nextFileWarnings[filePath] || []).filter(
            (warning) =>
              warning.code === PROJECT_LOG_TRUNCATION_WARNING_CODE ||
              warning.code === PROJECT_LOG_MALFORMED_LINE_WARNING_CODE,
          );
          if (truncationEventCount > 0) {
            projectLogFileWarnings = projectLogFileWarnings.filter(
              (warning) => warning.code !== PROJECT_LOG_TRUNCATION_WARNING_CODE,
            );
            projectLogFileWarnings.push({
              sourceKind: "project-log",
              homeId: String(source.id ?? ""),
              code: PROJECT_LOG_TRUNCATION_WARNING_CODE,
              count: truncationEventCount,
            });
          }
          const malformedLines = [...projectLogMalformedLines].sort((left, right) => left - right);
          projectLogFileWarnings = projectLogFileWarnings.filter(
            (warning) => warning.code !== PROJECT_LOG_MALFORMED_LINE_WARNING_CODE,
          );
          if (malformedLines.length > 0) {
            projectLogFileWarnings.push({
              sourceKind: "project-log",
              homeId: String(source.id ?? ""),
              code: PROJECT_LOG_MALFORMED_LINE_WARNING_CODE,
              count: malformedLines.length,
              lineNumbers: malformedLines,
            });
          }
          if (projectLogFileWarnings.length > 0) nextFileWarnings[filePath] = projectLogFileWarnings;
          else delete nextFileWarnings[filePath];
        } else {
          delete nextFileWarnings[filePath];
        }
        this.writeMeta("perf_file_warnings", JSON.stringify(nextFileWarnings));
        if (hot && codexThreaded && typeof database.isTransaction === "boolean") {
          writeUsageSourceBaseline(database, filePath, sourceBaseline);
          if (oldCumulative.digest("hex") !== nextCumulative.digest("hex")) {
            markUsageSourceDependents(database, filePath, sourceBounds);
          }
        }
        if (progressEligible && checkpoint) {
          const sessionId = sourceSessionId(checkpoint, filePath);
          if (
            !codexThreaded ||
            (previousQuotaSources.size <= 1 && (!previousQuotaSources.size || previousQuotaSources.has(sessionId)))
          ) {
            checkpoint = {
              ...checkpoint,
              store: { format: 1, sessionId, lastQuotaSource: previousQuotaSources.get(sessionId) ?? null },
            };
            proofWork = await this.sourceProof.capture(
              filePath,
              checkpoint.offset,
              info,
              sourceFence,
              parsedHash ? { offset: parsedOffset, digest: parsedHash.copy().digest("hex") } : null,
            );
            writeUsageSourceProgress(database, filePath, checkpoint, proofWork.validation);
          } else checkpoint = null;
        }
        if (!checkpoint) {
          database.prepare("DELETE FROM usage_source_progress WHERE source_path=?").run(filePath);
          if (sourceFence || parsedHash)
            proofWork = await this.sourceProof.capture(
              filePath,
              0,
              info,
              sourceFence,
              parsedHash ? { offset: parsedOffset, digest: parsedHash.copy().digest("hex") } : null,
            );
        }
        if ((hot || progressEligible) && (codexThreaded || source.kind === "dsh")) {
          const after = await stat(filePath);
          if (
            after.size !== info.size ||
            after.mtimeMs !== info.mtimeMs ||
            after.ctimeMs !== info.ctimeMs ||
            usageSourceIdentity(after) !== usageSourceIdentity(info)
          ) {
            throw Object.assign(new Error("Source changed while indexing"), {
              code: "LIVE_SOURCE_CHANGED",
              retryable: true,
            });
          }
        }
        if (
          representationFingerprint !== undefined &&
          (representationFingerprint === null || usageSourceFingerprint(filePath) !== representationFingerprint)
        ) {
          throw Object.assign(new Error("Codex rollout changed during representation indexing"), {
            code: "LIVE_SOURCE_CHANGED",
            retryable: true,
          });
        }
        if (relocatedFrom) {
          try {
            await stat(relocatedFrom);
            throw Object.assign(new Error("Original rollout returned during relocation"), {
              code: "LIVE_SOURCE_CHANGED",
              retryable: true,
            });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        database.prepare("DELETE FROM usage_source_reparse WHERE source_path=?").run(filePath);
        for (const warning of parserWarnings) onWarning?.(warning);
        if (projectionBefore)
          this.historyProjectionModule.recordHistoryProjectionBatch(database, projectionBefore, {
            sources: previousSiblingSource ? [filePath, String(previousSiblingSource.path)] : [filePath],
            mode: "replace",
          });
        database.exec("COMMIT");
        if (this.writeTransactionDepth > 0) this.writeTransactionDepth -= 1;
        if (this.publishedFileWarningsView) {
          this.publishedFileWarningsView.warnings = { ...nextFileWarnings };
        }
        return {
          committed: true,
          quotaWritten,
          historyVerificationPending: usedProjectionPrefix,
          truncationWarning,
          projectLogWarnings,
          appended: false,
          parsedBytes: info.size,
          sourceValidation: proofWork?.validation,
          prefixBytesRead: proofWork?.readBytes || 0,
          journalBytes: (sourceFence?.journalBytes || 0) + (proofWork?.journalBytes || 0),
        };
      } catch (error) {
        database.exec("ROLLBACK");
        this.rollbackReplaceFileTransaction();
        if (progressEligible && error.code === "SOURCE_PROGRESS_UNSUPPORTED") {
          return this.replaceFile({ filePath, source, info, relocatedFrom }, { onWarning, progress: false });
        }
        throw error;
      } finally {
        sourceBounds.close();
        replacementFacts.close();
        for (const prefix of coldReparsePrefixes)
          for (const rows of new Set([prefix.originalRows, prefix.effectiveRows, prefix.observedRows])) rows.close();
      }
    }

    sourceAppendArchiveEnd() {
      const authorized = historyArchiveAuthorizedSegmentIds(this.database);
      if (!authorized.size) return null;
      const records = this.database.prepare("SELECT segment_id,end_ms FROM archive_segments").all();
      // The single-package SQL path retains its established event insertion/money order.
      if (records.length < 2) return null;
      const ends = records.map((row) => Number(row.end_ms));
      return ends.length && ends.every(Number.isSafeInteger) ? Math.max(...ends) : null;
    }

    /**
     * Return null when an exact append cannot be proved; the caller then replaces the source.
     * @param {any} file
     * @param {{ onWarning?: (warning: string) => void }} [options]
     */
    async appendFile({ filePath, source, info }, { onWarning } = {}) {
      const database = this.database;
      if (
        typeof database.isTransaction !== "boolean" ||
        database.prepare("SELECT 1 FROM usage_source_reparse WHERE source_path=?").get(filePath)
      )
        return null;
      let archiveEnd = null;
      if (database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)) {
        archiveEnd = this.sourceAppendArchiveEnd();
        if (archiveEnd === null) return null;
        await this.ensureHistoryProjectionTracking();
      }
      const existing = database.prepare("SELECT * FROM source_files WHERE path=?").get(filePath);
      const saved = readUsageSourceProgress(database, filePath);
      if (
        !sameSourceBinding(existing, source) ||
        !saved ||
        info.size < Number(existing.size) ||
        saved.checkpoint.store?.format !== 1
      )
        return null;
      const verified = await this.sourceProof.verify(filePath, saved.validation, saved.checkpoint.offset, info);
      if (!verified) return null;
      const parsedHash = verified.hash && !verified.nativeFence ? verified.hash.copy() : null;
      let parsedOffset = verified.offset;
      const codex = saved.checkpoint.adapter === "codex-jsonl";
      const sessionId = saved.checkpoint.store.sessionId;
      let baseline = readUsageSourceBaseline(database, filePath);
      let lastQuotaSource = saved.checkpoint.store.lastQuotaSource;
      /** @type {any} */
      let checkpoint = null;
      let quotaWritten = false;
      const warnings = [];
      const bounds = new UsageSourceChangeBounds();
      const unsupported = () =>
        Object.assign(new Error("Source requires complete parsing"), { code: "SOURCE_PROGRESS_UNSUPPORTED" });
      const checkHotTimestamp = (timestamp) => {
        if (archiveEnd !== null && (!Number.isSafeInteger(timestamp) || timestamp < archiveEnd)) throw unsupported();
      };
      const eventInsert = database.prepare(`INSERT INTO events (${EVENT_INSERT_COLUMNS.join(",")})
      VALUES (${EVENT_INSERT_COLUMNS.map(() => "?").join(",")})`);
      const quotaInsert = database.prepare(`INSERT OR REPLACE INTO quota_usage_sources
      (source_path,home_id,session_id,timestamp_ms,quota_source,until_ms) VALUES (?,?,?,?,?,?)`);
      const rateInsert = database.prepare(`INSERT INTO rate_limit_observations
      (source_path,line_number,role,observed_at_ms,limit_id,limit_name,plan_type,window_minutes,resets_at_ms,used_percent)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const rememberQuotaSource = (event) => {
        if (!codex || !Number.isFinite(event.timestampMs)) return;
        checkHotTimestamp(event.timestampMs);
        if (event.sessionId !== sessionId) throw unsupported();
        const value = `${event.quotaSource || "unknown"}:${event.quotaSourceUntil || 0}`;
        if (value === lastQuotaSource) return;
        quotaInsert.run(
          filePath,
          event.homeId,
          event.sessionId,
          event.timestampMs,
          event.quotaSource || "unknown",
          event.quotaSourceUntil || 0,
        );
        lastQuotaSource = value;
      };
      database.exec("BEGIN IMMEDIATE");
      this.writeTransactionDepth += 1;
      try {
        const projectionBefore =
          archiveEnd === null ? null : this.historyProjectionModule.readHistoryProjectionStamp(database);
        // Verification awaited filesystem I/O: another connection may have replaced the cursor meanwhile.
        if (
          JSON.stringify(readUsageSourceProgress(database, filePath)) !== JSON.stringify(saved) ||
          database.prepare("SELECT 1 FROM usage_source_reparse WHERE source_path=?").get(filePath)
        )
          throw unsupported();
        if (
          archiveEnd !== null &&
          codex &&
          (database
            .prepare("SELECT 1 FROM quota_usage_sources WHERE home_id=? AND session_id=? AND source_path<>? LIMIT 1")
            .get(source.id, sessionId, filePath) ||
            database
              .prepare(`SELECT 1 FROM rate_limit_observations a JOIN rate_limit_observations b
            ON b.limit_id=a.limit_id AND b.window_minutes=a.window_minutes AND b.observed_at_ms=a.observed_at_ms
            AND b.source_path<>a.source_path WHERE a.source_path=? LIMIT 1`)
              .get(filePath))
        )
          throw unsupported();
        await streamUsageFileEvents(
          filePath,
          source,
          (event) => {
            if (codex && event.sessionId !== sessionId) throw unsupported();
            rememberQuotaSource(event);
            const row = sourceEventRow(filePath, event);
            checkHotTimestamp(Number(row.timestamp_ms));
            eventInsert.run(...EVENT_INSERT_COLUMNS.map((column) => row[column]));
            if (codex) bounds.add(row.home_id, row.session_id, Number(row.timestamp_ms));
          },
          {
            repositoryResolver: this.repositoryResolver,
            resume: saved.checkpoint,
            endOffset: info.size,
            onSourceBytes: parsedHash
              ? (bytes) => {
                  parsedHash.update(bytes);
                  parsedOffset += bytes.length;
                }
              : undefined,
            onProgress: (value) => {
              checkpoint = value;
            },
            onWarning: (warning) => warnings.push(String(warning)),
            onQuotaSource: rememberQuotaSource,
            onRateLimit: codex
              ? (row) => {
                  checkHotTimestamp(row.observedAtMs);
                  rateInsert.run(
                    filePath,
                    row.lineNumber,
                    row.role,
                    row.observedAtMs,
                    row.limitId,
                    row.limitName,
                    row.planType,
                    row.windowMinutes,
                    row.resetsAtMs,
                    row.usedPercent,
                  );
                  quotaWritten = true;
                }
              : undefined,
            previousCumulativeForSession: (id, timestamp) => {
              if (archiveEnd !== null) throw unsupported();
              const beforeMs = Date.parse(timestamp);
              if (!Number.isSafeInteger(beforeMs)) return null;
              baseline = { homeId: source.id, sessionId: String(id), beforeMs };
              const row = database
                .prepare(`SELECT COUNT(*) AS count,SUM(total) AS total,SUM(input) AS input,
            SUM(cached) AS cached,SUM(output) AS output,SUM(reasoning) AS reasoning,
            MIN(detail_mask & 1) AS i,MIN(detail_mask & 2) AS c,MIN(detail_mask & 4) AS o,
            MIN(detail_mask & 8) AS r,SUM(cache_write_tokens) AS writes,MIN(cache_write_known) AS known
            FROM events WHERE session_id=? AND home_id=? AND source_path<>? AND timestamp_ms<?`)
                .get(id, source.id, filePath, beforeMs);
              return row.count
                ? {
                    usage: usageFromRow(row),
                    detailMask: Number(row.i || 0) | Number(row.c || 0) | Number(row.o || 0) | Number(row.r || 0),
                    cacheWrite: { tokens: Number(row.writes || 0), known: Boolean(row.known) },
                  }
                : null;
            },
          },
        );
        if (!checkpoint || sourceSessionId(checkpoint, filePath) !== sessionId) throw unsupported();
        checkpoint = { ...checkpoint, store: { format: 1, sessionId, lastQuotaSource } };
        const proof = await this.sourceProof.capture(
          filePath,
          checkpoint.offset,
          info,
          verified,
          parsedHash ? { offset: parsedOffset, digest: parsedHash.copy().digest("hex") } : null,
        );
        database
          .prepare("UPDATE source_files SET size=?,mtime_ms=?,indexed_at=? WHERE path=?")
          .run(info.size, info.mtimeMs, new Date().toISOString(), filePath);
        if (codex) {
          writeUsageSourceBaseline(database, filePath, baseline);
          markUsageSourceDependents(database, filePath, bounds);
        }
        if (!writeUsageSourceProgress(database, filePath, checkpoint, proof.validation)) throw unsupported();
        for (const warning of warnings) onWarning?.(warning);
        if (projectionBefore)
          this.historyProjectionModule.recordHistoryProjectionBatch(database, projectionBefore, {
            sources: [filePath],
            mode: "append",
          });
        database.exec("COMMIT");
        this.writeTransactionDepth -= 1;
        return {
          committed: true,
          quotaWritten,
          appended: true,
          sessionId,
          parsedBytes: info.size - saved.checkpoint.offset,
          prefixBytesRead: (verified.readBytes || 0) + (proof.readBytes || 0),
          journalBytes: (verified.journalBytes || 0) + (proof.journalBytes || 0),
        };
      } catch (error) {
        database.exec("ROLLBACK");
        this.rollbackReplaceFileTransaction();
        if (error.code === "SOURCE_PROGRESS_UNSUPPORTED") return null;
        throw error;
      } finally {
        bounds.close();
      }
    }

    async recertifyUnchangedFile({ filePath, info }, saved) {
      if (!saved || saved.checkpoint.offset !== info.size) return false;
      // A returned file may have a new inode. An identical full certified prefix preserves the existing facts.
      const validation =
        saved.validation.kind === USAGE_SOURCE_SHA_KIND
          ? { ...saved.validation, identity: usageSourceIdentity(info) }
          : saved.validation;
      const verified = await this.sourceProof.verify(filePath, validation, saved.checkpoint.offset, info);
      if (!verified) return false;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        if (JSON.stringify(readUsageSourceProgress(this.database, filePath)) !== JSON.stringify(saved)) {
          this.database.exec("ROLLBACK");
          return false;
        }
        const proof = await this.sourceProof.capture(filePath, saved.checkpoint.offset, info, verified);
        writeUsageSourceProgress(this.database, filePath, saved.checkpoint, proof.validation);
        this.database.exec("COMMIT");
        this.lastSyncSourceWork.prefixBytesRead += (verified.readBytes || 0) + (proof.readBytes || 0);
        this.lastSyncSourceWork.journalBytes += (verified.journalBytes || 0) + (proof.journalBytes || 0);
        return true;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    async checkSources(options = this.options) {
      await this.open();
      this.sourceAcquisition ||= new UsageSourceAcquisition(this, { readInputs: this.sourceInputReader });
      const status = await this.sourceAcquisition.checkUnchanged(options);
      this.lastAcquisitionWork = this.sourceAcquisition.work;
      return status;
    }

    async sync(args = {}) {
      const view = { warnings: null };
      this.publishedFileWarningsView = view;
      try {
        await this.open();
        this.sourceAcquisition ||= new UsageSourceAcquisition(this, { readInputs: this.sourceInputReader });
        const acquisition = this.sourceAcquisition;
        const options = args.options || this.options;
        const plan = args.forceFull ? null : await acquisition.prepare(options, args.sourceHints);
        if (!plan && args.certifiedOnly) {
          this.lastAcquisitionWork = acquisition.work;
          return null;
        }
        let bootstrap = null;
        if (!plan) {
          try {
            bootstrap = await acquisition.beginFull(options);
          } catch (error) {
            if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
            acquisition.work = { mode: "fallback", reason: error.code };
          }
        }
        try {
          const result = await this.syncRound({ ...args, acquisitionPlan: plan });
          const receipt = await acquisition.complete(
            options,
            plan || bootstrap,
            this.acquisitionFiles || [],
            result,
            !plan,
          );
          this.lastAcquisitionWork = acquisition.work;
          if (plan && !receipt) {
            // Facts may have committed. A full retry reuses their parser checkpoints.
            return await this.sync({ ...args, certifiedOnly: false, forceFull: true });
          }
          return { ...result, ...(receipt ? { acquisition: receipt } : {}) };
        } catch (error) {
          acquisition.invalidate();
          if (error.code === "LIVE_SOURCE_CHANGED" && error.retryable === true)
            throw Object.assign(new Error("Source update is still pending"), {
              code: "SOURCE_UPDATE_PENDING",
              statusCode: 409,
              retryable: true,
            });
          if (plan && error.code === "SOURCE_COVERAGE_UNAVAILABLE")
            return await this.sync({ ...args, certifiedOnly: false, forceFull: true });
          throw error;
        }
      } finally {
        if (this.publishedFileWarningsView === view) this.publishedFileWarningsView = null;
        this.acquisitionFiles = null;
      }
    }

    assertSourceRepairsComplete() {
      if (this.database.prepare("SELECT 1 FROM usage_source_reparse LIMIT 1").get()) {
        throw Object.assign(
          new Error("Source dependency repair is incomplete; retry when the affected source is available"),
          {
            code: "SOURCE_DEPENDENCY_PENDING",
          },
        );
      }
    }

    /**
     * Discover sources, replace changed usage files, refresh missing-source state,
     * and rebuild ordinary usage projections and rollups.
     * @param {{ options?: any, acquisitionPlan?: any }} [args]
     */
    async syncRound({ options, acquisitionPlan: plan } = {}) {
      await this.open();
      this.syncDerivedRevision();
      createUsageRollups(this.database);
      if (historyArchiveAuthorizedSegmentIds(this.database).size > 0) await this.ensureHistoryProjectionTracking();
      const syncOptions = options || this.options;
      this.options = syncOptions;
      syncOptions.onImportStage?.("reading");
      const discoveryWarnings = [];
      const homes =
        plan?.homes ||
        (await discoverUsageSources({ ...syncOptions, onWarning: (warning) => discoveryWarnings.push(warning) }));
      const quotaObservations = readCodexQuotaObservations({ ...syncOptions, homes });
      if (quotaObservations.length) {
        const saved = JSON.stringify(quotaObservations);
        if (this.readMetaRaw("official_quota_observations") !== saved) {
          this.withHistoryProjectionInputChange(() => this.writeMeta("official_quota_observations", saved));
          this.commitStoreRevision("quota");
        }
      }

      const {
        files,
        warnings,
        failedHomes = [],
      } = plan ? { files: plan.files, warnings: [...plan.warnings] } : await this.usageFiles(homes);
      warnings.push(...discoveryWarnings);
      this.acquisitionFiles = files;
      const status = plan
        ? {
            fingerprint: files.length
              ? createHash("sha256").update(plan.fingerprint).update(JSON.stringify(plan.volumes)).digest("hex")
              : plan.fingerprint,
            checkedAt: new Date().toISOString(),
            fileCount: plan.fileCount,
          }
        : await buildUsageFingerprint({ ...syncOptions, homes, scannedFiles: files, failedHomes });
      const knownFiles = new Set(files.map((file) => file.filePath));
      const failedHomeIds = new Set(failedHomes.map((home) => home.id));
      const failedHomePaths = new Set(failedHomes.map((home) => home.path));
      const sourceRowsBefore = [];
      if (!plan) {
        // Rename detection only needs missing paths; keep their pre-sync ownership and ambiguity.
        for (const row of this.database.prepare("SELECT * FROM source_files").iterate()) {
          if (!knownFiles.has(row.path)) sourceRowsBefore.push(row);
        }
        if (!this.database.prepare("SELECT 1 FROM archive_segments LIMIT 1").get()) {
          // Codex moves rollouts between these roots, sometimes compressing them in the same operation.
          const identity = (filePath, homePath) => {
            const relative = path.relative(homePath, plainRolloutPath(filePath));
            const root = relative.split(path.sep)[0];
            const name = path.basename(relative);
            return ["sessions", "archived_sessions"].includes(root) &&
              /^rollout-.*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(name)
              ? { root, name }
              : null;
          };
          for (const file of files) {
            if (canonicalizeKind(file.source.kind) !== "codex") continue;
            const next = identity(file.filePath, file.source.path);
            if (!next) continue;
            const candidates = sourceRowsBefore.filter((old) => {
              const prior = identity(String(old.path), String(old.home_path));
              return (
                old.home_id === file.source.id &&
                canonicalizeKind(old.kind) === "codex" &&
                !failedHomeIds.has(old.home_id) &&
                !failedHomePaths.has(old.home_path) &&
                prior?.name === next.name &&
                prior.root !== next.root
              );
            });
            if (
              candidates.length !== 1 ||
              files.filter(
                (other) =>
                  other.source.id === file.source.id && identity(other.filePath, other.source.path)?.name === next.name,
              ).length !== 1
            )
              continue;
            try {
              await stat(String(candidates[0].path));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
              file.relocatedFrom = String(candidates[0].path);
              file.force = true;
            }
          }
        }
      }
      let publishedFingerprints = {};
      try {
        publishedFingerprints = plan ? {} : JSON.parse(this.readMetaRaw("usage_file_fingerprints") || "{}");
        if (!publishedFingerprints || typeof publishedFingerprints !== "object" || Array.isArray(publishedFingerprints))
          publishedFingerprints = {};
      } catch {
        // The committed usage rows remain authoritative if this small scan cache is unavailable.
      }
      if (!plan) {
        const indexedSource = this.database.prepare("SELECT indexed_at FROM source_files WHERE path=?");
        for (const row of this.database
          .prepare("SELECT payload FROM usage_source_catalog WHERE role='file'")
          .iterate()) {
          try {
            const saved = JSON.parse(String(row.payload));
            // Failed publication can leave the catalog older than already committed source facts.
            if (saved.fingerprint && saved.indexedAt === indexedSource.get(saved.filePath)?.indexed_at)
              publishedFingerprints[saved.filePath] = saved.fingerprint;
          } catch {
            /* Rebuildable catalog; full source verification remains authoritative. */
          }
        }
      }
      const nextFingerprints = { ...publishedFingerprints };
      const currentFingerprints = await this.usageFileFingerprints(files);
      const committedPaths = new Set();
      const changedSessions = new Set();
      let updatedFileCount = 0;
      let usageDerivedChanged = false;
      let historyVerificationPending = false;
      const sourceWork = {
        appendedFiles: 0,
        replacedFiles: 0,
        parsedBytes: 0,
        prefixBytesRead: 0,
        journalBytes: 0,
        sourceRetries: 0,
      };
      this.lastSyncSourceWork = sourceWork;
      const acceptSource = (file, outcome) => {
        delete file.relocatedFrom;
        historyVerificationPending ||= Boolean(outcome.historyVerificationPending);
        updatedFileCount += 1;
        committedPaths.add(file.filePath);
        nextFingerprints[file.filePath] = usageSourceFingerprint(file.filePath);
        file.sourceValidation = outcome.sourceValidation;
        sourceWork[outcome.appended ? "appendedFiles" : "replacedFiles"] += 1;
        for (const key of ["parsedBytes", "prefixBytesRead", "journalBytes"]) sourceWork[key] += outcome[key] || 0;
        if (outcome.appended) changedSessions.add(outcome.sessionId);
        else
          for (const row of this.database
            .prepare("SELECT DISTINCT session_id FROM events WHERE source_path=?")
            .all(file.filePath))
            changedSessions.add(row.session_id);
        usageDerivedChanged = true;
        if (outcome.truncationWarning) warnings.push(outcome.truncationWarning);
        for (const warning of outcome.projectLogWarnings || []) warnings.push(warning);
        this.commitStoreRevision(outcome.quotaWritten ? "usage+quota" : "usage");
      };

      const sourceAttempts = new Map();
      const pendingSource = () =>
        Object.assign(new Error("Source update is still pending"), {
          code: "SOURCE_UPDATE_PENDING",
          statusCode: 409,
          retryable: true,
        });
      const retrySource = async (file, work) => {
        while (true) {
          const attempt = sourceAttempts.get(file.filePath) || 0;
          if (attempt >= 3) throw pendingSource();
          sourceAttempts.set(file.filePath, attempt + 1);
          const warningCount = warnings.length;
          try {
            return await work();
          } catch (error) {
            if (
              error.code !== "LIVE_SOURCE_CHANGED" ||
              error.retryable !== true ||
              this.database.isTransaction ||
              this.writeTransactionDepth
            )
              throw error;
            warnings.length = warningCount;
            if (attempt === 2) throw pendingSource();
            // A failed source transaction has rolled back; other committed sources keep their cursors.
            file.info =
              file.source.kind === "hermes" ? await hermesSourceStat(file.filePath) : await stat(file.filePath);
            file.force = true;
            file.reobserved = true;
            currentFingerprints.set(file.filePath, usageSourceFingerprint(file.filePath));
            sourceWork.sourceRetries++;
          }
        }
      };

      const readSource = this.database.prepare(
        "SELECT size, mtime_ms, kind, home_id, home_label, home_path FROM source_files WHERE path = ?",
      );
      const readSourceSessions = this.database.prepare("SELECT DISTINCT session_id FROM events WHERE source_path = ?");
      const readReparse = this.database.prepare("SELECT 1 FROM usage_source_reparse WHERE source_path=?");
      for (const file of files) {
        await retrySource(file, async () => {
          const existing = readSource.get(file.filePath);
          const savedProgress = existing ? readUsageSourceProgress(this.database, file.filePath) : null;
          // shortcut: mutable Hermes snapshots require full reads until SQLite change proofs cover WAL updates.
          const unchanged =
            file.source.kind !== "hermes" &&
            existing &&
            Number(existing.size) === file.info.size &&
            Number(existing.mtime_ms) === file.info.mtimeMs &&
            existing.kind === (file.source.kind || "codex") &&
            existing.home_id === file.source.id &&
            existing.home_label === file.source.label &&
            existing.home_path === file.source.path &&
            (publishedFingerprints[file.filePath] === undefined ||
              publishedFingerprints[file.filePath] === currentFingerprints.get(file.filePath));
          const earlierFileChanged =
            existing &&
            changedSessions.size > 0 &&
            readSourceSessions.all(file.filePath).some((row) => changedSessions.has(row.session_id));
          const needsReparse = Boolean(readReparse.get(file.filePath));
          if (!file.force && unchanged && !earlierFileChanged && !needsReparse) {
            const proofCurrent =
              !savedProgress ||
              ([USAGE_SOURCE_SHA_KIND, "ntfs-usn-v1"].includes(savedProgress.validation.kind) &&
                savedProgress.validation.identity === usageSourceIdentity(file.info) &&
                savedProgress.validation.ctimeMs === file.info.ctimeMs);
            if (proofCurrent || (await this.recertifyUnchangedFile(file, savedProgress))) {
              nextFingerprints[file.filePath] = currentFingerprints.get(file.filePath);
              return;
            }
          }
          try {
            const callbacks = {
              onWarning: (warning) => warnings.push(String(warning)),
              progress: file.readMode !== "full",
              reuseHistoryProjection: true,
            };
            const outcome =
              (!file.relocatedFrom && !earlierFileChanged && !needsReparse && file.readMode !== "full"
                ? await this.appendFile(file, callbacks)
                : null) || (await this.replaceFile(file, callbacks));
            if (!outcome?.committed) {
              if (plan)
                throw Object.assign(new Error("Selected source did not commit"), { code: "LIVE_SOURCE_CHANGED" });
              return;
            }
            acceptSource(file, outcome);
          } catch (error) {
            if (plan) throw error;
            if (file.relocatedFrom || needsReparse || error.code === "LIVE_SOURCE_CHANGED") throw error;
            if (canonicalizeKind(file.source.kind) === "codex" && (Number(error?.errcode) & 0xff) === 19) throw error;
            warnings.push(`无法索引 ${file.filePath}: ${error.message}`);
          }
        });
      }

      // Dependencies may precede their changed producer in discovery order, or survive a process crash.
      const availableFiles = new Map(files.map((file) => [file.filePath, file]));
      while (true) {
        const pending = this.database
          .prepare(`SELECT source_path FROM usage_source_reparse ORDER BY source_path${plan ? " LIMIT 2049" : ""}`)
          .all();
        if (plan && pending.length > 2048)
          throw Object.assign(new Error("Source dependency budget exceeded"), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
        const available = [];
        for (const row of pending) {
          const file =
            availableFiles.get(String(row.source_path)) ||
            (plan ? await this.sourceAcquisition.file(String(row.source_path)) : null);
          if (file) {
            available.push(file);
            if (!availableFiles.has(file.filePath)) {
              if (plan && availableFiles.size >= 2048)
                throw Object.assign(new Error("Source dependency budget exceeded"), {
                  code: "SOURCE_COVERAGE_UNAVAILABLE",
                });
              availableFiles.set(file.filePath, file);
              files.push(file);
            }
          }
        }
        if (!available.length) break;
        for (const file of available) {
          file.info = await stat(file.filePath);
          const outcome = await retrySource(file, () =>
            this.replaceFile(file, {
              onWarning: (warning) => warnings.push(String(warning)),
              progress: file.readMode !== "full",
            }),
          );
          acceptSource(file, outcome);
        }
      }
      this.assertSourceRepairsComplete();

      for (const old of sourceRowsBefore) {
        if (knownFiles.has(old.path) || failedHomeIds.has(old.home_id) || failedHomePaths.has(old.home_path)) continue;
        const fingerprint = publishedFingerprints[old.path];
        const matchingOldPaths = sourceRowsBefore.filter(
          (row) =>
            !knownFiles.has(row.path) &&
            row.home_id === old.home_id &&
            canonicalizeKind(row.kind) === canonicalizeKind(old.kind) &&
            publishedFingerprints[row.path] === fingerprint,
        );
        if (matchingOldPaths.length !== 1) continue;
        const replacements = files.filter(
          (file) =>
            committedPaths.has(file.filePath) &&
            file.source.id === old.home_id &&
            canonicalizeKind(file.source.kind) === canonicalizeKind(old.kind) &&
            typeof fingerprint === "string" &&
            nextFingerprints[file.filePath] === fingerprint,
        );
        if (replacements.length !== 1) continue;
        this.database.exec("BEGIN IMMEDIATE");
        try {
          this.database.prepare("DELETE FROM quota_usage_sources WHERE source_path = ?").run(old.path);
          this.database.prepare("DELETE FROM source_files WHERE path = ?").run(old.path);
          this.database.exec("COMMIT");
        } catch (error) {
          this.database.exec("ROLLBACK");
          throw error;
        }
        delete nextFingerprints[String(old.path)];
        usageDerivedChanged = true;
        this.commitStoreRevision("usage-delete");
      }

      syncOptions.onImportStage?.("statistics");
      const publishedFileWarnings = this.publishedFileWarningsForRound();
      if (!plan) {
        const activeSourcePaths = new Set(
          this.database
            .prepare("SELECT path FROM source_files")
            .all()
            .map((row) => String(row.path)),
        );
        for (const filePath of Object.keys(publishedFileWarnings)) {
          if (!activeSourcePaths.has(filePath)) delete publishedFileWarnings[filePath];
        }
        for (const filePath of Object.keys(nextFingerprints)) {
          if (!activeSourcePaths.has(filePath)) delete nextFingerprints[filePath];
        }
      }
      for (const [filePath, fileWarnings] of Object.entries(publishedFileWarnings)) {
        for (const warning of fileWarnings) {
          if (warning.code === PROJECT_LOG_TRUNCATION_WARNING_CODE) {
            const message = formatProjectLogTruncationWarning(filePath, warning.count);
            if (!warnings.includes(message)) warnings.push(message);
          } else if (warning.code === PROJECT_LOG_MALFORMED_LINE_WARNING_CODE) {
            for (const lineNumber of warning.lineNumbers || []) {
              const message = formatProjectLogMalformedLineWarning(filePath, lineNumber);
              if (!warnings.includes(message)) warnings.push(message);
            }
          }
        }
      }
      if (this.publishedFileWarningsView) {
        this.publishedFileWarningsView.warnings = { ...publishedFileWarnings };
      }
      const publishedFileWarningsSnapshot = JSON.stringify(publishedFileWarnings);

      const previousMissingSources = decodeMissingSources(this.readMetaRaw(MISSING_SOURCES_META));
      const previousMissingByPath = new Map(previousMissingSources.map((source) => [source.path, source]));
      const missingSinceMs = Date.now();
      const missingSources = plan
        ? plan.missingSources
        : this.database
            .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files ORDER BY path")
            .all()
            .filter(
              (row) =>
                !knownFiles.has(String(row.path)) &&
                !failedHomeIds.has(row.home_id) &&
                !failedHomePaths.has(row.home_path),
            )
            .map((row) => {
              const previous = previousMissingByPath.get(String(row.path));
              const kind = String(row.kind ?? "");
              const homeId = String(row.home_id ?? "");
              return {
                path: String(row.path),
                kind,
                homeId,
                homeLabel: String(row.home_label ?? ""),
                homePath: String(row.home_path ?? ""),
                missingSinceMs:
                  previous?.kind === kind && previous?.homeId === homeId ? previous.missingSinceMs : missingSinceMs,
              };
            });

      const nextQuotaEvidence = loadQuotaSourceEvidence(
        homes,
        this.quotaSourceEvidence && quotaSourceEvidenceSnapshot(this.quotaSourceEvidence),
      );
      const quotaEvidenceSnapshot = JSON.stringify(quotaSourceEvidenceSnapshot(nextQuotaEvidence));
      const previousQuotaEvidence = this.readMetaRaw("quota_source_log_evidence");
      if (quotaEvidenceSnapshot !== previousQuotaEvidence) {
        this.withHistoryProjectionInputChange(() => this.writeMeta("quota_source_log_evidence", quotaEvidenceSnapshot));
        if (previousQuotaEvidence !== undefined || quotaSourceEvidenceSnapshot(nextQuotaEvidence).entries.length) {
          this.commitStoreRevision("quota-source");
        }
      }
      this.quotaSourceEvidence = nextQuotaEvidence;
      this.quotaSourceRevision = -1;
      this.synchronizeEditionEvidence?.(homes);

      const previousHomeShape = this.homes
        .map((home) => `${home?.kind}\u0000${home?.id}\u0000${home?.label}\u0000${home?.path}`)
        .join("\n");
      const nextHomeShape = homes
        .map((home) => `${home?.kind}\u0000${home?.id}\u0000${home?.label}\u0000${home?.path}`)
        .join("\n");
      const homeSetChanged = previousHomeShape !== nextHomeShape;
      if (homeSetChanged && !usageDerivedChanged) this.commitStoreRevision("home");

      if (sourceWork.sourceRetries) {
        if (plan) {
          status.fingerprint = createHash("sha256")
            .update(status.fingerprint)
            .update(
              JSON.stringify(
                files
                  .filter((file) => file.reobserved)
                  .map((file) => [
                    file.filePath,
                    file.info.size,
                    file.info.mtimeMs,
                    file.info.ctimeMs,
                    usageSourceIdentity(file.info),
                  ]),
              ),
            )
            .digest("hex");
        } else
          Object.assign(
            status,
            await buildUsageFingerprint({ ...syncOptions, homes, scannedFiles: files, failedHomes }),
          );
      }
      this.homes = homes;
      this.generatedAt = new Date().toISOString();
      this.fingerprint = status.fingerprint;
      this.checkedAt = status.checkedAt;
      this.warnings = warnings;

      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.writeMeta("generated_at", this.generatedAt);
        this.writeMeta("fingerprint", this.fingerprint);
        if (!plan) this.writeMeta("usage_file_fingerprints", JSON.stringify(nextFingerprints));
        if (this.readMetaRaw("perf_file_warnings") !== publishedFileWarningsSnapshot) {
          this.writeMeta("perf_file_warnings", publishedFileWarningsSnapshot);
        }
        this.writeMeta(MISSING_SOURCES_META, JSON.stringify(missingSources));
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }

      if (usageDerivedChanged || homeSetChanged || this.storeRevision !== this.derivedRevision) {
        this.metadataCache = null;
        this.periodComparisonCache.clear();
        this.summaryProjectionCache = null;
        this.quotaObservationCache = null;
      } else if (this.metadataCache !== null) {
        this.metadataCache.generatedAt = this.generatedAt;
        this.metadataCache.warnings = this.warnings;
      }
      this.derivedRevision = this.storeRevision;

      for (const file of files) file.acquisitionFingerprint = nextFingerprints[file.filePath];

      const dirtyRollupDays = listDirtyUsageRollupDays(this.database);
      const localRollupZone = currentLocalRollupZoneIdentity();
      const localRollupZoneChanged = this.readMetaRaw(LOCAL_ROLLUP_ZONE_META) !== localRollupZone;
      this.lastSyncRollupWork = null;
      if (
        dirtyRollupDays.length > 0 &&
        !localRollupZoneChanged &&
        historyArchiveAuthorizedSegmentIds(this.database).size === 0
      ) {
        this.lastSyncRollupWork = this.withBusinessProjection(() =>
          tryAppendUsageRollups(this.database, { zoneIdentity: localRollupZone }),
        );
      }
      if (
        (dirtyRollupDays.length > 0 && !this.lastSyncRollupWork?.applied) ||
        localRollupZoneChanged ||
        historyVerificationPending
      ) {
        if (historyArchiveAuthorizedSegmentIds(this.database).size > 0) {
          await this.withSqlHistoryReader((reader) => {
            if (!localRollupZoneChanged && listDirtyUsageRollupDays(this.database).length === 0) return;
            this.database.exec("BEGIN IMMEDIATE");
            this.writeTransactionDepth += 1;
            try {
              if (
                reader.historyProjectionInput &&
                !this.historyProjectionModule.sameHistoryProjectionStamp(
                  reader.historyProjectionInput,
                  this.historyProjectionModule.readHistoryProjectionStamp(this.database),
                )
              ) {
                throw Object.assign(new Error("History inputs changed before rollup publication"), {
                  code: "HISTORY_PROJECTION_INPUT_CHANGED",
                });
              }
              const roundDirtyDays = listDirtyUsageRollupDays(this.database);
              function* eventsFor(days, calendarZone) {
                const statement = reader.database.prepare(
                  "SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms <= ? ORDER BY id",
                );
                for (const day of [...new Set(days)].sort()) {
                  const range = resolveDateRange({ preset: "custom", startDate: day, endDate: day, calendarZone });
                  for (const row of statement.iterate(range.start.getTime(), range.end.getTime())) {
                    yield publishedUsageEventFromRow(row, "unknown", null);
                  }
                }
              }
              if (roundDirtyDays.length > 0) {
                rebuildUsageRollupsFromEvents(this.database, {
                  days: roundDirtyDays,
                  events: eventsFor(roundDirtyDays, "utc"),
                });
              }
              const localDays = new Set(localUsageRollupDaysForUtcDays(roundDirtyDays));
              if (localRollupZoneChanged) {
                const eventUtcDays = reader.database
                  .prepare("SELECT DISTINCT date(timestamp_ms / 1000.0, 'unixepoch') AS day_key FROM events")
                  .all()
                  .map((row) => {
                    if (row.day_key === null)
                      throw new TypeError("complete history contains an invalid event timestamp");
                    return String(row.day_key);
                  });
                for (const day of localUsageRollupDaysForUtcDays(eventUtcDays)) localDays.add(day);
                for (const row of this.database
                  .prepare("SELECT day_key FROM usage_rollup_days WHERE calendar_zone = 'local'")
                  .all()) {
                  localDays.add(String(row.day_key));
                }
              }
              const days = [...localDays].sort();
              rebuildUsageRollupsFromEvents(this.database, {
                days,
                events: eventsFor(days, "local"),
                calendarZone: "local",
              });
              this.writeMeta(LOCAL_ROLLUP_ZONE_META, localRollupZone);
              this.database.exec("COMMIT");
            } catch (error) {
              try {
                this.database.exec("ROLLBACK");
              } finally {
                this.writeTransactionDepth -= 1;
              }
              throw error;
            }
            this.writeTransactionDepth -= 1;
          });
        } else {
          this.database.exec("SAVEPOINT usage_rollup_sync");
          try {
            const initial = tryInitializeUsageRollups(this.database, { zoneIdentity: localRollupZone });
            if (!initial.applied && dirtyRollupDays.length > 0) {
              rebuildUsageRollups(this.database, { days: dirtyRollupDays, calendarZone: "utc" });
            }
            const localDays = new Set(localUsageRollupDaysForUtcDays(dirtyRollupDays));
            if (!initial.applied && localRollupZoneChanged) {
              const eventUtcDays = this.database
                .prepare("SELECT DISTINCT date(timestamp_ms / 1000.0, 'unixepoch') AS day_key FROM events")
                .all()
                .map((row) => String(row.day_key));
              for (const day of localUsageRollupDaysForUtcDays(eventUtcDays)) localDays.add(day);
              for (const row of this.database
                .prepare("SELECT day_key FROM usage_rollup_days WHERE calendar_zone = 'local'")
                .all()) {
                localDays.add(String(row.day_key));
              }
            }
            if (!initial.applied)
              rebuildUsageRollups(this.database, { days: [...localDays].sort(), calendarZone: "local" });
            this.writeMeta(LOCAL_ROLLUP_ZONE_META, localRollupZone);
            const checkpoint = initial.applied
              ? initial.checkpoint
              : checkpointUsageRollups(this.database, { zoneIdentity: localRollupZone });
            this.lastSyncRollupWork = initial.applied
              ? initial
              : { ...this.lastSyncRollupWork, fallbackDays: dirtyRollupDays.length, checkpoint };
            this.database.exec("RELEASE usage_rollup_sync");
          } catch (error) {
            this.database.exec("ROLLBACK TO usage_rollup_sync");
            this.database.exec("RELEASE usage_rollup_sync");
            throw error;
          }
        }
      }

      if (this.deferredMetadataIndex && this.database.prepare("SELECT 1 FROM events LIMIT 1").get()) {
        this.database.exec("SAVEPOINT initial_metadata_index");
        try {
          ensureUsageMetadataSchema(this.database);
          this.database.prepare("DELETE FROM store_meta WHERE key=?").run(DEFERRED_METADATA_INDEX_META);
          this.database.exec("RELEASE initial_metadata_index");
          this.deferredMetadataIndex = false;
        } catch (error) {
          this.database.exec("ROLLBACK TO initial_metadata_index; RELEASE initial_metadata_index");
          throw error;
        }
      }

      if (
        !this.usageProjectionTracker &&
        !this.database.isTransaction &&
        !this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)
      ) {
        this.syncDerivedRevision();
        this.installUsageProjectionTracker();
        this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
      }
      return {
        ...status,
        updatedFileCount,
        missingSources,
      };
    }

    metadata(asOf = new Date()) {
      if (!this.metadataSnapshotRead) {
        this.assertSourceRepairsComplete();
        this.syncDerivedRevision();
        if (!this.metadataCache || this.metadataObservationCache?.revision !== this.storeRevision)
          this.prepareMetadataProjection();
        this.syncDerivedRevision();
      }
      return this.readMetadata(asOf);
    }

    /**
     * Explicit cold-aware metadata. Without authority this preserves the
     * synchronous metadata fast path in one savepoint; with authority it derives
     * every field from the same verified complete event carrier.
     * @param {Date} [asOf]
     */
    async metadataHistory(asOf = new Date()) {
      await this.open();
      this.assertSourceRepairsComplete();
      this.syncDerivedRevision();
      this.prepareMetadataProjection();
      this.syncDerivedRevision();
      let hasAuthority = false;
      this.database.exec("SAVEPOINT metadata_history_read");
      try {
        hasAuthority = Boolean(
          this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META),
        );
        if (!hasAuthority) {
          this.metadataSnapshotRead = true;
          try {
            return this.metadata(asOf);
          } finally {
            this.metadataSnapshotRead = false;
          }
        }
      } finally {
        this.database.exec("RELEASE metadata_history_read");
      }

      return this.withSqlHistoryReader((reader) => {
        reader.prepareMetadataProjection();
        return reader.readMetadata(asOf);
      });
    }

    usageReadContext() {
      return {
        database: this.database,
        homes: this.homes,
        sourceKinds: this.historySourceKinds,
        generatedAt: this.generatedAt,
        warnings: this.warnings,
        quotaSourceEvidence: this.quotaSourceEvidence,
        verifiedHistorySqlRead: this.verifiedHistorySqlRead,
        historyDiskRead: this.historyDiskRead,
        historyPersistentRead: this.historyPersistentRead,
        historyProjectionInput: this.historyProjectionInput,
        revision: this.storeRevision,
      };
    }

    usageReadView() {
      const input = this.usageReadContext();
      if (
        this.queryReadView?.reader.database === this.database &&
        Object.keys(input).every((key) => this.queryReadView.input[key] === input[key])
      )
        return this.queryReadView.reader;
      this.queryReadView?.reader.close();
      const reader = new UsageReader(input);
      this.queryReadView = { input, reader };
      return reader;
    }

    eventBounds(excludeHomes = []) {
      return this.usageReadView().eventBounds(excludeHomes);
    }

    rangeDetails(range, excludeHomes = []) {
      return this.usageReadView().rangeDetails(range, excludeHomes);
    }

    aggregateRange(range, excludeHomes = []) {
      return this.usageReadView().aggregateRange(range, excludeHomes);
    }

    /**
     * Read the complete published event carrier across hot facts and explicitly
     * authorized cold segments. This is async because verified cold packages
     * must be read; the original synchronous hot-only reader stays unchanged.
     * @returns {Promise<import("./usage-types.js").UsageEvent[]>}
     */
    async publishedHistoryUsageEvents() {
      const union = await this.historyArchiveEventUnionForRange(undefined, { completeHistory: true });
      this.quotaSourceLookup?.clearCache();
      return publishedUsageEventsFromUnion(union, this.historyEventEvidence?.(), this.quotaSourceFor.bind(this));
    }

    /**
     * Rebuild one UTC day from the complete authorized hot+cold event carrier.
     * BEGIN IMMEDIATE prevents another writer from changing captured facts while
     * verified cold files are awaited and the rollup rows are published.
     * @param {string} day
     */
    async rebuildHistoryRollupDay(day) {
      if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new TypeError(`day must be a YYYY-MM-DD string: ${String(day)}`);
      }
      const [year, month, date] = day.split("-").map(Number);
      const startMs = Date.UTC(year, month - 1, date);
      if (!Number.isFinite(startMs) || new Date(startMs).toISOString().slice(0, 10) !== day) {
        throw new RangeError(`invalid UTC day: ${day}`);
      }
      await this.open();
      await this.#rebuildHistoryRollupsTransaction("rebuildHistoryRollupDay", (database, events) => {
        if (events === null) rebuildUsageRollups(database, { days: [day] });
        else rebuildUsageRollupsFromEvents(database, { days: [day], events });
      });
    }

    /**
     * Rebuild every UTC and local day covered by the complete authorized
     * hot+cold history. Existing derived dates are included so stale rows and
     * rows from a previous local timezone are cleared, including when empty.
     */
    async rebuildHistoryRollups() {
      await this.open();
      await this.#rebuildHistoryRollupsTransaction("rebuildHistoryRollups", (database, events) => {
        createUsageRollups(database);
        const utcDays = completeHistoryRollupDays(database, events, "utc");
        const localDays = completeHistoryRollupDays(database, events, "local");
        if (events === null) {
          rebuildUsageRollups(database, { days: utcDays });
          rebuildUsageRollups(database, { days: localDays, calendarZone: "local" });
        } else {
          rebuildUsageRollupsFromEvents(database, { days: utcDays, events });
          rebuildUsageRollupsFromEvents(database, { days: localDays, events, calendarZone: "local" });
        }
        this.writeMeta(LOCAL_ROLLUP_ZONE_META, currentLocalRollupZoneIdentity());
      });
    }

    async #rebuildHistoryRollupsTransaction(methodName, publish) {
      if (this.database.isTransaction) {
        throw new Error(`${methodName} requires no active transaction`);
      }
      this.syncDerivedRevision();
      this.database.exec("BEGIN IMMEDIATE");
      this.writeTransactionDepth += 1;
      try {
        // Hot-only rebuilds aggregate in SQLite instead of materializing every event twice.
        const events =
          historyArchiveAuthorizedSegmentIds(this.database).size > 0 ? await this.publishedHistoryUsageEvents() : null;
        publish(this.database, events);
        this.database.exec("COMMIT");
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } finally {
          this.rollbackReplaceFileTransaction();
        }
        throw error;
      }
      if (this.writeTransactionDepth > 0) this.writeTransactionDepth -= 1;
      this.commitStoreRevision("history-rollup");
      this.syncDerivedRevision();
    }

    /**
     * Read the complete historical report from one hot snapshot plus verified
     * cold segments. Hot homes and quota are captured before cold reads start.
     * @returns {Promise<{
     *   events: import("./usage-types.js").UsageEvent[],
     *   homes: Array<{ id: string, label: string, path: string, kind: string }>,
     *   sessions: ReturnType<import("./usage-projection-owner.js").UsageProjectionOwner["publishedUsageSessions"]>,
     *   rateLimitObservations: import("./usage-types.js").RateLimitObservation[]
     * }>}
     */
    async publishedHistoryUsageReport() {
      const union = await this.historyArchiveEventUnionForRange(undefined, {
        completeHistory: true,
        includeUsageCarrier: true,
      });
      this.quotaSourceLookup?.clearCache();
      const events = publishedUsageEventsFromUnion(
        union,
        this.historyEventEvidence?.(),
        this.quotaSourceFor.bind(this),
      );
      const homes = union.homes ?? [];
      return {
        events,
        homes,
        sessions: publishedUsageSessionsFromEvents(events, homes),
        rateLimitObservations: union.rateLimitObservations ?? [],
      };
    }

    groupedRange(column, range, orderBy = "total DESC", excludeHomes = []) {
      return this.usageReadView().groupedRange(column, range, orderBy, excludeHomes);
    }

    repositoriesRange(range, excludeHomes = []) {
      return this.usageReadView().repositoriesRange(range, excludeHomes);
    }

    historyRepositorySessionOrder(where, firsts = null) {
      return this.usageReadView().historyRepositorySessionOrder(where, firsts);
    }

    periodAggregateCore(groupColumn, nameColumn, _now, ranges, { includeKind = false, excludeHomes = [] } = {}) {
      return this.usageReadView().periodAggregateCore(groupColumn, nameColumn, _now, ranges, {
        includeKind,
        excludeHomes,
      });
    }

    periodComparison(options = {}) {
      if (!this.periodComparisonSnapshotRead) {
        this.assertSourceRepairsComplete();
        this.syncDerivedRevision();
        this.prepareHotRollups();
        this.syncDerivedRevision();
      }
      return this.readPeriodComparison(options);
    }

    /**
     * Explicit cold-aware period comparison. Without an authority marker this
     * pins the marker and synchronous hot-only cached read in one savepoint; with
     * authority it uses the verified complete event carrier and shared algorithm.
     * @param {{ now?: string | Date, calendarZone?: string, excludeHomes?: string[], pricingModels?: Record<string, any> }} [options]
     */
    async periodComparisonHistory(options = {}) {
      await this.open();
      this.syncDerivedRevision();
      this.prepareHotRollups();
      this.syncDerivedRevision();
      let hasAuthority = false;
      // 无 authority 时，marker 与首次 period 读取必须共享同一 SQLite 读快照。
      // 快照内不再探测外部提交；缓存仍记在快照前的修订上，下一轮会按 data_version 失效。
      this.database.exec("SAVEPOINT period_comparison_history_read");
      try {
        hasAuthority = Boolean(
          this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META),
        );
        if (!hasAuthority) {
          this.periodComparisonSnapshotRead = true;
          try {
            return this.periodComparison(options);
          } finally {
            this.periodComparisonSnapshotRead = false;
          }
        }
      } finally {
        this.database.exec("RELEASE period_comparison_history_read");
      }
      return this.withSqlHistoryReader((reader) => {
        reader.prepareHotRollups();
        return reader.readPeriodComparison(options);
      });
    }

    withBusinessProjection(work) {
      const tracker = this.usageProjectionTracker;
      if (!tracker || tracker.database !== this.database) return work();
      if (tracker.owned) return work();
      if (tracker.mainSchema !== Number(this.database.prepare("PRAGMA main.schema_version").get().schema_version))
        return work();
      const tempSchema = Number(this.database.prepare("PRAGMA temp.schema_version").get().schema_version);
      if (tracker.tempSchema !== tempSchema) {
        // ROLLBACK can restore the TEMP schema version; certify its actual catalog before reuse.
        const catalog = JSON.stringify(
          this.database.prepare("SELECT type, name, tbl_name, sql FROM temp.sqlite_master ORDER BY type, name").all(),
        );
        if (catalog !== tracker.tempCatalog) return work();
        tracker.tempSchema = tempSchema;
      }
      const observe = () => ({
        changes: Number(this.database.prepare("SELECT total_changes() AS value").get().value),
        ignored: Number(this.database.prepare("SELECT value FROM usage_projection_ignored_rows").get().value),
      });
      // The enclosing scope accounts for its writes once; row triggers stay active for all other callers.
      this.database.exec("UPDATE usage_projection_ignored_rows SET owned = 1");
      tracker.owned = true;
      const before = observe();
      try {
        return work();
      } finally {
        try {
          const after = observe();
          this.database.exec("UPDATE usage_projection_ignored_rows SET owned = 0");
          // Owned TEMP work changes neither source facts nor their publication identity.
          this.businessProjectionIgnoredChanges +=
            2 + after.changes - before.changes - 2 * (after.ignored - before.ignored);
          tracker.tempSchema = Number(this.database.prepare("PRAGMA temp.schema_version").get().schema_version);
        } finally {
          tracker.owned = false;
        }
      }
    }

    summarize(filters = {}, options = {}) {
      this.assertSourceRepairsComplete();
      this.syncDerivedRevision();
      this.prepareHotRollups();
      this.prepareQuotaProjection(filters);
      this.prepareRecordProjection?.(filters);
      this.database.exec("BEGIN");
      const previousTransferable = this.summaryProjectionTransferableRead;
      this.summaryProjectionTransferableRead = true;
      try {
        const summary = this.summarizeInReadTransaction(filters, options);
        this.database.exec("COMMIT");
        return summary;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      } finally {
        this.summaryProjectionTransferableRead = previousTransferable;
      }
    }

    registerReadFunctions() {
      this.database.function("usage_day_key", (time) => timelineDateKey(new Date(Number(time)), "local"));
      this.database.function("usage_hour_start", (time) => rangeHourStart(Number(time), "local"));
      this.database.function("usage_quota_allowed", (model, homeId, sessionId, time) =>
        Number(
          isQuotaUsage({ model, quotaSource: this.quotaSourceFor(String(homeId), String(sessionId), Number(time)) }),
        ),
      );
      this.database.function("usage_source_group", (channel, kind) => sourceGroup(channel, String(kind ?? "")));
      this.database.function("usage_model_group", (model) => this.modelName(String(model ?? "")));
      this.registeredReadDatabase = this.database;
    }

    quotaSourceFor(homeId, sessionId, time) {
      if (
        this.quotaSourceDatabase !== this.database ||
        this.quotaSourceRevision !== this.storeRevision ||
        !this.quotaSourceLookup
      ) {
        this.quotaSourceLookup = createStoredQuotaSourceResolver(this.database, this.quotaSourceEvidence);
        this.quotaSourceDatabase = this.database;
        this.quotaSourceRevision = this.storeRevision;
      }
      const writing = this.writeTransactionDepth > 0;
      if (writing) this.quotaSourceLookup.clearCache();
      try {
        return this.quotaSourceLookup(homeId, sessionId, time);
      } finally {
        if (writing) this.quotaSourceLookup.clearCache();
      }
    }

    withSqlHistoryReader(read) {
      if (this.publishedHistoryProjection)
        return this.withHistoryVerification(() => this.withVerifiedPublishedHistoryRead(read));
      const key = this.databaseFile ? path.resolve(this.databaseFile) : this;
      const result = (historyProjectionQueues.get(key) || Promise.resolve()).then(() =>
        this.withHistoryVerification(() => this.withSqlHistoryReaderCore(read)),
      );
      const tail = result.then(
        () => {},
        () => {},
      );
      historyProjectionQueues.set(key, tail);
      void tail.then(() => {
        if (historyProjectionQueues.get(key) === tail) historyProjectionQueues.delete(key);
      });
      return result;
    }

    async createHistoryVerificationScope({ requireLeases = false } = {}) {
      if (this.historyVerificationOwner)
        return this.historyVerificationOwner.createHistoryVerificationScope({ requireLeases });
      if (!this.database || (!requireLeases && !historyArchiveAuthorizedSegmentIds(this.database).size)) return null;
      this.historyProjectionModule ||= await this.loadHistoryProjectionModule();
      this.historyProjectionStore ||= new this.historyProjectionModule.HistoryProjectionStore(
        this.databaseFile,
        canonicalFactPayload,
      );
      const { createHistoryVerificationScope } = await import("./history-backup.js");
      return createHistoryVerificationScope({
        requireLeases,
        receipts: this.historyProjectionStore.verificationReceipts(),
        pinFiles: async (files) => {
          this.sourceProof ||= new UsageSourceProof();
          const native = await this.sourceProof.provider();
          return (await native?.lockFiles(files)) || null;
        },
      });
    }

    async withHistoryVerification(work) {
      const { hasHistoryVerificationScope } = await import("./history-backup.js");
      if (hasHistoryVerificationScope()) return work();
      const scope = await this.createHistoryVerificationScope();
      if (!scope) return work();
      try {
        return await scope.run(work);
      } finally {
        await scope.close();
      }
    }

    /** Pin the owned projection, releasing the authoritative WAL before acquisition starts. */
    async acquirePublishedHistoryReader() {
      if (!historyArchiveAuthorizedSegmentIds(this.database).size) return null;
      this.historyProjectionModule ||= await this.loadHistoryProjectionModule();
      this.historyProjectionStore ||= new this.historyProjectionModule.HistoryProjectionStore(
        this.databaseFile,
        canonicalFactPayload,
      );
      const identity = this.usageProjectionDatabaseIdentity();
      if (
        identity === this.openedUsageProjectionIdentity &&
        this.readDataVersion() === this.observedDataVersion &&
        this.readMeta("fingerprint") === this.fingerprint &&
        this.readMeta("generated_at") === this.generatedAt
      ) {
        this.database.exec("SAVEPOINT history_published_capture");
        try {
          const pinned = this.historyProjectionStore.openPublished(
            this.database,
            identity,
            currentLocalRollupZoneIdentity(),
          );
          if (pinned) {
            try {
              const reader = this.createPublishedHistoryReader(pinned.file, pinned.database, this);
              reader.historyProjectionInput = pinned.stamp;
              reader.historySourceKinds = homeSourceKinds(reader.publishedUsageHomes());
              return reader;
            } catch (error) {
              pinned.database.close();
              throw error;
            }
          }
        } finally {
          this.database.exec("RELEASE history_published_capture");
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const acquired = await this.withSqlHistoryReader((current) => {
          if (
            !current.historyPersistentRead ||
            !this.historyProjectionStore?.file ||
            current.database !== this.historyProjectionStore.query?.database
          )
            return null;
          const file = path.join(this.historyProjectionStore.directory, this.historyProjectionStore.file);
          let database;
          try {
            database = new DatabaseSync(file, { readOnly: true });
            database.exec("PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; BEGIN");
            database.prepare("SELECT id FROM events LIMIT 1").get();
            return this.createPublishedHistoryReader(file, database, current);
          } catch (error) {
            database?.close();
            throw error;
          }
        });
        if (acquired) return acquired;
      }
      return null;
    }

    createPublishedHistoryReader(file, database, current) {
      const reader = this.createPublishedReader(
        {
          database,
          databaseFile: file,
          homes: current.homes,
          warnings: current.warnings,
          generatedAt: current.generatedAt,
          quotaSourceEvidence: current.quotaSourceEvidence,
          historyProjectionInput: current.historyProjectionInput,
          sourceKinds: current.historySourceKinds,
          verifiedHistorySqlRead: true,
          historyDiskRead: true,
          historyPersistentRead: true,
          publishedHistoryProjection: true,
          revision: current.storeRevision,
        },
        current.editionReadContext?.() ?? this.editionReadContext?.(),
      );
      reader.ownsDatabase = true;
      reader.withVerifiedRead = (read) =>
        this.withHistoryVerification(() => this.withVerifiedHistoryDatabaseRead(database, read));
      reader.registerReadFunctions();
      return reader;
    }

    async withVerifiedPublishedHistoryRead(read) {
      return this.withVerifiedHistoryDatabaseRead(this.database, () => read(this));
    }

    async withVerifiedHistoryDatabaseRead(database, read) {
      const { withVerifiedHistoryArchiveCandidate } = await import("./history-archive.js");
      const records = database.prepare("SELECT * FROM archive_segments ORDER BY start_ms,segment_id").all();
      const revisions = historyArchiveEventRevisions(
        database.prepare("SELECT value FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_REVISIONS_META)?.value,
        new Map(records.map((record) => [String(record.segment_id), record])),
      );
      const authorized = historyArchiveAuthorizedSegmentIds(database);
      for (const record of records)
        await withVerifiedHistoryArchiveCandidate(String(record.database_path), undefined, (cold, verified) => {
          const id = assertHistoryArchiveRecordMatches(record, verified);
          const sources = historyArchiveSourceIdentities(cold, Number(record.start_ms), Number(record.end_ms));
          if (Number(cold.prepare("SELECT COUNT(*) AS n FROM events").get().n) !== Number(record.event_count))
            throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_MISMATCH", "archive event count changed");
          validateHistoryArchiveSourceRevisions(cold, id, sources, revisions.get(id) || []);
          if (authorized.has(id)) {
            if (
              database
                .prepare(
                  "SELECT 1 FROM history_query_rows WHERE segment_id='hot' AND timestamp_ms>=? AND timestamp_ms<? LIMIT 1",
                )
                .get(record.start_ms, record.end_ms)
            )
              throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "authorized archive still has hot facts");
            if (Number(cold.prepare("SELECT COUNT(DISTINCT source_path) AS n FROM events").get().n) !== sources.length)
              throw historyArchiveError(
                "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
                "archive source identities are incomplete",
              );
            const liveSource = database.prepare(
              "SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?",
            );
            const effectiveSources = [
              ...sources,
              ...(revisions.get(id) || [])
                .filter((revision) => revision.binding === "introduced")
                .map((revision) => revision.sourceIdentity),
            ];
            for (const source of effectiveSources) {
              const live = liveSource.get(source.path);
              if (!live || !sameHistoryArchiveSourceIdentity(live, source))
                throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "live archive source identity changed");
            }
          }
        });
      return read();
    }

    loadHistoryProjectionModule() {
      return import("./usage-history-projection-store.js");
    }

    async ensureHistoryProjectionTracking() {
      this.historyProjectionModule ||= await this.loadHistoryProjectionModule();
      this.historyProjectionModule.ensureHistoryProjectionTracking(this.database);
      // Tracking is source schema; settle its metadata identity before synchronization is published.
      ensureUsageMetadataSchema(this.database, { deferIndex: this.deferredMetadataIndex });
    }

    withHistoryProjectionInputChange(work) {
      if (!this.historyProjectionModule) return work();
      this.database.exec("SAVEPOINT history_projection_input_change");
      try {
        const before = this.historyProjectionModule.readHistoryProjectionStamp(this.database);
        const value = work();
        this.historyProjectionModule.recordHistoryProjectionBatch(this.database, before, { mode: "inputs" });
        this.database.exec("RELEASE history_projection_input_change");
        return value;
      } catch (error) {
        this.database.exec("ROLLBACK TO history_projection_input_change; RELEASE history_projection_input_change");
        throw error;
      }
    }

    /** Capture hot facts once, releasing their WAL reader before package verification. */
    async withSqlHistoryReaderCore(read) {
      const started = performance.now();
      const previousPeriodComparison = this.historyPeriodComparisonCache;
      this.historyPeriodComparisonCache = null;
      const identity = this.usageProjectionDatabaseIdentity();
      const persistent =
        !this.database.isTransaction &&
        !this.writeTransactionDepth &&
        !this.verifiedHistorySqlRead &&
        identity &&
        historyArchiveAuthorizedSegmentIds(this.database).size > 0;
      const calendar = currentLocalRollupZoneIdentity();
      let projection = null,
        preparedProjection = null,
        query = null,
        releaseProjectionLock = null;
      try {
        if (persistent) {
          this.historyProjectionModule ||= await this.loadHistoryProjectionModule();
          this.historyProjectionStore ||= new this.historyProjectionModule.HistoryProjectionStore(
            this.databaseFile,
            canonicalFactPayload,
          );
          projection = this.historyProjectionStore;
          releaseProjectionLock = await projection.lock();
          if (!this.database)
            throw historyArchiveError("HISTORY_ARCHIVE_READ_CLOSED", "usage store closed while waiting for projection");
          await this.ensureHistoryProjectionTracking();
          preparedProjection = projection.prepare(this.database, identity, calendar);
        }
        const editionContext = this.editionReadContext?.();
        const context = {
          homes: structuredClone(this.homes),
          warnings: [...this.warnings],
          generatedAt: this.generatedAt,
          quotaSourceEvidence: this.quotaSourceEvidence,
          revision: this.storeRevision,
        };
        query = preparedProjection?.query || new UsageHistoryQuery(this.database, canonicalFactPayload);
        const database = query.database;
        if (projection) projection.verificationDatabase = database;
        let verifiedMs = 0;
        const inputs = preparedProjection?.delta?.database || database;
        const records = inputs.prepare("SELECT * FROM archive_segments ORDER BY start_ms,segment_id").all();
        const authorized = historyArchiveAuthorizedSegmentIds(inputs);
        const revisions = historyArchiveEventRevisions(
          inputs.prepare("SELECT value FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_REVISIONS_META)?.value,
          new Map(records.map((record) => [String(record.segment_id), record])),
        );
        const previousRevisions = preparedProjection?.delta
          ? historyArchiveEventRevisions(
              database.prepare("SELECT value FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_REVISIONS_META)
                ?.value,
              new Map(
                database
                  .prepare("SELECT * FROM archive_segments")
                  .all()
                  .map((record) => [String(record.segment_id), record]),
              ),
            )
          : null;
        for (const [from, to] of preparedProjection?.delta?.rebindings || []) {
          if (previousRevisions.has(from)) {
            previousRevisions.set(to, previousRevisions.get(from));
            previousRevisions.delete(from);
          }
        }
        const previousSegments = preparedProjection?.delta
          ? new Set(
              database
                .prepare("SELECT segment_id FROM archive_segments")
                .all()
                .map((row) => String(row.segment_id)),
            )
          : null;
        for (const [from, to] of preparedProjection?.delta?.rebindings || []) {
          if (previousSegments.delete(from)) previousSegments.add(to);
        }
        const liveSource = inputs.prepare(
          "SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?",
        );
        const { withVerifiedHistoryArchiveCandidate } = await import("./history-archive.js");
        for (const record of records) {
          const id = String(record.segment_id);
          const before = performance.now();
          await withVerifiedHistoryArchiveCandidate(String(record.database_path), undefined, (cold, verified) => {
            assertHistoryArchiveRecordMatches(record, verified);
            const sources = historyArchiveSourceIdentities(cold, Number(record.start_ms), Number(record.end_ms));
            if (Number(cold.prepare("SELECT COUNT(*) AS n FROM events").get().n) !== Number(record.event_count))
              throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_MISMATCH", "archive event count changed");
            const isAuthority = authorized.has(id);
            if (isAuthority) {
              if (
                (!preparedProjection?.delta &&
                  database
                    .prepare(
                      "SELECT 1 FROM history_query_rows WHERE segment_id='hot' AND timestamp_ms>=? AND timestamp_ms<? LIMIT 1",
                    )
                    .get(record.start_ms, record.end_ms)) ||
                (preparedProjection?.delta && inputs.prepare("SELECT 1 FROM hot_conflicts WHERE segment_id=?").get(id))
              )
                throw historyArchiveError(
                  "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
                  "authorized archive still has hot facts",
                );
              if (
                Number(cold.prepare("SELECT COUNT(DISTINCT source_path) AS n FROM events").get().n) !== sources.length
              )
                throw historyArchiveError(
                  "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
                  "archive source identities are incomplete",
                );
              const effectiveSources = [
                ...sources,
                ...(revisions.get(id) || [])
                  .filter((revision) => revision.binding === "introduced")
                  .map((revision) => revision.sourceIdentity),
              ];
              for (const source of effectiveSources) {
                const live = liveSource.get(source.path);
                if (!live || !sameHistoryArchiveSourceIdentity(live, source))
                  throw historyArchiveError(
                    "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
                    "live archive source identity changed",
                  );
              }
            }
            if (preparedProjection?.delta) {
              const current = revisions.get(id) || [],
                previous = previousRevisions.get(id) || [];
              validateHistoryArchiveSourceRevisions(cold, id, sources, current);
              if (!previousSegments.has(id) && isAuthority) {
                for (const source of [
                  ...sources,
                  ...current
                    .filter((revision) => revision.binding === "introduced")
                    .map((revision) => revision.sourceIdentity),
                ])
                  projection.captureColdSource(
                    preparedProjection,
                    id,
                    String(source.path),
                    revisedHistorySourceRows(cold, String(source.path), current),
                  );
                projection.work.coldCopied += Number(record.event_count);
                return;
              }
              if (!isAuthority) {
                const consume = inputs.prepare(
                  "UPDATE mirror_counts SET n=n-1 WHERE segment_id=? AND payload=? AND n>0",
                );
                for (const row of cold.prepare("SELECT * FROM events ORDER BY id").iterate()) {
                  if (!consume.run(id, JSON.stringify(canonicalFactPayload(row, ["id"]))).changes)
                    throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "hot facts do not mirror archive");
                }
                if (
                  inputs.prepare("SELECT 1 FROM mirror_counts WHERE segment_id=? AND n<>0 LIMIT 1").get(id) ||
                  JSON.stringify(sources) !==
                    inputs.prepare("SELECT sources_json FROM mirror_sources WHERE segment_id=?").get(id)?.sources_json
                )
                  throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "hot facts do not mirror archive");
              }
              const changed = new Set([...current, ...previous].map((entry) => entry.sourceIdentity.path));
              for (const file of changed) {
                const after = current.find((entry) => entry.sourceIdentity.path === file);
                const before = previous.find((entry) => entry.sourceIdentity.path === file);
                if (JSON.stringify(after) !== JSON.stringify(before))
                  projection.captureColdSource(
                    preparedProjection,
                    id,
                    file,
                    revisedHistorySourceRows(cold, file, current),
                  );
              }
              return;
            }
            if (preparedProjection?.reused || projection?.imported(query, id)) return;
            database.exec("BEGIN");
            try {
              query.add(cold.prepare("SELECT * FROM events ORDER BY id").iterate(), id);
              if (!isAuthority) {
                const differences = database
                  .prepare(`SELECT payload, SUM(n) AS n FROM (
                SELECT payload, 1 AS n FROM history_query_rows WHERE segment_id=?
                UNION ALL SELECT payload,-1 FROM history_query_rows
                  WHERE segment_id='hot' AND timestamp_ms>=? AND timestamp_ms<?
              ) GROUP BY payload HAVING SUM(n)<>0 LIMIT 1`)
                  .get(id, record.start_ms, record.end_ms);
                if (
                  differences ||
                  JSON.stringify(sources) !==
                    JSON.stringify(
                      historyArchiveSourceIdentities(database, Number(record.start_ms), Number(record.end_ms)),
                    )
                )
                  throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "hot facts do not mirror archive");
                database.prepare("DELETE FROM history_query_rows WHERE segment_id=?").run(id);
              } else {
                for (const revision of revisions.get(id) ?? []) {
                  if (
                    revision.binding !== "introduced" &&
                    !sources.some((source) => sameHistoryArchiveSourceIdentity(source, revision.sourceIdentity))
                  )
                    throw historyArchiveRevisionError("archive revision source binding does not match segment");
                  // Remove originals before replacements, so duplicate removals cannot consume additions.
                  for (const removed of revision.removed) {
                    if (query.remove(id, removed.payload, removed.count) !== removed.count)
                      throw historyArchiveRevisionError("archive revision removes more payloads than segment contains");
                  }
                  for (const added of revision.added) {
                    for (let i = 0; i < added.count; i++) query.add([added.payload], id);
                  }
                }
              }
              if (projection) {
                projection.markImported(query, id);
                projection.work.coldCopied += Number(record.event_count);
              }
              database.exec("COMMIT");
            } catch (error) {
              database.exec("ROLLBACK");
              throw error;
            }
          });
          verifiedMs += performance.now() - before;
        }
        let previousDay, previousWeek;
        const project = (row) => {
          // The carrier derives display/calendar fields at query time, after raw-payload ordering and validation.
          const date = new Date(Number(row.timestamp_ms));
          const day = localDateKey(date);
          if (day !== previousDay) {
            previousDay = day;
            previousWeek = localDateKey(startOfLocalWeek(date));
          }
          return {
            ...row,
            project: row.cwd === "" ? "Unknown cwd" : row.cwd,
            hour_key: `${day} ${String(date.getHours()).padStart(2, "0")}:00`,
            day_key: day,
            week_key: previousWeek,
            month_key: day.slice(0, 7),
          };
        };
        if (preparedProjection?.delta) projection.applyDelta(preparedProjection, EVENT_INSERT_COLUMNS, project);
        else if (!preparedProjection?.reused) query.finish(EVENT_INSERT_COLUMNS, project);
        if (
          database
            .prepare(
              "SELECT 1 FROM (SELECT DISTINCT source_path FROM events) e WHERE NOT EXISTS (SELECT 1 FROM source_files sf WHERE sf.path=e.source_path) LIMIT 1",
            )
            .get()
        )
          throw historyArchiveError(
            "HISTORY_ARCHIVE_SOURCE_CHANGED",
            "published event has no verified source identity",
          );
        if (projection) projection.publish(this.database, preparedProjection, identity, calendar);
        const periodContextKey = JSON.stringify([
          identity,
          calendar,
          preparedProjection?.stamp,
          context.revision,
          this.readDataVersion(),
          context.homes,
          editionContext?.key,
        ]);
        const reader = this.createQueryOwner(
          {
            database,
            databaseFile:
              database
                .prepare("PRAGMA database_list")
                .all()
                .find((row) => row.name === "main")?.file || null,
            ...context,
          },
          editionContext,
        );
        const periodCache = {
          query,
          key: periodContextKey,
          cache: new Map(),
        };
        if (
          preparedProjection?.reused &&
          previousPeriodComparison?.query === query &&
          previousPeriodComparison.key === periodContextKey
        )
          periodCache.cache = previousPeriodComparison.cache;
        reader.borrowPeriodComparisonCache(periodCache.cache);
        reader.homes = context.homes;
        reader.warnings = context.warnings;
        reader.generatedAt = context.generatedAt;
        reader.quotaSourceEvidence = context.quotaSourceEvidence;
        reader.storeRevision = reader.derivedRevision = context.revision;
        reader.summarySnapshotRead = reader.metadataSnapshotRead = reader.periodComparisonSnapshotRead = true;
        reader.verifiedHistorySqlRead = reader.historyDiskRead = true;
        reader.historyPersistentRead = Boolean(projection);
        reader.historyProjectionInput = preparedProjection?.stamp || null;
        reader.historySourceKinds = homeSourceKinds(reader.publishedUsageHomes());
        reader.registerReadFunctions();
        const prepared = performance.now();
        try {
          const result = read(reader);
          if (
            projection?.query === query &&
            this.historyProjectionStore === projection &&
            !projection.work.superseded &&
            reader.periodComparisonCache.size
          ) {
            this.historyPeriodComparisonCache = periodCache;
          }
          this.lastHistoryQueryWork = {
            rows: query.rows,
            archiveCount: records.length,
            verifiedAndMergeMs: verifiedMs,
            prepareMs: prepared - started,
            queryMs: performance.now() - prepared,
            scratchBytes: query.bytes,
            sort: query.sortStats,
            projection: projection?.work || null,
            views: projection
              ? {
                  all: reader.lastAllSummaryWork,
                  metadata: reader.lastMetadataWork,
                  records: reader.lastRecordWork,
                  rollups: reader.lastRollupWork,
                }
              : null,
          };
          return result;
        } finally {
          reader.close();
        }
      } finally {
        try {
          if (projection) projection.verificationDatabase = null;
          if (previousPeriodComparison?.cache !== this.historyPeriodComparisonCache?.cache)
            previousPeriodComparison?.cache.clear();
          preparedProjection?.delta?.database?.close();
          if (query && query !== projection?.query) query.close();
        } finally {
          releaseProjectionLock?.();
        }
      }
    }

    async trySqlHistoryDashboard(filters, options, periodOptions) {
      const single = await this.trySingleSqlHistoryDashboard(filters, options, periodOptions);
      if (single) return single;
      return this.withSqlHistoryReader((reader) => {
        if (reader.historyPersistentRead) {
          reader.prepareHotRollups();
          reader.prepareQuotaProjection(filters);
          reader.prepareRecordProjection?.(filters, { force: filters.preset === "all" });
          reader.prepareAllSummaryProjection?.(filters, options);
          reader.prepareMetadataProjection();
        }
        return {
          summary: reader.summarizeInReadTransaction(filters, options),
          metadata: reader.readMetadata(filters.now ? new Date(filters.now) : new Date()),
          periodComparison: reader.readPeriodComparison(periodOptions),
        };
      });
    }

    /** Preserve the established bounded single-package projection and repricing cache. */
    async trySingleSqlHistoryDashboard(filters, options, periodOptions) {
      const hot = this.database;
      // Other shapes are handled by the disposable disk reader.
      if (filters.preset !== "all" || hot.isTransaction !== false || this.writeTransactionDepth > 0) return null;
      const records = hot.prepare("SELECT * FROM archive_segments").all();
      const authorized = historyArchiveAuthorizedSegmentIds(hot);
      if (records.length !== 1 || authorized.size !== 1 || !authorized.has(String(records[0].segment_id))) return null;
      if (hot.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_REVISIONS_META)) return null;
      const record = records[0];
      const dataVersion = this.readDataVersion();
      const totalChanges = Number(hot.prepare("SELECT total_changes() AS value").get().value);
      const input = JSON.stringify([record, dataVersion, totalChanges]);
      const { withVerifiedHistoryArchiveCandidate } = await import("./history-archive.js");
      return withVerifiedHistoryArchiveCandidate(String(record.database_path), undefined, (database, verified) => {
        assertHistoryArchiveRecordMatches(record, verified);
        const coldSources = historyArchiveSourceIdentities(database, Number(record.start_ms), Number(record.end_ms));
        const sourceCount = Number(database.prepare("SELECT COUNT(DISTINCT source_path) AS n FROM events").get().n);
        if (sourceCount !== coldSources.length) {
          throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "archive source identities are incomplete");
        }
        let uri = pathToFileURL(this.databaseFile).href;
        if (process.platform === "win32") {
          uri = uri.startsWith("file:///")
            ? uri.replace("file:///", "file:////%3F/")
            : uri.replace("file://", "file:////%3F/UNC/");
        }
        database.prepare("ATTACH DATABASE ? AS history_hot").run(`${uri}?mode=ro`);
        // Pin the hot revision only for the synchronous SQL consumer, never across file-hash awaits.
        database.prepare("SELECT value FROM history_hot.store_meta LIMIT 1").get();
        if (this.database !== hot) {
          throw historyArchiveError("HISTORY_ARCHIVE_READ_CLOSED", "usage store closed during archive verification");
        }
        if (
          hot.isTransaction !== false ||
          this.writeTransactionDepth > 0 ||
          this.readDataVersion() !== dataVersion ||
          Number(hot.prepare("SELECT total_changes() AS value").get().value) !== totalChanges
        )
          return null;
        if (
          database
            .prepare("SELECT 1 FROM history_hot.events WHERE timestamp_ms >= ? AND timestamp_ms < ? LIMIT 1")
            .get(record.start_ms, record.end_ms)
        ) {
          throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "authorized archive still has hot facts");
        }
        const liveSource = database.prepare(
          "SELECT path, kind, home_id, home_label, home_path FROM history_hot.source_files WHERE path = ?",
        );
        for (const source of coldSources) {
          const live = liveSource.get(source.path);
          if (!live || JSON.stringify({ ...live }) !== JSON.stringify(source)) {
            throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "live archive source identity changed");
          }
        }
        const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
        const columns = database.prepare("PRAGMA history_hot.table_info(events)").all();
        const shape = (rows) => JSON.stringify(rows.map(({ name, type }) => [name, type]));
        if (shape(columns) !== shape(database.prepare("PRAGMA main.table_info(events)").all())) return null;
        const projection = columns
          .map(({ name }) =>
            name === "project" ? "CASE WHEN cwd = '' THEN 'Unknown cwd' ELSE cwd END AS project" : quote(name),
          )
          .join(",");
        for (const { name } of database
          .prepare(`SELECT name FROM history_hot.sqlite_master WHERE type='table'
          OR (type='view' AND name='usage_quota_projection_observations')`)
          .all()) {
          if (name !== "events" && !String(name).startsWith("sqlite_")) {
            const selection = name === "quota_usage_sources" ? "rowid, *" : "*";
            database.exec(`CREATE TEMP VIEW ${quote(name)} AS SELECT ${selection} FROM history_hot.${quote(name)}`);
          }
        }
        database.exec(
          `CREATE TEMP VIEW events AS SELECT ${projection} FROM history_hot.events UNION ALL SELECT ${projection} FROM main.events`,
        );
        const key = JSON.stringify([input, this.storeRevision, record, this.homes, this.warnings, this.generatedAt]);
        let reader = this.historySqlDashboardCache?.store;
        if (this.historySqlDashboardCache?.key !== key || this.readerEditionContextMatches?.(reader) === false) {
          reader?.close();
          reader = this.createQueryOwner({}, this.editionReadContext?.());
          this.historySqlDashboardCache = { key, store: reader };
        }
        reader.borrowReadDatabase(database);
        reader.databaseFile =
          database
            .prepare("PRAGMA database_list")
            .all()
            .find((row) => row.name === "main")?.file || null;
        reader.homes = structuredClone(this.homes);
        reader.warnings = [...this.warnings];
        reader.generatedAt = this.generatedAt;
        this.applyReaderEditionContext?.(reader, this.editionReadContext());
        reader.quotaSourceEvidence = this.quotaSourceEvidence;
        reader.quotaSourceLookup = null;
        reader.quotaSourceDatabase = null;
        reader.quotaSourceRevision = -1;
        reader.storeRevision = reader.derivedRevision = this.storeRevision;
        reader.summarySnapshotRead = true;
        reader.verifiedHistorySqlRead = true;
        reader.registerReadFunctions();
        try {
          return {
            summary: reader.summarizeInReadTransaction(filters, options),
            metadata: reader.readMetadata(filters.now ? new Date(filters.now) : new Date()),
            periodComparison: reader.readPeriodComparison(periodOptions),
          };
        } catch (error) {
          this.historySqlDashboardCache = null;
          try {
            reader.close();
          } catch {
            // Preserve the query error while releasing the remaining resources.
          }
          throw error;
        } finally {
          reader.releaseReadDatabase();
        }
      });
    }

    capturePreparedViewIdentity() {
      return JSON.stringify([
        this.database.prepare("SELECT revision FROM usage_business_revision WHERE singleton=1").get()?.revision,
        this.database.prepare("PRAGMA data_version").get().data_version,
        this.database.prepare("SELECT total_changes() AS value").get().value,
        this.database
          .prepare(`SELECT key,value FROM store_meta
        WHERE key IN ('generated_at','fingerprint','history_archive_event_authority') ORDER BY key`)
          .all(),
        this.database.prepare("SELECT revision FROM quota_revision WHERE singleton=1").get()?.revision,
      ]);
    }

    prepareUsageRead(filters, options, { summary = false, metadata = false, periods = false } = {}) {
      this.assertSourceRepairsComplete();
      this.syncDerivedRevision();
      if (summary || periods) this.prepareHotRollups();
      if (summary) {
        this.prepareQuotaProjection(filters);
        this.prepareRecordProjection?.(filters);
        this.prepareAllSummaryProjection?.(filters, options);
      }
      if (metadata) this.prepareMetadataProjection();
      this.syncDerivedRevision();
      return { database: this.database, identity: this.capturePreparedViewIdentity() };
    }

    readPreparedDashboard(filters, options, periodOptions) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const prepared = this.prepareUsageRead(filters, options, { summary: true, metadata: true, periods: true });
        this.database.exec("SAVEPOINT dashboard_usage_read");
        const previous = [
          this.summarySnapshotRead,
          this.metadataSnapshotRead,
          this.periodComparisonSnapshotRead,
          this.summaryProjectionTransferableRead,
        ];
        try {
          if (prepared.database !== this.database || prepared.identity !== this.capturePreparedViewIdentity()) continue;
          if (this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META))
            return null;
          this.summarySnapshotRead = this.metadataSnapshotRead = this.periodComparisonSnapshotRead = true;
          this.summaryProjectionTransferableRead = true;
          return {
            summary: this.summarizeInReadTransaction(filters, options),
            metadata: this.readMetadata(filters.now ? new Date(filters.now) : new Date()),
            periodComparison: this.readPeriodComparison(periodOptions),
          };
        } finally {
          [
            this.summarySnapshotRead,
            this.metadataSnapshotRead,
            this.periodComparisonSnapshotRead,
            this.summaryProjectionTransferableRead,
          ] = previous;
          this.database.exec("RELEASE dashboard_usage_read");
        }
      }
      throw Object.assign(new Error("Usage changed while preparing the read view"), {
        code: "USAGE_VIEW_STALE",
        retryable: true,
      });
    }

    /** Build one dashboard from one verified carrier when cold event authority exists.
     * @param {any} [filters]
     * @param {any} [options]
     */
    async dashboardHistory(filters = {}, options = {}) {
      await this.open();
      this.assertSourceRepairsComplete();
      this.syncDerivedRevision();
      const periodOptions = {
        now: filters.now,
        excludeHomes: filters.excludeHomes,
        calendarZone: filters.calendarZone,
        ...this.editionQueryFilters?.(filters),
      };
      const hasAuthority = this.database
        .prepare("SELECT 1 FROM store_meta WHERE key = ?")
        .get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META);
      if (!hasAuthority) {
        const dashboard = this.readPreparedDashboard(filters, options, periodOptions);
        if (dashboard) return dashboard;
      }
      const sqlDashboard = await this.trySqlHistoryDashboard(filters, options, periodOptions);
      if (sqlDashboard) return sqlDashboard;
      const union = await this.historyArchiveEventUnionForRange(undefined, {
        completeHistory: true,
        includeUsageCarrier: true,
        includeMetadataCarrier: true,
      });
      const events = publishedUsageEventsFromUnion(
        union,
        this.historyEventEvidence?.(),
        this.quotaSourceFor.bind(this),
      );
      const homes = union.homes ?? [];
      const report = {
        events,
        homes,
        // Dashboard session counts come from events; no session detail list is consumed.
        sessions: [],
        rateLimitObservations: union.rateLimitObservations ?? [],
      };
      const excluded = new Set((filters.excludeHomes || []).map(String));
      return {
        summary: this.summarizeHistoryReport(report, filters, options),
        metadata: this.metadataFromHistoryEvents(events, union.metadataCarrier, filters.now ?? new Date()),
        periodComparison: summarizePeriodComparison(
          excluded.size ? events.filter((event) => !excluded.has(event.homeId)) : events,
          periodOptions,
        ),
      };
    }

    /**
     * Explicit cold-aware summary. Without an authority marker this pins the
     * marker and synchronous hot summary in one savepoint; with authority it
     * summarizes the verified complete event carrier with the shared algorithm.
     * @param {object} [filters]
     * @param {{ includeDetails?: boolean }} [options]
     */
    async summarizeHistory(filters = {}, options = {}) {
      await this.open();
      this.assertSourceRepairsComplete();
      this.syncDerivedRevision();
      if (
        !this.verifiedHistorySqlRead &&
        !this.database.isTransaction &&
        historyArchiveAuthorizedSegmentIds(this.database).size
      )
        await this.ensureHistoryProjectionTracking();
      this.prepareHotRollups();
      this.prepareQuotaProjection(filters);
      this.prepareRecordProjection?.(filters);
      this.prepareAllSummaryProjection?.(filters, options);
      let hasAuthority = false;
      const previousTransferable = this.summaryProjectionTransferableRead;
      const ownTransaction = !this.database.isTransaction;
      this.database.exec("SAVEPOINT summary_history_read");
      this.summaryProjectionTransferableRead = ownTransaction;
      try {
        hasAuthority = Boolean(
          this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META),
        );
        if (!hasAuthority) {
          this.summarySnapshotRead = true;
          try {
            return this.summarizeInReadTransaction(filters, options);
          } finally {
            this.summarySnapshotRead = false;
          }
        }
      } finally {
        this.summaryProjectionTransferableRead = previousTransferable;
        this.database.exec("RELEASE summary_history_read");
      }

      return this.withSqlHistoryReader((reader) => {
        if (reader.historyPersistentRead) {
          reader.prepareHotRollups();
          reader.prepareQuotaProjection(filters);
          reader.prepareRecordProjection?.(filters);
          reader.prepareAllSummaryProjection?.(filters, options);
        }
        return reader.summarizeInReadTransaction(filters, options);
      });
    }

    borrowReadDatabase(database) {
      if (this.database) throw new Error("A read database is already attached");
      this.database = database;
      this.ownsDatabase = false;
    }

    releaseReadDatabase() {
      if (this.ownsDatabase) throw new Error("The owning store must close its database");
      this.queryReadView?.reader.close();
      this.queryReadView = null;
      this.database = null;
      this.registeredReadDatabase = null;
      this.quotaSourceLookup = null;
      this.quotaSourceDatabase = null;
      this.quotaSourceRevision = -1;
    }

    borrowPeriodComparisonCache(cache) {
      if (this.periodComparisonCache.size) throw new Error("Cannot replace an active period cache");
      this.periodComparisonCache = cache;
      this.ownsPeriodComparisonCache = false;
    }

    close() {
      let closeError = null;
      const release = (action) => {
        try {
          action();
        } catch (error) {
          closeError ??= error;
        }
      };
      release(() => this.clearEditionQueryCaches?.("close"));
      release(() => this.queryReadView?.reader.close());
      this.queryReadView = null;
      release(() => this.sourceProof?.close());
      this.sourceProof = null;
      release(() => this.historyPeriodComparisonCache?.cache.clear());
      this.historyPeriodComparisonCache = null;
      release(() => this.historySqlDashboardCache?.store.close());
      this.historySqlDashboardCache = null;
      release(() => this.historyProjectionStore?.close());
      this.historyProjectionStore = null;
      // D1：派生缓存与写事务深度都是**连接级**状态 ⇒ `close()` 一并复位；`open()` 会把
      // `observedDataVersion` 重新取基准（外部提交检测在重开后**从零**开始计），
      // 而 `storeRevision` 是这个**实例**的单调修订号，跨 `close()/open()` 保留。
      this.metadataCache = null;
      if (this.ownsPeriodComparisonCache) release(() => this.periodComparisonCache.clear());
      // D4：观测聚合缓存同为连接级状态（`storeRevision` 跨 close/open **保留** ⇒ 必须显式复位）。
      // D2：历史冠军 memo 同为连接级状态（且 `storeRevision` 跨 close/open **保留** ⇒ 只靠键
      // 不足以保证"重开后一定重算"，必须显式复位）。
      // D3：quota 观测映射同为连接级状态（`storeRevision` 跨 close/open **保留** ⇒ 必须显式复位）。
      this.quotaObservationCache = null;
      this.quotaSourceLookup = null;
      this.quotaSourceDatabase = null;
      this.quotaSourceRevision = -1;
      release(() => this.summaryProjectionCache?.quoteInputs?.discard());
      this.summaryProjectionCache = null;
      this.usageProjectionTracker = null;
      this.businessProjectionIgnoredChanges = 0;
      this.observedUsageProjectionChanges = "";
      this.publishedFileWarningsView = null;
      this.summaryProjectionTransferableRead = false;
      this.openedUsageProjectionIdentity = null;
      this.openedUsageProjectionChanges = -1;
      // W4-b1 / D1：事件计价 memo 是**实例私有** ⇒ `close()` 一并清空（重开后重新预热一次；
      // 不跨实例）。键里已含内容与价目版本，所以这里同样是内存卫生而非正确性要求。
      this.derivedRevision = this.storeRevision;
      this.writeTransactionDepth = 0;
      const database = this.database;
      this.database = null;
      this.registeredReadDatabase = null;
      if (this.ownsDatabase) release(() => database?.close());
      if (closeError) throw closeError;
    }

    readMetadata(asOf = new Date()) {
      if (!this.metadataSnapshotRead) this.syncDerivedRevision();
      return super.readMetadata(asOf);
    }
    readPeriodComparison(options = {}) {
      if (!this.periodComparisonSnapshotRead) this.syncDerivedRevision();
      return super.readPeriodComparison(options);
    }
    quotaObservations(options = {}) {
      this.syncDerivedRevision();
      return super.quotaObservations(options);
    }
    summarizeInReadTransaction(filters = {}, options = {}) {
      this.syncDerivedRevision();
      return super.summarizeInReadTransaction(filters, options);
    }

    prepareHotRollups() {
      this.ensureQueryTracker();
      return super.prepareHotRollups();
    }
    prepareQuotaProjection(filters) {
      this.ensureQueryTracker();
      return super.prepareQuotaProjection(filters);
    }
    prepareMetadataProjection() {
      this.ensureQueryTracker();
      return super.prepareMetadataProjection();
    }
    ensureQueryTracker() {
      if (
        !this.usageProjectionTracker &&
        !this.verifiedHistorySqlRead &&
        !this.database.isTransaction &&
        !this.writeTransactionDepth &&
        !this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)
      ) {
        this.installUsageProjectionTracker();
        this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
      }
    }

    acquirePublishedHotReader() {
      const snapshot = this.captureUsageProjection?.();
      const database = new DatabaseSync(this.databaseFile, { readOnly: true });
      let reader;
      try {
        database.exec("PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; BEGIN");
        database.prepare("SELECT id FROM events LIMIT 1").get();
        reader = this.createPublishedReader({ ...this.usageReadContext(), database }, this.editionReadContext?.());
        reader.ownsDatabase = true;
        reader.registerReadFunctions();
        this.transferPublishedProjection?.(reader, snapshot);
        return reader;
      } catch (error) {
        if (reader) reader.close();
        else database.close();
        throw error;
      }
    }
  };
}
