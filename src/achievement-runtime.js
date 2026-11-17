import { createHash } from "node:crypto";
import path from "node:path";
import { closedAchievementPeriods } from "./achievement-calendar.js";
import { AchievementFoundation, achievementDatabaseFile } from "./achievement-foundation.js";
import { AchievementAggregates } from "./achievement-incremental.js";
import { ACHIEVEMENT_IDENTITY_VERSION } from "./achievement-identity.js";
import { streamAchievementHermesEvents as streamHermesDbEvents } from "./achievement-hermes-source.js";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// All metadata is bounded by sources/segments, never by the number of usage events.
function captureInput(store) {
  const db = store.database;
  const revision = Number(db.prepare("SELECT revision FROM usage_business_revision WHERE singleton=1").get().revision);
  const maximum = Number(db.prepare("SELECT COALESCE(MAX(id),0) n FROM events").get().n);
  const sources = db
    .prepare(`SELECT path,kind,home_id,
    CASE WHEN kind='hermes' THEN size ELSE 0 END AS evidence_size,
    CASE WHEN kind='hermes' THEN mtime_ms ELSE 0 END AS evidence_mtime
    FROM source_files ORDER BY path`)
    .all();
  const segments = db.prepare("SELECT * FROM archive_segments ORDER BY segment_id").all();
  const meta = db
    .prepare(`SELECT key,value FROM store_meta WHERE key IN
    ('history_archive_event_authority','history_archive_event_revisions') ORDER BY key`)
    .all();
  return { revision, maximum, sources, structure: digest([segments, meta]) };
}

function compatibleSources(before, after) {
  const current = new Map(after.map((row) => [row.path, JSON.stringify(row)]));
  return before.every((row) => current.get(row.path) === JSON.stringify(row));
}

/** Called only from the executor's existing serial queue; no timers or independent scans. */
export class AchievementRuntime {
  constructor({
    usageStore,
    databaseFile,
    clock = Date.now,
    timeZone,
    policies = [],
    pricingModels = {},
    sourceHomes = [],
  }) {
    this.usageStore = usageStore;
    this.clock = clock;
    this.timeZone = timeZone;
    this.policies = policies;
    this.pricingModels = pricingModels;
    this.sourceHomes = sourceHomes;
    this.foundation = new AchievementFoundation({ usageStore, databaseFile, clock });
    this.state = null;
    this.tail = Promise.resolve();
    this.diagnostics = null;
  }

  get archive() {
    return this.foundation.archive;
  }

  get databaseFile() {
    return this.foundation.databaseFile || achievementDatabaseFile(this.usageStore.databaseFile);
  }

  start() {
    const work = this.tail.then(async () => {
      if (this.archive) return this.readSnapshot();
      const profile = this.foundation.open({
        enabledAt: this.clock(),
        ...(this.timeZone ? { timeZone: this.timeZone } : {}),
      });
      let baselineRows = 0;
      const evidenceWarnings = [];
      if (profile.inputKey === null && !Object.keys(this.archive.readCheckpoints()).length) {
        const checkpoints = [];
        const sources = new Map();
        for (const source of [
          ...this.usageStore.database.prepare("SELECT * FROM source_files WHERE kind='hermes'").all(),
          ...this.sourceHomes
            .filter((home) => home.kind === "hermes")
            .map((home) => ({
              path: path.join(home.path, "state.db"),
              home_id: home.id,
              home_label: home.label || home.id,
              home_path: home.path,
            })),
        ]) {
          const sourcePath = path.resolve(String(source.path));
          const key = JSON.stringify([
            String(source.home_id),
            process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath,
          ]);
          if (!sources.has(key)) sources.set(key, source);
        }
        for (const source of sources.values()) {
          try {
            await streamHermesDbEvents(
              String(source.path),
              {
                id: String(source.home_id),
                label: String(source.home_label),
                path: String(source.home_path),
              },
              (event) => {
                baselineRows++;
                const evidence = event.achievementEvidence;
                const enabledAt = Date.parse(profile.enabledAt);
                const observedAt = evidence.timestampMs <= enabledAt ? enabledAt : this.clock();
                if (evidence.timestampMs > observedAt) return;
                checkpoints.push({
                  kind: "hermes-cumulative",
                  key: event.sourceEventId,
                  value: {
                    key: event.sourceEventId,
                    sourceEventId: event.sourceEventId,
                    homeId: String(source.home_id),
                    sourcePath: String(source.path),
                    enabledAt,
                    total: evidence.totalTokens,
                    timestampMs: evidence.timestampMs,
                    observedAt,
                    cutoff: observedAt,
                    coverage: evidence.coverage,
                    credited: "0",
                    creditedCoverage: null,
                    segments: [],
                  },
                });
              },
              {},
            );
          } catch (error) {
            evidenceWarnings.push({ source: String(source.path), code: error.code || "SOURCE_EVIDENCE_UNAVAILABLE" });
          }
        }
        this.archive.saveCheckpoints(checkpoints);
      }
      this.diagnostics = { mode: "start", processedRows: 0, baselineRows, evidenceWarnings };
      return this.readSnapshot();
    });
    this.tail = work.catch(() => {});
    return work;
  }

  update({ pricingModels = this.pricingModels } = {}) {
    const work = this.tail.then(async () => {
      for (let retries = 0; ; retries++) {
        try {
          const snapshot = await this.updateInput(pricingModels);
          this.diagnostics.captureRetries = retries;
          return snapshot;
        } catch (error) {
          if (error.code !== "ACHIEVEMENT_SOURCE_CHANGED" || retries === 2) throw error;
        }
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }

  async updateInput(pricingModels) {
    if (!this.archive) throw new Error("Achievement runtime must start before update");
    const started = performance.now();
    const cutoff = this.clock();
    if (!Number.isSafeInteger(cutoff) || cutoff < Date.parse(this.archive.readProfile().enabledAt))
      throw new TypeError("Invalid achievement runtime cutoff");
    const before = captureInput(this.usageStore);
    const profile = this.archive.readProfile();
    const operations = this.archive.readOperations().filter(({ occurredAt }) => {
      const at = typeof occurredAt === "number" ? occurredAt : Date.parse(occurredAt);
      return at >= Date.parse(profile.enabledAt) && at < cutoff;
    });
    const calendar = closedAchievementPeriods(cutoff, profile.timeZone);
    // The shared identity adapter uses catalog keys; mutable quote values are not facts.
    const configuration = digest([
      Object.keys(pricingModels)
        .map((key) => key.toLowerCase())
        .sort(),
      this.policies,
    ]);
    const key = digest([
      "achievement-runtime-1",
      before,
      configuration,
      operations,
      calendar,
      ACHIEVEMENT_IDENTITY_VERSION,
      profile.rulesVersion,
      profile.catalogHash,
    ]);
    const previous = this.state;
    const diagnostics = {
      mode: "skip",
      reason: "unchanged",
      processedRows: 0,
      appendedFacts: 0,
      cumulativeBuckets: previous?.aggregates.cumulative.size || 0,
      calendarBuckets: previous?.aggregates.calendar.size || 0,
      evaluatedBuckets: 0,
      evidenceWarnings: [],
      readMode: null,
      elapsedMs: 0,
      heapDeltaBytes: 0,
      captureRetries: 0,
      pendingCatchUp: false,
    };
    const heapBefore = process.memoryUsage().heapUsed;
    this.diagnostics = diagnostics;
    const pendingDue = previous?.nextTimestamp !== null && previous?.nextTimestamp < cutoff;
    if (previous && previous.key === key && !pendingDue) {
      diagnostics.elapsedMs = performance.now() - started;
      return this.readSnapshot();
    }
    let aggregates = previous?.aggregates;
    let reason = !previous
      ? "initial-or-reopen"
      : configuration !== previous.configuration
        ? "identity-or-policy"
        : before.structure !== previous.input.structure
          ? "cold-structure"
          : !compatibleSources(previous.input.sources, before.sources)
            ? "source-evidence-or-identity"
            : pendingDue
              ? "deferred-cutoff"
              : null;
    let since;
    let nextTimestamp = previous?.nextTimestamp ?? null;
    let visibility = previous?.visibility ?? null;
    let completedKey;
    if (!reason && before.revision !== previous.input.revision) {
      const delta = this.usageStore.database
        .prepare(`SELECT COUNT(*) n,MIN(timestamp_ms) earliest,
        SUM(CASE WHEN sf.kind='hermes' THEN 1 ELSE 0 END) cumulative
        FROM events e LEFT JOIN source_files sf ON sf.path=e.source_path WHERE e.id>?`)
        .get(previous.input.maximum);
      if (before.revision - previous.input.revision !== Number(delta.n)) reason = "revision-or-deletion";
      else if (Number(delta.cumulative)) reason = "cumulative-source";
      else if (delta.earliest !== null && Number(delta.earliest) < previous.cutoff) reason = "late-append";
      else since = previous.cutoff;
    }
    try {
      if (reason || since !== undefined) {
        const input = await this.foundation.prepare({
          cutoff,
          pricingModels,
          policies: this.policies,
          ...(reason ? {} : { since }),
        });
        const liveAdvanced = digest(captureInput(this.usageStore)) !== digest(before);
        // A tail needs its append proof; a complete pinned reader may finish its coherent older version.
        if (liveAdvanced && !reason)
          throw Object.assign(new Error("Achievement source changed during capture"), {
            code: "ACHIEVEMENT_SOURCE_CHANGED",
          });
        if (reason) aggregates = new AchievementAggregates(profile.timeZone);
        aggregates.append(input.facts);
        diagnostics.processedRows = input.processedRows;
        diagnostics.appendedFacts = input.facts.length;
        diagnostics.evidenceWarnings = input.evidenceWarnings;
        diagnostics.readMode = input.readMode;
        nextTimestamp = input.nextTimestamp;
        visibility = reason
          ? input.visibleThrough
          : Math.max(visibility ?? -Infinity, input.visibleThrough ?? -Infinity);
        if (liveAdvanced) {
          diagnostics.pendingCatchUp = true;
          completedKey = digest(["captured-input", input.inputKey, configuration, operations, calendar]);
        }
      }
      diagnostics.mode = reason ? "rebuild" : since !== undefined ? "append" : "settle";
      diagnostics.reason = reason || (since !== undefined ? "proven-append" : "calendar-or-operation");
      diagnostics.cumulativeBuckets = aggregates.cumulative.size;
      diagnostics.calendarBuckets = aggregates.calendar.size;
      diagnostics.evaluatedBuckets = aggregates.cumulative.size + aggregates.calendar.size;
      const result = aggregates.evaluate(
        { profile, cutoff, operations, inputKey: completedKey || digest([key, visibility]) },
        this.readSnapshot().awards,
      );
      const snapshot = this.archive.commitBatch({ ...result, expectedProgressRevision: profile.progressRevision });
      this.state = diagnostics.pendingCatchUp
        ? null
        : { aggregates, key, configuration, input: before, cutoff, nextTimestamp, visibility };
      this.pricingModels = pricingModels;
      return snapshot;
    } catch (error) {
      // An interrupted aggregate update is disposable; durable awards/progress remain the previous complete batch.
      this.state = null;
      diagnostics.mode = "error";
      diagnostics.reason = error.code || error.message;
      throw error;
    } finally {
      diagnostics.elapsedMs = performance.now() - started;
      diagnostics.heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
    }
  }

  readSnapshot() {
    return this.archive?.readSnapshot() || null;
  }

  close() {
    this.foundation.close();
    this.state = null;
  }
}
