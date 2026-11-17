import { createHash } from "node:crypto";

const OMIT = new Set([
  "id",
  "rowid",
  "history_ordinal",
  "hour_key",
  "day_key",
  "week_key",
  "month_key",
  "price_version",
  "home_label",
  "repository_path",
]);
const REQUIRED = {
  events: ["source_path", "timestamp_ms", "session_id", "home_id", "channel", "model", "total", "source_event_id"],
  source_files: ["path", "kind", "home_id"],
};
const get = (collection, key) => (collection instanceof Map ? collection.get(key) : collection?.[key]);
const stable = (value) => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
};
const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");

function time(value, name) {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime()))
    throw new Error(`Invalid achievement ${name}`);
  return value;
}

function tokens(value) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new Error("Invalid achievement token total");
}

function coverageOf(evidence) {
  const { start, end } = evidence.coverage || {};
  time(end, "coverage end");
  if (start !== null) time(start, "coverage start");
  if (start !== null && start > end) throw new Error("Invalid achievement coverage order");
  return { start, end };
}

/**
 * Synchronously reads a complete, already reconciled events JOIN source_files snapshot owned by main.
 * Never prepares cold history, writes, starts a transaction, or closes the borrowed database.
 * Evidence/checkpoints are Maps or objects keyed by sourceEventId (Hermes IDs already hash the source).
 * Evidence: {sourceEventId, homeId, sourcePath, totalTokens, timestampMs, coverage:{start,end},
 * precision:'interval'|'day'|'instant', cumulative?, observedAt}. Coverage end is inclusive.
 * Checkpoints retain total/credited as decimal strings, coverage, creditedCoverage, segments and capture times.
 * Each segment is a complete current fact; replay never returns only the newest increment.
 */
export function readAchievementFacts(database, options) {
  const { enabledAt, cutoff, stamp, identity, classifyFree, evidenceBySourceEvent, checkpoints } = options;
  time(enabledAt, "enabledAt");
  time(cutoff, "cutoff");
  if (
    cutoff < enabledAt ||
    !stamp ||
    typeof stamp !== "object" ||
    typeof identity !== "function" ||
    typeof classifyFree !== "function"
  )
    throw new Error("Invalid achievement facts options");
  for (const [table, required] of Object.entries(REQUIRED)) {
    const columns = new Set(
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name),
    );
    const missing = required.filter((name) => !columns.has(name));
    if (missing.length) throw new Error(`Achievement facts requires ${table}.${missing.join(",")}`);
  }
  const excluded = {
    beforeEnabledAt: 0,
    atOrAfterCutoff: 0,
    zeroTokens: 0,
    missingEvidence: 0,
    invalidEvidence: 0,
    unprovenCoverage: 0,
    baseline: 0,
    resetOrRevision: 0,
  };
  const facts = [];
  const sourceCheckpoints = [];
  const ordinals = new Map();
  const sourceIds = new Set();
  const priorIdentity =
    options.since === undefined
      ? null
      : database.prepare(`SELECT 1 FROM events
    WHERE source_path=? AND source_event_id=? AND source_event_id<>'' AND timestamp_ms<? LIMIT 1`);
  const content = [];
  let processedRows = 0;
  const statement = database.prepare(`SELECT e.*, sf.kind AS achievement_source_kind,
    sf.home_id AS achievement_source_home FROM events e
    LEFT JOIN source_files sf ON sf.path=e.source_path
    ${options.since === undefined ? "" : "WHERE e.timestamp_ms >= ?"}`);
  statement.setReadBigInts(true);
  for (const raw of statement.iterate(...(options.since === undefined ? [] : [time(options.since, "since")]))) {
    processedRows++;
    if (!raw.achievement_source_kind || raw.achievement_source_home !== raw.home_id)
      throw new Error("Achievement event has missing or mismatched source identity");
    const sourceKind = String(raw.achievement_source_kind);
    const timestampMs = time(Number(raw.timestamp_ms), "timestamp_ms");
    const total = tokens(raw.total);
    const sourceEventId = String(raw.source_event_id);
    const sourcePath = String(raw.source_path);
    const homeId = String(raw.home_id);
    const scope = [sourceKind, homeId, sourcePath];
    const payload = Object.fromEntries(
      Object.entries(raw).filter(([key]) => !OMIT.has(key) && !key.startsWith("achievement_")),
    );
    const payloadKey = hash([scope, payload]);
    const ordinal = ordinals.get(payloadKey) || 0;
    ordinals.set(payloadKey, ordinal + 1);
    const factKey = hash(sourceEventId ? [scope, sourceEventId] : [scope, payloadKey, ordinal]);
    if (sourceEventId && priorIdentity?.get(sourcePath, sourceEventId, options.since))
      throw new Error("Duplicate achievement source event identity");
    if (sourceEventId && sourceIds.has(factKey)) throw new Error("Duplicate achievement source event identity");
    sourceIds.add(factKey);
    if (timestampMs >= cutoff) {
      excluded.atOrAfterCutoff++;
      continue;
    }
    // Keep canonical content, including excluded cumulative rows, so evidence repairs invalidate the input.
    content.push([payloadKey, ordinal]);
    if (timestampMs < enabledAt && sourceKind !== "hermes") {
      excluded.beforeEnabledAt++;
      continue;
    }
    const event = {
      ...Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [
          key,
          typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value,
        ]),
      ),
      timestampMs,
      timestamp: new Date(timestampMs).toISOString(),
      sourceKind,
      sourcePath,
      sourceEventId,
      homeId,
      homeLabel: raw.home_label || "",
      sessionId: String(raw.session_id),
      model: String(raw.model),
      rawModel: String(raw.model),
      repositoryKey: raw.repository_key || "unknown:cwd",
      repositoryPath: raw.repository_path || "",
      repositoryKind: raw.repository_kind || "unknown",
      detailMask: Number(raw.detail_mask || 0),
      serviceTier: raw.service_tier || "unknown",
      totalTokens: total.toString(),
    };
    const previous = get(checkpoints, sourceEventId);
    let evidence = get(evidenceBySourceEvent, sourceEventId);
    // Archived sources may be unavailable; an exact checkpoint match still proves the saved segments.
    if (
      !evidence &&
      sourceKind === "hermes" &&
      previous &&
      previous.sourceEventId === sourceEventId &&
      previous.homeId === homeId &&
      previous.sourcePath === sourcePath &&
      previous.total === total.toString() &&
      previous.timestampMs === timestampMs
    ) {
      evidence = { ...previous, totalTokens: previous.total, precision: "interval", cumulative: true };
    }
    if (evidence) {
      if (
        evidence.sourceEventId !== sourceEventId ||
        evidence.homeId !== homeId ||
        evidence.sourcePath !== sourcePath ||
        tokens(evidence.totalTokens) !== total ||
        evidence.timestampMs !== timestampMs
      ) {
        excluded.invalidEvidence++;
        continue;
      }
    }
    let precision = "instant";
    let coverage = { start: timestampMs, end: timestampMs };
    let credited = total;
    let segments = null;
    if (
      sourceKind === "hermes" &&
      (!sourceEventId || !evidence || evidence.cumulative !== true || evidence.precision !== "interval")
    ) {
      excluded.missingEvidence++;
      continue;
    }
    if (evidence) {
      precision = evidence.precision;
      if (!["instant", "day", "interval"].includes(precision)) throw new Error("Invalid achievement precision");
      coverage = coverageOf(evidence);
      if (coverage.end !== timestampMs || (precision === "instant" && coverage.start !== timestampMs)) {
        excluded.invalidEvidence++;
        continue;
      }
    }
    if (evidence?.cumulative) {
      time(evidence.observedAt, "observedAt");
      if (evidence.observedAt < coverage.end) throw new Error("Achievement observation precedes coverage");
      if (
        previous &&
        (previous.key !== sourceEventId ||
          previous.sourceEventId !== sourceEventId ||
          previous.homeId !== homeId ||
          previous.sourcePath !== sourcePath ||
          previous.enabledAt !== enabledAt)
      )
        throw new Error("Achievement checkpoint source/profile mismatch");
      credited = 0n;
      let creditedCoverage = null;
      segments = [];
      if (previous) {
        const previousTotal = tokens(previous.total);
        credited = tokens(previous.credited);
        time(previous.timestampMs, "checkpoint timestamp");
        time(previous.observedAt, "checkpoint observation");
        if (previous.observedAt < previous.timestampMs || credited > previousTotal)
          throw new Error("Invalid achievement checkpoint watermark");
        if (!Array.isArray(previous.segments)) throw new Error("Achievement checkpoint requires segments");
        segments = previous.segments.map((segment) => {
          const segmentCoverage = coverageOf(segment);
          if (
            typeof segment.key !== "string" ||
            !segment.key ||
            segmentCoverage.start === null ||
            segmentCoverage.start < enabledAt ||
            segmentCoverage.end > previous.timestampMs
          )
            throw new Error("Invalid achievement checkpoint segment");
          return { key: segment.key, totalTokens: tokens(segment.totalTokens).toString(), coverage: segmentCoverage };
        });
        if (segments.reduce((sum, segment) => sum + tokens(segment.totalTokens), 0n) !== credited)
          throw new Error("Achievement checkpoint credited/segments mismatch");
        if (new Set(segments.map((segment) => segment.key)).size !== segments.length)
          throw new Error("Duplicate achievement checkpoint segment");
        if (segments.length)
          creditedCoverage = segments.reduce(
            (bounds, segment) => ({
              start: Math.min(bounds.start, segment.coverage.start),
              end: Math.max(bounds.end, segment.coverage.end),
            }),
            segments[0].coverage,
          );
        if (
          total < previousTotal ||
          timestampMs < previous.timestampMs ||
          (total !== previousTotal && timestampMs === previous.timestampMs) ||
          evidence.observedAt < previous.observedAt ||
          coverage.start !== coverageOf(previous).start
        ) {
          excluded.resetOrRevision++;
          credited = 0n;
          creditedCoverage = null;
          segments = [];
          if (coverage.start !== null && coverage.start >= enabledAt && total > 0n) {
            // A corrected complete post-T0 ledger replaces its old value; it is not a fresh delta.
            credited = total;
            creditedCoverage = coverage;
            segments.push({
              key: hash([scope, sourceEventId, "revised", total, coverage]),
              totalTokens: total.toString(),
              coverage,
            });
          }
        } else if (total > previousTotal) {
          if (
            previous.observedAt >= enabledAt &&
            timestampMs >= previous.observedAt &&
            evidence.observedAt > previous.observedAt
          ) {
            credited += total - previousTotal;
            creditedCoverage = { start: creditedCoverage?.start ?? previous.observedAt, end: coverage.end };
            segments.push({
              key: hash([scope, sourceEventId, previousTotal, total, previous.observedAt, coverage.end]),
              totalTokens: (total - previousTotal).toString(),
              coverage: { start: previous.observedAt, end: coverage.end },
            });
          } else excluded.unprovenCoverage++;
        }
      } else if (coverage.start !== null && coverage.start >= enabledAt) {
        credited = total;
        creditedCoverage = coverage;
        if (total > 0n)
          segments.push({
            key: hash([scope, sourceEventId, 0n, total, coverage]),
            totalTokens: total.toString(),
            coverage,
          });
      } else excluded.baseline++;
      const checkpoint = {
        key: sourceEventId,
        sourceEventId,
        homeId,
        sourcePath,
        enabledAt,
        total: total.toString(),
        timestampMs,
        observedAt: evidence.observedAt,
        cutoff,
        coverage,
        credited: credited.toString(),
        creditedCoverage,
        segments,
      };
      sourceCheckpoints.push(checkpoint);
      coverage = creditedCoverage;
      if (credited === 0n) continue;
    }
    if (!coverage || coverage.start === null || coverage.start < enabledAt || coverage.end >= cutoff) {
      excluded.unprovenCoverage++;
      continue;
    }
    if (credited === 0n) {
      excluded.zeroTokens++;
      continue;
    }
    const normalized = identity(event);
    if (
      !normalized ||
      ["modelId", "providerId", "harnessId", "sessionKey", "repositoryKey"].some(
        (key) => !Object.hasOwn(normalized, key) || (normalized[key] !== null && typeof normalized[key] !== "string"),
      )
    )
      throw new Error("Invalid achievement identity result");
    for (const segment of segments || [{ key: factKey, totalTokens: credited.toString(), coverage }]) {
      const segmentCoverage = segment.coverage;
      const free = classifyFree({
        ...event,
        ...normalized,
        totalTokens: segment.totalTokens,
        occurredAt: segmentCoverage.end,
        precision,
        coverage: segmentCoverage,
      });
      if (
        !free ||
        !["free", "paid", "review", "unknown"].includes(free.freeClass) ||
        (free.freeEvidenceKey !== null && typeof free.freeEvidenceKey !== "string") ||
        (free.freeClass === "free" && !free.freeEvidenceKey)
      )
        throw new Error("Invalid achievement free evidence result");
      const fact = {
        factKey: segments ? hash([factKey, segment.key]) : factKey,
        occurredAt: segmentCoverage.end,
        precision,
        coverage: segmentCoverage,
        totalTokens: segment.totalTokens,
        ...Object.fromEntries(
          ["modelId", "providerId", "harnessId", "sessionKey", "repositoryKey"].map((key) => [key, normalized[key]]),
        ),
        freeClass: free.freeClass,
        freeEvidenceKey: free.freeEvidenceKey,
        rawModel: event.rawModel,
        sourceKind,
        sourceEventId,
        sourcePath,
        homeId,
      };
      facts.push({ ...fact, revision: hash(segments ? fact : [payloadKey, fact]) });
    }
  }
  facts.sort((a, b) => a.factKey.localeCompare(b.factKey));
  sourceCheckpoints.sort((a, b) => a.key.localeCompare(b.key));
  content.sort(([a, x], [b, y]) => a.localeCompare(b) || x - y);
  const versions = Object.fromEntries(
    ["identityVersion", "freePolicyVersion", "freeEvidenceVersion", "sourceEvidenceVersion"]
      .filter((key) => Object.hasOwn(stamp, key))
      .map((key) => [key, stamp[key]]),
  );
  const inputKey = hash([
    "achievement-facts-v1",
    enabledAt,
    versions,
    content,
    facts,
    sourceCheckpoints.map(({ cutoff: _cutoff, observedAt: _observedAt, ...checkpoint }) => checkpoint),
  ]);
  return { inputKey, stamp, facts, sourceCheckpoints, excluded, processedRows };
}
