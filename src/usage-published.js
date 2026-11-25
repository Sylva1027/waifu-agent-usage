import { usageFromRow } from "./usage-sql.js";
export function publishedUsageEventFromRow(row, sourceKind, serviceTierEvidence, resolveQuotaSource, aliases = null) {
  const timestampMs = Number(row.timestamp_ms);
  const sessionId = String(row.session_id);
  const repository = aliases?.resolve(row.repository_key);
  return {
    timestamp: new Date(timestampMs).toISOString(),
    sessionId,
    homeId: String(row.home_id),
    homeLabel: String(row.home_label),
    sourceKind: String(sourceKind),
    channel: String(row.channel),
    project: String(row.project),
    model: String(row.model),
    ...(canonicalizeKind(String(sourceKind)) === "codex"
      ? { quotaSource: resolveQuotaSource?.(String(row.home_id), sessionId, timestampMs) || "unknown" }
      : {}),
    cwd: String(row.cwd),
    repositoryKey: repository?.key ?? String(row.repository_key),
    repositoryPath: repository?.path ?? String(row.repository_path),
    repositoryKind: repository?.kind ?? String(row.repository_kind),
    detailMask: Number(row.detail_mask || 0),
    reconciliationGap: Number(row.reconciliation_gap || 0),
    cacheWriteTokens: Number(row.cache_write_tokens || 0),
    cacheWriteKnown: Boolean(row.cache_write_known),
    requestInputTokens: Number(row.request_input_tokens || 0),
    contextLevel: String(row.context_level),
    serviceTier:
      (!["hermes", "omp"].includes(sourceKind) &&
        serviceTierEvidence?.resolve(sessionId, timestampMs, String(row.service_tier))) ||
      String(row.service_tier),
    priceVersion: String(row.price_version),
    total: usageFromRow(row),
  };
}
export function publishedUsageHomesFromDatabase(database) {
  const rows = database
    .prepare(
      `SELECT DISTINCT home_id, home_label, home_path, kind
       FROM source_files
       ORDER BY home_id, home_label, home_path, kind`,
    )
    .all();
  const homes = [];
  for (const row of rows) {
    const home = {
      id: String(row.home_id),
      label: String(row.home_label),
      path: String(row.home_path),
      kind: String(row.kind),
    };
    const previous = homes[homes.length - 1];
    if (previous?.id === home.id) {
      if (previous.label !== home.label || previous.path !== home.path || previous.kind !== home.kind) {
        throw Object.assign(new Error(`Conflicting published identity for home ${home.id}`), {
          code: "PUBLISHED_HOME_IDENTITY_CONFLICT",
        });
      }
      continue;
    }
    homes.push(home);
  }
  return homes;
}
export function quotaObservationsFromDatabase(database, attachedHot = false) {
  const rows = Array.from(
    database
      .prepare(`
      SELECT source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      FROM ${attachedHot ? "history_hot." : ""}rate_limit_observations INDEXED BY rate_limit_window_lookup_idx
      ORDER BY limit_id ASC, window_minutes ASC, observed_at_ms DESC
    `)
      .iterate(),
    (row) => ({
      sourcePath: row.source_path,
      lineNumber: Number(row.line_number),
      role: row.role,
      observedAtMs: Number(row.observed_at_ms),
      limitId: row.limit_id,
      limitName: row.limit_name,
      planType: row.plan_type,
      windowMinutes: Number(row.window_minutes),
      resetsAtMs: Number(row.resets_at_ms),
      usedPercent: row.used_percent === null ? null : Number(row.used_percent),
    }),
  );
  const saved = database
    .prepare(
      `SELECT value FROM ${attachedHot ? "history_hot." : ""}store_meta WHERE key = 'official_quota_observations'`,
    )
    .get()?.value;
  return saved ? rows.concat(JSON.parse(String(saved))) : rows;
}
export function publishedUsageSessionsFromEvents(events, homes) {
  const homesById = new Map(homes.map((home) => [home.id, home]));
  /** @type {Map<string, any>} */
  const sessions = new Map();
  for (const event of events) {
    const home = homesById.get(event.homeId);
    if (!home) {
      throw Object.assign(new Error(`Missing published home ${event.homeId}`), {
        code: "PUBLISHED_SESSION_HOME_MISSING",
      });
    }
    const key = JSON.stringify([event.homeId, event.sessionId]);
    const current = sessions.get(key);
    if (!current) {
      sessions.set(key, {
        id: event.sessionId,
        homeId: event.homeId,
        homeLabel: home.label,
        homePath: home.path,
        firstAt: event.timestamp,
        lastAt: event.timestamp,
        eventCount: 1,
        total: { ...event.total },
        channel: event.channel,
        cwd: event.cwd || "",
        model: event.model,
      });
      continue;
    }
    if (event.timestamp < current.firstAt) current.firstAt = event.timestamp;
    if (event.timestamp > current.lastAt) current.lastAt = event.timestamp;
    current.eventCount += 1;
    current.total.total += event.total.total;
    current.total.input += event.total.input;
    current.total.cached += event.total.cached;
    current.total.output += event.total.output;
    current.total.reasoning += event.total.reasoning;
    current.channel = event.channel;
    current.cwd = event.cwd || "";
    current.model = event.model;
  }
  return [...sessions.values()].sort(
    (left, right) =>
      left.lastAt.localeCompare(right.lastAt) ||
      left.homeId.localeCompare(right.homeId) ||
      left.id.localeCompare(right.id),
  );
}
export function canonicalizeKind(kindRaw) {
  if (typeof kindRaw !== "string") return "unsupported";
  const kind = kindRaw.trim().toLowerCase();
  if (["main", "jetbrains", "extra", "codex"].includes(kind)) return "codex";
  return ["zcode", "dsh", "opencode", "claude", "workbuddy", "hermes", "omp"].includes(kind) ? kind : "unsupported";
}
