import { createHash } from "node:crypto";
import path from "node:path";
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } from "./achievement-catalog.js";
import { closedAchievementPeriods, validateAchievementTimeZone } from "./achievement-calendar.js";
import { readAchievementFacts } from "./achievement-facts.js";
import { createAchievementFreeClassifier, validateAchievementFreePolicies } from "./achievement-free-policy.js";
import { ACHIEVEMENT_IDENTITY_VERSION, createAchievementIdentity } from "./achievement-identity.js";
import { AchievementStore } from "./achievement-store.js";
import { streamAchievementHermesEvents as streamHermesDbEvents } from "./achievement-hermes-source.js";
import { createCommonRepositoryResolver } from "./repository-identity.js";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const catalogHash = digest(ACHIEVEMENT_CATALOG);
export const ACHIEVEMENT_USAGE_START = 0;

export function achievementDatabaseFile(usageDatabaseFile) {
  if (!usageDatabaseFile || usageDatabaseFile === ":memory:")
    throw new TypeError("An isolated achievement database must be provided for in-memory usage");
  const absolute = path.resolve(usageDatabaseFile);
  return path.join(
    path.dirname(absolute),
    path.basename(absolute) === "usage-index.sqlite"
      ? "achievements.sqlite"
      : `${path.basename(absolute)}.achievements.sqlite`,
  );
}

/** Explicit Waifu preparation only. Constructing a reader or opening a dialog never calls this. */
export class AchievementFoundation {
  constructor({ usageStore, databaseFile, clock = Date.now, readOnlyContext = false }) {
    this.usageStore = usageStore;
    this.clock = clock;
    this.databaseFile = databaseFile;
    this.readOnlyContext = readOnlyContext;
    this.archive = null;
    this.tail = Promise.resolve();
  }

  open({ enabledAt = this.clock(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    if (this.readOnlyContext)
      throw Object.assign(new Error("Frozen or imported readers cannot initialize achievements"), {
        code: "ACHIEVEMENT_READ_ONLY_CONTEXT",
      });
    if (this.archive) return this.archive.readProfile();
    validateAchievementTimeZone(timeZone);
    const archive = new AchievementStore({
      databaseFile: this.databaseFile || achievementDatabaseFile(this.usageStore.databaseFile),
      catalog: ACHIEVEMENT_CATALOG,
      clock: this.clock,
    });
    try {
      archive.open({ enabledAt, timeZone, rulesVersion: ACHIEVEMENT_RULES_VERSION, catalogHash });
      this.archive = archive;
      return archive.readProfile();
    } catch (error) {
      archive.close();
      throw error;
    }
  }

  prepare(options = {}) {
    const work = this.tail.then(() => this.prepareInput(options));
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }

  async prepareInput({
    cutoff = this.clock(),
    policies = [],
    pricingModels = {},
    since = undefined,
    ...initialization
  } = {}) {
    if (!Number.isSafeInteger(cutoff)) throw new TypeError("Invalid achievement cutoff");
    const profile = this.open(initialization);
    const archive = this.archive;
    const existingPolicies = archive.readEvidence("free-policy");
    const normalizedPolicies = validateAchievementFreePolicies([
      ...existingPolicies.map(({ value }) => value),
      ...policies,
    ]);
    const policyMap = new Map(
      normalizedPolicies.map((policy) => [JSON.stringify([policy.evidenceKey, policy.version]), policy]),
    );
    const configuredPolicies = [...policyMap.values()].filter(
      (policy) => !policy.evidenceKey.startsWith("explicit-free:"),
    );
    const configuredClassifier = createAchievementFreeClassifier({ policies: configuredPolicies });
    const explicitByIdentity = new Map();
    for (const policy of policyMap.values()) {
      if (!policy.evidenceKey.startsWith("explicit-free:")) continue;
      const key = JSON.stringify([policy.sourceKind, policy.model, policy.route]);
      if (!explicitByIdentity.has(key)) explicitByIdentity.set(key, []);
      explicitByIdentity.get(key).push(policy);
    }
    for (const list of explicitByIdentity.values())
      list.sort((a, b) => a.validFrom - b.validFrom || b.validUntil - a.validUntil);
    const explicitPolicies = new Map();
    const pendingPolicies = new Map();
    const evidenceKey = (policy) => JSON.stringify([JSON.stringify([policy.evidenceKey, policy.version])]);
    const classifyFree = (event) => {
      const classified = configuredClassifier(event);
      if (classified.freeClass === "review" || classified.freeClass === "free") return classified;
      const raw = String(event.rawModel).trim();
      const model = raw.slice(raw.lastIndexOf("/") + 1).toLowerCase();
      if (model !== "hy4free" && !/^[a-z0-9][a-z0-9._-]*-free$/.test(model)) return classified;
      const route = raw.includes("/") ? raw.slice(0, raw.lastIndexOf("/")) : "";
      const groupKey = JSON.stringify([event.sourceKind, model, route]);
      const previous = explicitByIdentity.get(groupKey) || [];
      let low = 0,
        high = previous.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (previous[middle].validFrom <= event.coverage.start) low = middle + 1;
        else high = middle;
      }
      let policy;
      for (let i = low - 1; i >= 0; i--) {
        if (previous[i].validUntil > event.coverage.end) {
          policy = previous[i];
          break;
        }
      }
      /** @type {import("./achievement-free-policy.js").AchievementFreePolicy} */
      const value = {
        evidenceKey: `explicit-free:${digest([event.sourceKind, raw, event.coverage])}`,
        version: "1",
        validFrom: event.coverage.start,
        validUntil: event.coverage.end + 1,
        sourceKind: event.sourceKind,
        model: raw,
        route,
        freeClass: "free",
        type: "explicit-free-identity",
      };
      const reused = Boolean(policy);
      if (!policy) [policy] = validateAchievementFreePolicies([value]);
      if (
        configuredPolicies.length &&
        createAchievementFreeClassifier({ policies: [...configuredPolicies, policy] })(event).freeClass !== "free"
      )
        return { freeClass: "unknown", freeEvidenceKey: null };
      if (reused) return { freeClass: "free", freeEvidenceKey: evidenceKey(policy) };
      const pendingKey = `pending-explicit:${groupKey}`;
      const pending = pendingPolicies.get(pendingKey);
      pendingPolicies.set(pendingKey, {
        ...policy,
        validFrom: Math.min(pending?.validFrom ?? policy.validFrom, policy.validFrom),
        validUntil: Math.max(pending?.validUntil ?? policy.validUntil, policy.validUntil),
      });
      return { freeClass: "free", freeEvidenceKey: pendingKey };
    };
    for (const value of validateAchievementFreePolicies(policies))
      archive.putEvidence({ kind: "free-policy", key: JSON.stringify([value.evidenceKey, value.version]), value });
    const aliases = Object.fromEntries(
      archive.readEvidence("repository").map(({ key, value }) => [key, value.commonKey]),
    );
    const evidenceBySourceEvent = new Map();
    const evidenceWarnings = [];
    const sources =
      since === undefined
        ? this.usageStore.database.prepare("SELECT * FROM source_files WHERE kind='hermes' ORDER BY path").all()
        : [];
    for (const source of sources) {
      try {
        await streamHermesDbEvents(
          String(source.path),
          { id: String(source.home_id), label: String(source.home_label), path: String(source.home_path) },
          (event) => {
            evidenceBySourceEvent.set(event.sourceEventId, {
              ...event.achievementEvidence,
              sourcePath: String(source.path),
              observedAt: cutoff,
            });
          },
          {},
        );
      } catch (error) {
        // Missing archived source files do not invalidate the already verified usage snapshot.
        evidenceWarnings.push({ source: String(source.path), code: error.code || "SOURCE_EVIDENCE_UNAVAILABLE" });
      }
    }
    const checkpoints = archive.readCheckpoints();
    const identity = createAchievementIdentity({ pricingModels, repositoryAliases: aliases });
    const capture = (reader) => {
      const revision = reader.database.prepare("SELECT revision FROM usage_business_revision WHERE singleton=1").get();
      const stamp = reader.historyProjectionInput || { facts: Number(revision?.revision || 0) };
      const input = readAchievementFacts(reader.database, {
        enabledAt: Date.parse(profile.enabledAt),
        usageStart: ACHIEVEMENT_USAGE_START,
        cutoff,
        stamp,
        identity,
        classifyFree,
        evidenceBySourceEvent,
        checkpoints,
        since,
      });
      const repositories = reader.database
        .prepare(`SELECT DISTINCT repository_key, repository_path, repository_kind FROM events
          ${since === undefined ? "" : "WHERE timestamp_ms >= ?"} ORDER BY repository_key`)
        .all(...(since === undefined ? [] : [since]));
      const nextTimestamp = reader.database
        .prepare("SELECT MIN(timestamp_ms) n FROM events WHERE timestamp_ms>=?")
        .get(cutoff).n;
      const visibleThrough = reader.database
        .prepare("SELECT MAX(timestamp_ms) n FROM events WHERE timestamp_ms<?")
        .get(cutoff).n;
      return {
        input,
        repositories,
        nextTimestamp: nextTimestamp === null ? null : Number(nextTimestamp),
        visibleThrough: visibleThrough === null ? null : Number(visibleThrough),
      };
    };
    // A proven tail outside every cold interval is already canonical in the hot store.
    const hasCold = Boolean(this.usageStore.database.prepare("SELECT 1 FROM archive_segments LIMIT 1").get());
    const tailHasNativeIds =
      since !== undefined &&
      hasCold &&
      Boolean(
        this.usageStore.database
          .prepare("SELECT 1 FROM events WHERE timestamp_ms>=? AND source_event_id<>'' LIMIT 1")
          .get(since),
      );
    const hotTail =
      since !== undefined &&
      !tailHasNativeIds &&
      !this.usageStore.database.prepare("SELECT 1 FROM archive_segments WHERE end_ms>? LIMIT 1").get(since);
    const captured = hotTail ? capture(this.usageStore) : await this.usageStore.withSqlHistoryReader(capture);
    const pendingKeys = new Map();
    for (const [pendingKey, pending] of pendingPolicies) {
      const policy = {
        ...pending,
        evidenceKey: `explicit-free:${digest([
          pending.sourceKind,
          pending.model,
          pending.route,
          pending.validFrom,
          pending.validUntil,
        ])}`,
      };
      explicitPolicies.set(JSON.stringify([policy.evidenceKey, policy.version]), policy);
      pendingKeys.set(pendingKey, evidenceKey(policy));
    }
    for (const [key, value] of explicitPolicies) {
      archive.putEvidence({ kind: "free-policy", key, value });
      policyMap.set(key, value);
    }
    // The callback above is synchronous: no borrowed SQLite connection survives an await.
    const resolveRepository = createCommonRepositoryResolver();
    for (const repository of captured.repositories) {
      const key = String(repository.repository_key);
      if (aliases[key] || repository.repository_kind !== "git") continue;
      const resolved = await resolveRepository(String(repository.repository_path));
      if (resolved.commonKey) {
        aliases[key] = resolved.commonKey;
        archive.putEvidence({
          kind: "repository",
          key,
          value: { commonKey: resolved.commonKey, ...resolved.evidence },
        });
      }
    }
    const facts = captured.input.facts.map(({ revision: _revision, ...fact }) => {
      const normalized = {
        ...fact,
        repositoryKey: aliases[fact.repositoryKey] || fact.repositoryKey,
        freeEvidenceKey: pendingKeys.get(fact.freeEvidenceKey) || fact.freeEvidenceKey,
      };
      return { ...normalized, revision: digest(normalized) };
    });
    archive.saveCheckpoints(
      captured.input.sourceCheckpoints.map((value) => ({ kind: "hermes-cumulative", key: value.key, value })),
      { expected: checkpoints },
    );
    const operations = archive.readOperations();
    const inputKey = digest({
      facts,
      usageStart: ACHIEVEMENT_USAGE_START,
      identity: ACHIEVEMENT_IDENTITY_VERSION,
      aliases: Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)),
      policies: [...policyMap.keys()].sort(),
      rules: ACHIEVEMENT_RULES_VERSION,
      calendar: closedAchievementPeriods(cutoff, profile.timeZone),
      operations,
    });
    return {
      ...captured.input,
      facts,
      inputKey,
      profile,
      usageStart: ACHIEVEMENT_USAGE_START,
      cutoff,
      operations,
      evidenceWarnings,
      nextTimestamp: captured.nextTimestamp,
      visibleThrough: captured.visibleThrough,
      readMode: hotTail ? "hot-tail" : "canonical-history",
    };
  }

  close() {
    this.archive?.close();
    this.archive = null;
  }
}
