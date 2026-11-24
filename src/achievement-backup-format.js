import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { ACHIEVEMENT_FORMAT_CATALOG, supportsAchievementRuleDirectory } from "./achievement-format-descriptor.js";

const COLUMNS = {
  achievement_profile:
    "singleton profileId enabledAt timeZone rulesVersion catalogHash inputKey evaluatedThrough progressRevision awardRevision seenAwardRevision",
  achievement_awards: "id tier earnedAt inputKey rulesVersion catalogHash awardRevision qualifiedAt precision",
  achievement_progress: "id observedValue nextTarget",
  achievement_operations: "kind key occurredAt payload",
  achievement_free_evidence: "kind key value",
  achievement_source_checkpoints: "kind key value",
};

export function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
  return value;
}

export function revision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
  return value;
}

export function instant(value, name) {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isFinite(new Date(ms).getTime()))
    throw new TypeError(`${name} must be a UTC timestamp`);
  // Strings need an explicit offset; parsing must never depend on the machine calendar.
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
    throw new TypeError(`${name} must have a UTC offset`);
  return new Date(ms).toISOString();
}

function decimal(value, name) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
    throw new TypeError(`${name} must be a nonnegative decimal string`);
  return value;
}

export function indexAchievementCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) throw new TypeError("catalog must not be empty");
  const index = new Map();
  for (const { id, tiers } of catalog) {
    text(id, "catalog id");
    if (index.has(id)) throw new TypeError("Duplicate catalog id");
    if (!isDeepStrictEqual(tiers, ["bronze", "silver", "gold"]) && !isDeepStrictEqual(tiers, ["stone"]))
      throw new TypeError("Invalid catalog tiers");
    index.set(id, [...tiers]);
  }
  return index;
}

const FORMAT_CATALOG = indexAchievementCatalog(ACHIEVEMENT_FORMAT_CATALOG);

function checkSchema(database, version) {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    if (version === 1 && table === "achievement_source_checkpoints") continue;
    const info = database.prepare(`PRAGMA table_info(${table})`).all();
    const strict = database.prepare("SELECT strict FROM pragma_table_list WHERE name = ?").get(table)?.strict;
    const expectedKey =
      table === "achievement_profile"
        ? "singleton"
        : table === "achievement_awards"
          ? "id tier"
          : table === "achievement_progress"
            ? "id"
            : table === "achievement_source_checkpoints"
              ? "key"
              : "kind key";
    const primaryKey = info
      .filter((row) => row.pk > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((row) => row.name)
      .join(" ");
    if (strict !== 1 || info.map((row) => row.name).join(" ") !== columns || primaryKey !== expectedKey)
      throw new Error(`Invalid achievement schema: ${table}`);
  }
}

export function readAchievementProfile(database) {
  const row = database.prepare("SELECT * FROM achievement_profile WHERE singleton = 1").get();
  if (!row) throw new Error("Missing achievement profile");
  const { singleton: _singleton, ...profile } = row;
  return { schemaVersion: Number(database.prepare("PRAGMA user_version").get().user_version), ...profile };
}

export function validateAchievementRows(rows, catalog) {
  if (!Array.isArray(rows) || rows.length !== catalog.size)
    throw new TypeError(`rows must contain all ${catalog.size} catalog IDs`);
  const ids = new Set();
  for (const { id, observedValue, nextTarget } of rows) {
    if (!catalog.has(id) || ids.has(id)) throw new TypeError("Unknown or duplicate achievement ID");
    ids.add(id);
    decimal(observedValue, "observedValue");
    if (nextTarget !== null) decimal(nextTarget, "nextTarget");
  }
}

export function validateAchievementAward({ id, tier, qualifiedAt = null, precision = null }, catalog) {
  if (!catalog.get(id)?.includes(tier)) throw new TypeError("Unknown achievement ID or tier");
  if (precision !== null && !["instant", "day", "interval"].includes(precision))
    throw new TypeError("Invalid award precision");
  if (qualifiedAt !== null) {
    if (precision === "day") {
      if (
        typeof qualifiedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(qualifiedAt) ||
        new Date(`${qualifiedAt}T00:00:00Z`).toISOString().slice(0, 10) !== qualifiedAt
      )
        throw new TypeError("qualifiedAt must be a calendar date for day precision");
    } else instant(qualifiedAt, "qualifiedAt");
  }
}

function validateStoredState(database, catalog) {
  if (database.prepare("SELECT COUNT(*) n FROM achievement_profile").get().n !== 1)
    throw new Error("Invalid achievement profile");
  const profile = readAchievementProfile(database);
  text(profile.profileId, "profileId");
  instant(profile.enabledAt, "enabledAt");
  text(profile.rulesVersion, "rulesVersion");
  text(profile.catalogHash, "catalogHash");
  if (profile.timeZone === "local") throw new Error("Invalid stored timeZone");
  new Intl.DateTimeFormat("en", { timeZone: text(profile.timeZone, "timeZone") });
  for (const name of ["progressRevision", "awardRevision", "seenAwardRevision"]) revision(profile[name], name);
  if (profile.seenAwardRevision > profile.awardRevision) throw new Error("Invalid seenAwardRevision");
  const rows = database.prepare("SELECT * FROM achievement_progress").all();
  if (profile.inputKey === null) {
    if (rows.length || profile.evaluatedThrough !== null) throw new Error("Incomplete achievement progress");
  } else {
    text(profile.inputKey, "inputKey");
    instant(profile.evaluatedThrough, "evaluatedThrough");
    validateAchievementRows(rows, catalog);
  }
  for (const award of database.prepare("SELECT * FROM achievement_awards").all()) {
    validateAchievementAward(award, catalog);
    instant(award.earnedAt, "earnedAt");
    revision(award.awardRevision, "awardRevision");
    if (award.awardRevision === 0 || award.awardRevision > profile.awardRevision)
      throw new Error("Invalid award revision");
  }
  return profile;
}

/** Validate a borrowed database without writing, migrating or closing it; catalog is an ID/tier Map. */
export function inspectAchievementDatabase(database, catalog = FORMAT_CATALOG) {
  const version = Number(database.prepare("PRAGMA user_version").get().user_version);
  if (![1, 2].includes(version)) throw new Error("Unsupported achievement schema");
  checkSchema(database, version);
  return validateStoredState(database, catalog);
}

const TABLES = Object.keys(COLUMNS).filter((table) => table !== "achievement_source_checkpoints");
const PROFILE_KEYS = ["schemaVersion", "profileId", "enabledAt", "timeZone", "inputKey"];
const fail = (message) => Object.assign(new Error(message), { code: "ACHIEVEMENT_BACKUP_INVALID" });

export function validateAchievementBackupRecord(record) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    typeof record.filename !== "string" ||
    !record.filename ||
    /[\\/:*?"<>|]/.test(record.filename) ||
    [...record.filename].some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(record.filename) ||
    [".", ".."].includes(record.filename) ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes <= 0 ||
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256)
  )
    throw fail("Invalid achievement sidecar record or adjacent filename");
  if (
    ![1, 2].includes(record.schemaVersion) ||
    typeof record.profileId !== "string" ||
    !record.profileId.trim() ||
    typeof record.enabledAt !== "string" ||
    !Number.isFinite(Date.parse(record.enabledAt)) ||
    new Date(record.enabledAt).toISOString() !== record.enabledAt ||
    typeof record.timeZone !== "string" ||
    !record.timeZone ||
    record.timeZone === "local" ||
    (record.inputKey !== null && (typeof record.inputKey !== "string" || !record.inputKey.trim()))
  )
    throw fail("Invalid achievement profile metadata");
  try {
    new Intl.DateTimeFormat("en", { timeZone: record.timeZone });
  } catch {
    throw fail("Invalid achievement fixed time zone");
  }
}

async function fingerprint(file) {
  const handle = await open(file, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export function inspectAchievementBackup(file) {
  // Opening a WAL database, even read-only, can create -wal/-shm files.
  const handle = openSync(file, "r");
  try {
    const header = Buffer.alloc(64);
    if (
      readSync(handle, header, 0, header.length, 0) === header.length &&
      header.subarray(0, 16).toString() === "SQLite format 3\0" &&
      (header[18] === 2 || header[19] === 2)
    ) {
      if (![1, 2].includes(header.readInt32BE(60))) throw fail("Unsupported achievement schema");
      throw fail("Achievement sidecar must be a standalone SQLite backup");
    }
  } finally {
    closeSync(handle);
  }
  const db = new DatabaseSync(path.toNamespacedPath(file), { readOnly: true });
  try {
    db.exec("BEGIN");
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (![1, 2].includes(schemaVersion)) throw fail("Unsupported achievement schema");
    const checks = db.prepare("PRAGMA quick_check").all();
    if (checks.length !== 1 || checks[0].quick_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length)
      throw fail("Corrupt achievement sidecar");
    if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "delete")
      throw fail("Achievement sidecar must be a standalone SQLite backup");
    for (const table of [...TABLES, ...(schemaVersion >= 2 ? ["achievement_source_checkpoints"] : [])]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
        throw fail(`Missing achievement table: ${table}`);
    }
    const profile = inspectAchievementDatabase(db);
    if (!supportsAchievementRuleDirectory(profile)) throw fail("Unsupported achievement rule directory");
    for (const key of ["progressRevision", "awardRevision", "seenAwardRevision"]) {
      const value = profile[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw fail("Invalid achievement revision");
    }
    if (Number(profile.seenAwardRevision) > Number(profile.awardRevision))
      throw fail("Invalid achievement seen revision");
    return Object.fromEntries(PROFILE_KEYS.map((key) => [key, key === "schemaVersion" ? schemaVersion : profile[key]]));
  } finally {
    db.close();
  }
}

/** Read-only validation never initializes or migrates a profile. */
export async function verifyAchievementBackup(directory, record) {
  validateAchievementBackupRecord(record);
  const file = path.join(directory, record.filename);
  if (!(await lstat(file)).isFile()) throw fail("Achievement sidecar must be an adjacent regular file");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const stats = await lstat(`${file}${suffix}`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (stats) throw fail("Achievement sidecar has external SQLite journal files");
  }
  const actual = await fingerprint(file);
  if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256)
    throw fail("Achievement sidecar digest mismatch");
  const profile = inspectAchievementBackup(file);
  if (PROFILE_KEYS.some((key) => profile[key] !== record[key])) throw fail("Achievement sidecar profile mismatch");
  const after = await fingerprint(file);
  if (after.bytes !== record.bytes || after.sha256 !== record.sha256)
    throw fail("Achievement sidecar changed during verification");
  return { databaseFile: file, profile };
}
