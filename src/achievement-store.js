import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  text,
  revision,
  instant,
  indexAchievementCatalog,
  inspectAchievementDatabase,
  readAchievementProfile,
  validateAchievementRows,
  validateAchievementAward,
} from "./achievement-backup-format.js";
import {
  ACHIEVEMENT_FORMAT_CATALOG_HASH,
  ACHIEVEMENT_FORMAT_RULES_VERSION,
  supportsAchievementRuleDirectory,
} from "./achievement-format-descriptor.js";

const SCHEMA_VERSION = 2;
const BASE_SCHEMA = `
  CREATE TABLE achievement_profile (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    profileId TEXT NOT NULL, enabledAt TEXT NOT NULL, timeZone TEXT NOT NULL,
    rulesVersion TEXT NOT NULL, catalogHash TEXT NOT NULL,
    inputKey TEXT, evaluatedThrough TEXT,
    progressRevision INTEGER NOT NULL CHECK (progressRevision >= 0),
    awardRevision INTEGER NOT NULL CHECK (awardRevision >= 0),
    seenAwardRevision INTEGER NOT NULL CHECK (seenAwardRevision BETWEEN 0 AND awardRevision)
  ) STRICT;
  CREATE TABLE achievement_awards (
    id TEXT NOT NULL, tier TEXT NOT NULL, earnedAt TEXT NOT NULL,
    inputKey TEXT NOT NULL, rulesVersion TEXT NOT NULL, catalogHash TEXT NOT NULL,
    awardRevision INTEGER NOT NULL, qualifiedAt TEXT, precision TEXT,
    PRIMARY KEY (id, tier)
  ) STRICT;
  CREATE TABLE achievement_progress (
    id TEXT PRIMARY KEY NOT NULL, observedValue TEXT NOT NULL, nextTarget TEXT
  ) STRICT;
  CREATE TABLE achievement_operations (
    kind TEXT NOT NULL, key TEXT NOT NULL, occurredAt TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (kind, key)
  ) STRICT;
  CREATE TABLE achievement_free_evidence (
    kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (kind, key)
  ) STRICT;
`;
const CHECKPOINT_SCHEMA = `
  CREATE TABLE achievement_source_checkpoints (
    kind TEXT NOT NULL, key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL
  ) STRICT;
`;

function json(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || !isDeepStrictEqual(JSON.parse(encoded), value))
    throw new TypeError("Evidence and payload must be JSON data");
  return encoded;
}

function evidenceRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError("sourceCheckpoints must be an array");
  const keys = new Set();
  return rows.map(({ kind, key, value }) => {
    text(kind, "kind");
    text(key, "key");
    if (keys.has(key)) throw new TypeError("Duplicate checkpoint key");
    keys.add(key);
    return { kind, key, value: json(value) };
  });
}

export class AchievementStore {
  /** Validate a borrowed read-only database without migrating, initializing or closing it. */
  static inspect(database, catalog) {
    return inspectAchievementDatabase(database, indexAchievementCatalog(catalog));
  }

  #database = null;
  #databaseFile;
  #catalog;
  #clock;
  #fault;

  constructor({ databaseFile, catalog, clock = Date.now, fault = undefined }) {
    this.#databaseFile = text(databaseFile, "databaseFile");
    if (databaseFile !== databaseFile.trim() || (databaseFile.startsWith(":") && databaseFile !== ":memory:"))
      throw new TypeError("Use an explicit database filename or :memory:");
    this.#catalog = indexAchievementCatalog(catalog);
    if (typeof clock !== "function" || (fault !== undefined && typeof fault !== "function"))
      throw new TypeError("clock and fault must be functions");
    this.#clock = clock;
    this.#fault = fault;
  }

  #requireOpen() {
    if (!this.#database) throw new Error("AchievementStore is not open");
    return this.#database;
  }

  #transaction(work) {
    const database = this.#requireOpen();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#fault?.("beforeCommit");
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  open(options = {}) {
    if (this.#database) return this.readProfile();
    const existing = this.#databaseFile !== ":memory:" && existsSync(this.#databaseFile);
    let initial;
    if (!existing) {
      const { enabledAt, timeZone, rulesVersion, catalogHash, profileId = randomUUID() } = options;
      text(timeZone, "timeZone");
      if (timeZone === "local") throw new TypeError("timeZone must be a fixed IANA name");
      new Intl.DateTimeFormat("en", { timeZone });
      initial = [
        text(profileId, "profileId"),
        instant(enabledAt, "enabledAt"),
        timeZone,
        text(rulesVersion, "rulesVersion"),
        text(catalogHash, "catalogHash"),
      ];
    }
    const temporary =
      !existing && this.#databaseFile !== ":memory:" ? `${this.#databaseFile}.creating-${randomUUID()}` : null;
    if (temporary) mkdirSync(path.dirname(this.#databaseFile), { recursive: true });
    const database = new DatabaseSync(temporary || this.#databaseFile);
    this.#database = database;
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      const version = Number(database.prepare("PRAGMA user_version").get().user_version);
      if (version > SCHEMA_VERSION) throw new Error(`Unsupported future achievement schema: ${version}`);
      if (database.prepare("PRAGMA quick_check").get().quick_check !== "ok")
        throw new Error("Corrupt achievement database");
      if (existing && version === 0) throw new Error("Unrecognized achievement schema");
      if (version > 0) {
        inspectAchievementDatabase(database, this.#catalog);
      }
      if (version < SCHEMA_VERSION) {
        this.#transaction(() => {
          if (version === 0) {
            database.exec(BASE_SCHEMA);
            database
              .prepare(`INSERT INTO achievement_profile VALUES (1, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 0)`)
              .run(...initial);
          }
          database.exec(CHECKPOINT_SCHEMA);
          database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
          this.#fault?.("afterSchema");
        });
      }
      if (temporary) {
        this.close();
        // Publish only a committed profile; an interrupted first launch must not leave an empty final DB.
        linkSync(temporary, this.#databaseFile);
        unlinkSync(temporary);
        this.#database = new DatabaseSync(this.#databaseFile);
        this.#database.exec("PRAGMA busy_timeout = 5000");
      }
      return this.readProfile();
    } catch (error) {
      this.close();
      if (temporary && existsSync(temporary)) unlinkSync(temporary);
      if (temporary && error.code === "EEXIST") return this.open(options);
      throw error;
    }
  }

  readProfile() {
    return this.#database ? readAchievementProfile(this.#database) : null;
  }

  readSnapshot() {
    if (!this.#database) return null;
    // One read transaction also keeps snapshots coherent with other store connections.
    this.#database.exec("BEGIN");
    try {
      const profile = this.readProfile();
      const awards = this.#database.prepare("SELECT * FROM achievement_awards ORDER BY id, awardRevision, tier").all();
      const progress = new Map(
        this.#database
          .prepare("SELECT * FROM achievement_progress")
          .all()
          .map((row) => [row.id, row]),
      );
      const rows =
        profile.inputKey === null
          ? null
          : [...this.#catalog].map(([id, tiers]) => {
              const earned = awards.filter((award) => award.id === id);
              const highestEarned = tiers.findLast((tier) => earned.some((award) => award.tier === tier)) ?? null;
              const earnedAt = Object.fromEntries(
                tiers.map((tier) => [tier, earned.find((a) => a.tier === tier)?.earnedAt ?? null]),
              );
              const updatedAt = earned.at(-1)?.earnedAt ?? null;
              return { ...progress.get(id), highestEarned, earnedAt, updatedAt };
            });
      this.#database.exec("COMMIT");
      return {
        ...profile,
        state: rows === null ? "preparing" : "ready",
        rows,
        awards: awards.map((row) => ({ ...row })),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  commitBatch({
    inputKey,
    evaluatedThrough,
    rows,
    awards = [],
    sourceCheckpoints = [],
    expectedProgressRevision,
    useCurrentRules = false,
  }) {
    const database = this.#requireOpen();
    text(inputKey, "inputKey");
    const through = instant(evaluatedThrough, "evaluatedThrough");
    validateAchievementRows(rows, this.#catalog);
    if (!Array.isArray(awards)) throw new TypeError("awards must be an array");
    for (const award of awards) validateAchievementAward(award, this.#catalog);
    const checkpoints = evidenceRows(sourceCheckpoints);
    if (expectedProgressRevision !== undefined) revision(expectedProgressRevision, "expectedProgressRevision");
    this.#transaction(() => {
      const profile = this.readProfile();
      if (useCurrentRules && !supportsAchievementRuleDirectory(profile))
        throw new Error("Unsupported achievement rule directory");
      const rulesVersion = useCurrentRules ? ACHIEVEMENT_FORMAT_RULES_VERSION : profile.rulesVersion;
      const catalogHash = useCurrentRules ? ACHIEVEMENT_FORMAT_CATALOG_HASH : profile.catalogHash;
      if (profile.inputKey === inputKey && profile.rulesVersion === rulesVersion) return;
      // Opaque input keys are not ordered; a caller must prove which revision it evaluated.
      if (
        (expectedProgressRevision === undefined && profile.progressRevision !== 0) ||
        (expectedProgressRevision !== undefined && expectedProgressRevision !== profile.progressRevision)
      )
        throw new Error("Stale progress revision: expectedProgressRevision is required to replace progress");
      revision(profile.progressRevision + 1, "progressRevision");
      database.exec("DELETE FROM achievement_progress");
      const progress = database.prepare("INSERT INTO achievement_progress VALUES (?, ?, ?)");
      for (const row of rows) progress.run(row.id, row.observedValue, row.nextTarget);
      this.#fault?.("afterProgress");
      const pending = awards.filter(
        ({ id, tier }) => !database.prepare("SELECT 1 FROM achievement_awards WHERE id = ? AND tier = ?").get(id, tier),
      );
      let awardRevision = profile.awardRevision;
      if (pending.length) {
        awardRevision = revision(awardRevision + 1, "awardRevision");
        const earnedAt = instant(this.#clock(), "clock");
        const insert = database.prepare("INSERT OR IGNORE INTO achievement_awards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const { id, tier, qualifiedAt = null, precision = null } of pending) {
          const qualified =
            qualifiedAt === null || precision === "day" ? qualifiedAt : instant(qualifiedAt, "qualifiedAt");
          insert.run(id, tier, earnedAt, inputKey, rulesVersion, catalogHash, awardRevision, qualified, precision);
        }
      }
      this.#fault?.("afterAwards");
      this.#writeCheckpoints(checkpoints);
      this.#fault?.("afterCheckpoints");
      database
        .prepare(`UPDATE achievement_profile SET inputKey = ?, evaluatedThrough = ?, rulesVersion = ?, catalogHash = ?,
        progressRevision = progressRevision + 1, awardRevision = ? WHERE singleton = 1`)
        .run(inputKey, through, rulesVersion, catalogHash, awardRevision);
    });
    return this.readSnapshot();
  }

  recordOperation({ kind, key, occurredAt, payload }) {
    const database = this.#requireOpen();
    text(kind, "kind");
    text(key, "key");
    const at = instant(occurredAt, "occurredAt");
    const encoded = json(payload);
    return this.#transaction(
      () =>
        database.prepare("INSERT OR IGNORE INTO achievement_operations VALUES (?, ?, ?, ?)").run(kind, key, at, encoded)
          .changes > 0,
    );
  }

  readOperations() {
    if (!this.#database) return [];
    return this.#database
      .prepare("SELECT kind, key, occurredAt, payload FROM achievement_operations ORDER BY rowid")
      .all()
      .map((row) => ({ kind: row.kind, key: row.key, occurredAt: row.occurredAt, payload: JSON.parse(row.payload) }));
  }

  putEvidence({ kind, key, value }) {
    const database = this.#requireOpen();
    text(kind, "kind");
    text(key, "key");
    const encoded = json(value);
    return this.#transaction(() => {
      const previous = database
        .prepare("SELECT value FROM achievement_free_evidence WHERE kind = ? AND key = ?")
        .get(kind, key);
      if (previous) {
        if (!isDeepStrictEqual(JSON.parse(previous.value), value)) throw new Error("Immutable evidence conflict");
        return false;
      }
      database.prepare("INSERT INTO achievement_free_evidence VALUES (?, ?, ?)").run(kind, key, encoded);
      return true;
    });
  }

  readEvidence(kind) {
    text(kind, "kind");
    if (!this.#database) return [];
    return this.#database
      .prepare("SELECT * FROM achievement_free_evidence WHERE kind = ? ORDER BY key")
      .all(kind)
      .map((row) => ({ kind: row.kind, key: row.key, value: JSON.parse(row.value) }));
  }

  readCheckpoints() {
    if (!this.#database) return {};
    return Object.fromEntries(
      this.#database
        .prepare("SELECT key, value FROM achievement_source_checkpoints ORDER BY key")
        .all()
        .map((row) => [row.key, JSON.parse(row.value)]),
    );
  }

  #writeCheckpoints(checkpoints) {
    const checkpoint = this.#requireOpen().prepare(`INSERT INTO achievement_source_checkpoints VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, value = excluded.value`);
    for (const row of checkpoints) checkpoint.run(row.kind, row.key, row.value);
  }

  saveCheckpoints(checkpoints, { expected = undefined } = {}) {
    this.#requireOpen();
    const rows = evidenceRows(checkpoints);
    this.#transaction(() => {
      if (expected !== undefined && !isDeepStrictEqual(this.readCheckpoints(), expected))
        throw new Error("Stale achievement source checkpoints");
      this.#writeCheckpoints(rows);
      this.#fault?.("afterCheckpoints");
    });
  }

  markSeen(seenThroughRevision) {
    const database = this.#requireOpen();
    revision(seenThroughRevision, "seenThroughRevision");
    return this.#transaction(() => {
      const profile = this.readProfile();
      if (seenThroughRevision > profile.awardRevision) throw new RangeError("Cannot mark a future award revision seen");
      const seen = Math.max(profile.seenAwardRevision, seenThroughRevision);
      database.prepare("UPDATE achievement_profile SET seenAwardRevision = ? WHERE singleton = 1").run(seen);
      return seen;
    });
  }

  clearProgress() {
    const database = this.#requireOpen();
    this.#transaction(() => {
      revision(this.readProfile().progressRevision + 1, "progressRevision");
      database.exec(`DELETE FROM achievement_progress;
        UPDATE achievement_profile SET inputKey = NULL, evaluatedThrough = NULL,
          progressRevision = progressRevision + 1 WHERE singleton = 1`);
    });
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }
}
