import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canShareSummary } from "../public/share-card-data.js";
import { isCharacterSkin } from "../public/skins.js";

const SECRET_KIND = "achievement-operation-signing";
const SECRET_KEY = "v1";
const tokenFields = ["total", "input", "cached", "output", "reasoning"];
const detailFields = [
  ...tokenFields,
  "inputUnavailableTokens",
  "cachedUnavailableTokens",
  "outputUnavailableTokens",
  "reasoningUnavailableTokens",
  "uncachedInput",
  "uncachedInputUnavailableTokens",
  "cacheRateInput",
  "cacheRateCached",
];
const pick = (value, fields) => Object.fromEntries(fields.map((key) => [key, value?.[key] ?? null]));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const sorted = (rows) => rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));

// A content identity uses aggregates actually captured by the card, never prices or the live store revision.
function shareKey(summary, filters) {
  if (!canShareSummary(summary)) throw new TypeError("A server-captured shareable summary is required");
  const range = summary.range;
  const bounds = pick(range, ["preset", "recentValue", "start", "end", "calendarZone", "quotaPreset"]);
  if (range.preset === "all") {
    bounds.start = null;
    bounds.end = null;
  }
  if (range.quotaWindow) bounds.end = range.windowEndExclusive;
  return digest({
    range: bounds,
    excludeHomes: [...new Set(filters?.excludeHomes || [])].sort(),
    totals: pick(summary.totals, tokenFields),
    details: pick(summary.details, detailFields),
    sessionCount: summary.sessionCount ?? null,
    models: sorted(
      (summary.models || []).map((row) => ({ name: row.name || row.key, total: row.total?.total ?? null })),
    ),
    rangeMetrics: {
      ...pick(summary.rangeMetrics, [
        "first",
        "last",
        "activeDays",
        "peakDay",
        "peakHour",
        "maxSessionTokens",
        "repositoryCount",
        "composition",
      ]),
      harnesses: sorted((summary.rangeMetrics?.harnesses || []).map((row) => pick(row, ["name", "total"]))),
    },
    timeline: sorted(
      (summary.timeline || [])
        .filter((row) => row.total?.total > 0)
        .map((row) => ({ key: row.key, total: row.total.total })),
    ),
    previous: summary.comparison?.previousEventCount > 0 ? pick(summary.comparison.previousTotals, tokenFields) : null,
  });
}

function objectFields(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new TypeError("Invalid achievement operation fields");
}

export class AchievementOperationService {
  #archive;
  #clock;

  constructor({ archive, clock = Date.now }) {
    if (!archive || typeof clock !== "function") throw new TypeError("archive and clock are required");
    this.#archive = archive;
    this.#clock = clock;
  }

  #profile() {
    const profile = this.#archive.readProfile();
    if (!profile) throw new Error("Achievement archive is not enabled");
    return profile;
  }

  #secret() {
    this.#profile();
    let evidence = this.#archive.readEvidence(SECRET_KIND).find(({ key }) => key === SECRET_KEY);
    if (!evidence) {
      try {
        this.#archive.putEvidence({ kind: SECRET_KIND, key: SECRET_KEY, value: randomBytes(32).toString("hex") });
      } catch (error) {
        // Another archive connection may have published its key first.
        if (!this.#archive.readEvidence(SECRET_KIND).some(({ key }) => key === SECRET_KEY)) throw error;
      }
      evidence = this.#archive.readEvidence(SECRET_KIND).find(({ key }) => key === SECRET_KEY);
    }
    if (typeof evidence?.value !== "string" || !/^[a-f0-9]{64}$/.test(evidence.value))
      throw new Error("Invalid achievement signing evidence");
    return Buffer.from(evidence.value, "hex");
  }

  #sign(payload) {
    const body = Buffer.from(canonical(payload)).toString("base64url");
    return `${body}.${createHmac("sha256", this.#secret()).update(body).digest("base64url")}`;
  }

  #verify(receipt, kind) {
    if (typeof receipt !== "string" || receipt.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(receipt))
      throw new TypeError("Invalid achievement receipt");
    const [body, signature] = receipt.split(".");
    const expected = createHmac("sha256", this.#secret()).update(body).digest("base64url");
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
      throw new TypeError("Invalid achievement signature");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (
      payload.version !== 1 ||
      payload.kind !== kind ||
      payload.profileId !== this.#profile().profileId ||
      !/^[a-f0-9]{64}$/.test(payload.key)
    )
      throw new TypeError("Invalid achievement receipt binding");
    return payload;
  }

  #now() {
    const at = new Date(this.#clock()).toISOString();
    if (Date.parse(at) < Date.parse(this.#profile().enabledAt))
      throw new RangeError("Operation predates achievement profile");
    return at;
  }

  issueShareReceipt(summary, range = {}) {
    return this.#sign({
      version: 1,
      kind: "share",
      profileId: this.#profile().profileId,
      key: shareKey(summary, range),
    });
  }

  recordBrowserOperation(operation) {
    objectFields(operation, operation?.kind === "share" ? ["kind", "receipt"] : ["kind", "characterId"]);
    if (operation.kind === "share") {
      const { key } = this.#verify(operation.receipt, "share");
      return this.#archive.recordOperation({
        kind: "share",
        key,
        occurredAt: this.#now(),
        payload: { snapshotKey: key },
      });
    }
    if (operation.kind !== "skin" || !isCharacterSkin(operation.characterId))
      throw new TypeError("Only share receipts and valid character skins are accepted");
    return this.#archive.recordOperation({
      kind: "skin",
      key: operation.characterId,
      occurredAt: this.#now(),
      payload: { characterId: operation.characterId },
    });
  }

  // Called only by the local coordinator after the entire restore has been published and verified.
  persistRestoreSuccess({ receiptFile, operationId, packageDigest, target }) {
    if (
      typeof receiptFile !== "string" ||
      !path.isAbsolute(receiptFile) ||
      typeof target !== "string" ||
      !path.isAbsolute(target) ||
      typeof operationId !== "string" ||
      !operationId.trim() ||
      !/^[a-f0-9]{64}$/.test(packageDigest)
    )
      throw new TypeError("Restore success requires explicit paths, operationId and package SHA-256");
    try {
      const existing = this.#readRestoreSuccess(receiptFile);
      if (existing.payload.key !== digest({ operationId, packageDigest, target }))
        throw new Error("Restore receipt already belongs to another operation");
      return existing.receipt;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const payload = {
      version: 1,
      kind: "restore",
      profileId: this.#profile().profileId,
      key: digest({ operationId, packageDigest, target }),
      operationId,
      packageDigest,
      target,
      occurredAt: this.#now(),
    };
    const receipt = this.#sign(payload);
    const temporary = `${receiptFile}.creating-${randomUUID()}`;
    const fd = openSync(temporary, "wx", 0o600);
    let persistedReceipt = receipt;
    let failure;
    try {
      try {
        writeFileSync(fd, JSON.stringify({ receipt }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(temporary, receiptFile);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const winner = this.#readRestoreSuccess(receiptFile);
        if (winner.payload.key !== payload.key) throw new Error("Restore receipt already belongs to another operation");
        persistedReceipt = winner.receipt;
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") failure ??= error;
      }
    }
    if (failure) throw failure;
    return persistedReceipt;
  }

  #readRestoreSuccess(receiptFile) {
    const stat = lstatSync(receiptFile);
    if (!stat.isFile() || stat.size > 32768) throw new TypeError("Invalid local restore receipt file");
    const { receipt } = JSON.parse(readFileSync(receiptFile, "utf8"));
    const payload = this.#verify(receipt, "restore");
    if (
      !Number.isFinite(Date.parse(payload.occurredAt)) ||
      Date.parse(payload.occurredAt) < Date.parse(this.#profile().enabledAt)
    )
      throw new TypeError("Invalid restore success time");
    return { receipt, payload };
  }

  replayRestoreSuccess(receiptFile) {
    const { payload } = this.#readRestoreSuccess(receiptFile);
    const { operationId, packageDigest, target, occurredAt, key } = payload;
    return this.#archive.recordOperation({
      kind: "restore",
      key,
      occurredAt,
      payload: { operationId, packageDigest, target },
    });
  }
}
