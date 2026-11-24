import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rm, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { ACHIEVEMENT_CATALOG } from "./achievement-catalog.js";
import { supportsAchievementRuleDirectory } from "./achievement-format-descriptor.js";
import { AchievementStore } from "./achievement-store.js";

const TABLES = [
  "achievement_profile",
  "achievement_awards",
  "achievement_progress",
  "achievement_operations",
  "achievement_free_evidence",
];
const PROFILE_KEYS = ["schemaVersion", "profileId", "enabledAt", "timeZone", "inputKey"];
const fail = (message) => Object.assign(new Error(message), { code: "ACHIEVEMENT_BACKUP_INVALID" });

/** Hold the profile writer lock across the caller's usage and read-only sidecar backups. */
export async function withAchievementBackupLock(archiveFile, work) {
  if (typeof archiveFile !== "string" || !archiveFile.trim() || archiveFile.startsWith(":"))
    throw fail("Achievement backup lock requires an existing database file");
  if (typeof work !== "function") throw new TypeError("Achievement backup lock requires a callback");
  const file = path.resolve(archiveFile);
  if (!(await lstat(file)).isFile()) throw fail("Achievement archive must be a regular file");
  const database = new DatabaseSync(path.toNamespacedPath(file));
  try {
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    return await work();
  } finally {
    try {
      if (database.isTransaction) database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
}

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

function inspect(file) {
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
    const profile = AchievementStore.inspect(db, ACHIEVEMENT_CATALOG);
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
  const profile = inspect(file);
  if (PROFILE_KEYS.some((key) => profile[key] !== record[key])) throw fail("Achievement sidecar profile mismatch");
  const after = await fingerprint(file);
  if (after.bytes !== record.bytes || after.sha256 !== record.sha256)
    throw fail("Achievement sidecar changed during verification");
  return { databaseFile: file, profile };
}

/** Caller holds the usage/achievement writer barrier while both SQLite backups are taken. */
export async function createAchievementBackup(databaseFile, destinationFile) {
  if (typeof databaseFile !== "string" || !databaseFile.trim() || databaseFile.startsWith(":"))
    throw fail("Achievement backup requires an existing database file");
  const destination = path.resolve(destinationFile);
  const temporary = `${destination}.creating-${randomUUID()}`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    const source = new DatabaseSync(path.toNamespacedPath(path.resolve(databaseFile)), { readOnly: true });
    try {
      await backup(source, path.toNamespacedPath(temporary));
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(path.toNamespacedPath(temporary));
    try {
      copy.exec("PRAGMA journal_mode = DELETE");
    } finally {
      copy.close();
    }
    const record = { filename: path.basename(destination), ...(await fingerprint(temporary)), ...inspect(temporary) };
    validateAchievementBackupRecord(record);
    await link(temporary, destination);
    return record;
  } finally {
    await Promise.all(
      [temporary, `${temporary}-wal`, `${temporary}-shm`, `${temporary}-journal`].map((file) =>
        rm(file, { force: true }),
      ),
    );
  }
}

/** Exclusively publish a byte-identical, re-verified profile to a new path. */
export async function copyAchievementBackup(directory, record, destinationFile) {
  const verified = await verifyAchievementBackup(directory, record);
  const destination = path.resolve(destinationFile);
  const temporary = `${destination}.restoring-${randomUUID()}`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await copyFile(verified.databaseFile, temporary, constants.COPYFILE_EXCL);
    await verifyAchievementBackup(path.dirname(temporary), { ...record, filename: path.basename(temporary) });
    await link(temporary, destination);
    return { achievementDatabaseFile: destination, profile: verified.profile };
  } finally {
    await rm(temporary, { force: true });
  }
}
