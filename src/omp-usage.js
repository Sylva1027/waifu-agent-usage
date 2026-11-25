// OMP JSONL journals contain private transcript text alongside accounting. Only the
// projected fields below may leave the reader or enter its spillable staging area.
import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { USAGE_DETAIL_MASK as MASK, USAGE_DETAIL_INCONSISTENT } from "../public/usage-fields.js";
import { createRepositoryResolver } from "./repository-identity.js";
import { requestInputFacts } from "./usage-event-inputs.js";
import { UsageSourceRows } from "./usage-source-rows.js";
import { ompFileIsArchived, ompScanRoots } from "./omp-source.js";

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const token = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const textField = (v) => (typeof v === "string" ? v.trim() : "");
const hash = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

function sum(...parts) {
  return parts.includes(null) ? null : token(parts.reduce((total, value) => total + value, 0));
}

function projectUsage(raw, issue) {
  if (!isObject(raw)) {
    issue("OMP_MISSING_USAGE");
    return null;
  }
  const extra = raw.orchestration;
  const additional = (name) => {
    if (extra === undefined || (isObject(extra) && !Object.hasOwn(extra, name))) return 0;
    return isObject(extra) ? token(extra[name]) : null;
  };
  const uncached = token(raw.input);
  const read = token(raw.cacheRead);
  const write = token(raw.cacheWrite);
  const mainOutput = token(raw.output);
  const extraInput = additional("input");
  const extraCached = additional("cacheRead");
  const extraOutput = additional("output");
  const input = sum(uncached, read, write, extraInput, extraCached);
  const cached = sum(read, extraCached);
  const output = sum(mainOutput, extraOutput);
  const detailTotal = sum(input, output);
  const total = token(raw.totalTokens) ?? detailTotal;
  if (total === null) {
    issue("OMP_INCOMPLETE_USAGE");
    return null;
  }
  const reason = token(raw.reasoningTokens);
  const buckets = [uncached, read, write, mainOutput ?? reason, extraInput, extraCached, extraOutput];
  if (total === 0) {
    if (buckets.some((v) => v > 0) || reason > 0) {
      issue("OMP_CONFLICTING_TOTAL");
    }
    return null;
  }
  let gap = detailTotal === null ? 0 : Math.abs(total - detailTotal);
  if (detailTotal === null) {
    // Even incomplete buckets establish a lower bound. Exact arithmetic avoids rounding a one-token excess away.
    const minimum = buckets.reduce((value, part) => value + BigInt(part ?? 0), 0n);
    if (minimum > BigInt(total)) gap = Number(minimum - BigInt(total));
  }
  if (gap > 0) {
    if (!Number.isSafeInteger(gap)) issue("OMP_GAP_OVERFLOW");
    return {
      usage: { total, input: 0, cached: 0, output: 0, reasoning: 0 },
      detailMask: USAGE_DETAIL_INCONSISTENT,
      reconciliationGap: token(gap) ?? 0,
      cacheWriteTokens: 0,
      cacheWriteKnown: false,
      ...requestInputFacts(false, 0),
    };
  }
  const reasonKnown = reason !== null && mainOutput !== null && reason <= mainOutput && extraOutput === 0;
  return {
    usage: { total, input: input ?? 0, cached: cached ?? 0, output: output ?? 0, reasoning: reasonKnown ? reason : 0 },
    detailMask:
      (input === null ? 0 : MASK.input) |
      (cached === null ? 0 : MASK.cached) |
      (output === null ? 0 : MASK.output) |
      (reasonKnown ? MASK.reasoning : 0) |
      (write === null ? 0 : MASK.cacheWrite),
    reconciliationGap: 0,
    cacheWriteTokens: write ?? 0,
    cacheWriteKnown: write !== null,
    ...requestInputFacts(input !== null, input ?? 0),
  };
}

function serviceTier(tier) {
  if (tier === "priority" || tier === "fast") return "fast";
  if (tier === "default" || tier === "standard") return "standard";
  return "unknown";
}

function knownIdentity(value) {
  return Boolean(value) && !/^(?:unknown(?: (?:model|provider|api))?|n\/a)$/i.test(value);
}

function projectEntry(entry, header, home, filePath, issue) {
  const assistant = entry.type === "message" && entry.message?.role === "assistant";
  if (!assistant && entry.type !== "model_usage") return null;
  const msg = assistant ? entry.message : entry;
  const fields = projectUsage(msg.usage, issue);
  if (!fields) return null;
  const entryId = textField(entry.id);
  const entryTimestampMs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (!entryId || !Number.isFinite(entryTimestampMs) || entryTimestampMs <= 0) {
    issue(entryId ? "OMP_INVALID_TIMESTAMP" : "OMP_MISSING_ENTRY_ID");
    return null;
  }
  const messageTime =
    assistant &&
    Number.isSafeInteger(msg.timestamp) &&
    msg.timestamp > 0 &&
    Number.isFinite(new Date(msg.timestamp).getTime())
      ? msg.timestamp
      : null;
  const timestampMs = messageTime ?? entryTimestampMs;
  const nativeKey = hash(["omp-entry-v1", home.id, entryId, entryTimestampMs]);
  const provider = textField(msg.provider);
  const api = textField(msg.api);
  const model = textField(msg.model);
  const response = assistant ? textField(msg.responseId) : "";
  const responseKey =
    messageTime !== null && [provider, api, model, response].every(knownIdentity)
      ? hash(["omp-response-v1", home.id, provider, api, model, response, messageTime])
      : "";
  const discarded = !assistant && msg.purpose === "discarded-turn";
  return {
    eventId: nativeKey,
    sourceEventId: nativeKey,
    sourceKind: "omp",
    source: "omp",
    sourcePath: filePath,
    homeId: home.id,
    homeLabel: home.label,
    homePath: home.path,
    channel: "Oh My Pi",
    timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
    sessionId: header.id,
    project: header.cwd,
    conversationName: "",
    model: model || "Unknown model",
    modelProvider: provider,
    serviceTier: assistant ? serviceTier(msg.serviceTier) : "unknown",
    priceVersion: "",
    ...fields,
    omp: {
      nativeKey,
      responseKey,
      aliasKeys: [],
      parentSession: header.parentSession,
      provider,
      api,
      discarded,
      entryTimestampMs,
      usageDigest: hash([provider, api, model, fields]),
    },
  };
}

async function* boundedBytes(handle, size) {
  for (let offset = 0; offset < size; ) {
    const buffer = Buffer.allocUnsafe(Math.min(65536, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) throw new Error("truncated");
    offset += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

// Split physical LF bytes before decoding; this also bounds a malicious or incomplete single line.
async function scanLines(chunks, maxBytes, archive, visit, partial) {
  let parts = [];
  let length = 0;
  for await (const chunk of chunks) {
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start);
      const end = lf < 0 ? chunk.length : lf;
      length += end - start;
      if (length > maxBytes) throw new SnapshotError("OMP_LINE_TOO_LARGE");
      parts.push(chunk.subarray(start, end));
      if (lf < 0) break;
      visit(utf8.decode(Buffer.concat(parts, length)));
      parts = [];
      length = 0;
      start = lf + 1;
    }
  }
  if (length && archive) visit(utf8.decode(Buffer.concat(parts, length)));
  else if (length) partial("OMP_INCOMPLETE_TAIL");
}

class SnapshotError extends Error {}

function sameFileStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function isWithin(root, file) {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function approvedTarget(filePath, home) {
  const target = await realpath(filePath);
  if (home.excludedScanRoots?.some((root) => isWithin(root, filePath) || isWithin(root, target))) {
    throw new SnapshotError("OMP_OUTSIDE_SCAN_ROOT");
  }
  for (const root of ompScanRoots(home)) {
    if (!isWithin(root, filePath)) continue;
    const canonicalRoot = await realpath(root);
    if (path.relative(root, canonicalRoot) === "" && isWithin(canonicalRoot, target)) return target;
  }
  throw new SnapshotError("OMP_OUTSIDE_SCAN_ROOT");
}

/**
 * Emit sanitized events only after the descriptor, path and compressed trailer are verified.
 * An incomplete active tail (or unmeterable record) permits additive facts only.
 * @param {string} filePath
 * @param {{id:string,label:string,path:string,approvedScanRoots?:string[],excludedScanRoots?:string[],agentPath?:string}} home
 * @param {{onEvent:Function,repositoryResolver?:Function,maxLineBytes?:number,maxRowsBytes?:number}} options
 */
export async function readOmpSnapshot(filePath, home, options) {
  const rows = new UsageSourceRows(options.maxRowsBytes);
  const diagnostics = {};
  let header = /** @type {{id:string,cwd:string,parentSession:string}|null} */ (null);
  let status = "complete";
  let pending = null;
  let physicalTitle = false;
  let handle;
  const issue = (code) => {
    diagnostics[code] = (diagnostics[code] || 0) + 1;
    status = "partial";
  };
  let ordinal = 0;
  const stage = (event) => rows.set(String(ordinal++), event);

  function visit(line) {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new SnapshotError("OMP_INVALID_JSON");
    }
    if (!isObject(entry)) throw new SnapshotError("OMP_INVALID_ENTRY");
    if (!header) {
      if (!physicalTitle && entry.type === "title") {
        physicalTitle = true;
        return;
      }
      if (entry.type !== "session") throw new SnapshotError("OMP_NOT_SESSION");
      if (!textField(entry.id)) throw new SnapshotError("OMP_INVALID_HEADER");
      if (entry.version !== 2 && entry.version !== 3) throw new SnapshotError("OMP_UNSUPPORTED_SESSION_VERSION");
      header = { id: textField(entry.id), cwd: textField(entry.cwd), parentSession: textField(entry.parentSession) };
      return;
    }
    if (entry.type === "session") throw new SnapshotError("OMP_INVALID_HEADER");
    if (pending) {
      const origin = textField(entry.details?.discardedEntryId);
      if (
        entry.type === "branch_summary" &&
        entry.details?.kind === "discarded-entry-branch" &&
        origin &&
        (pending.parentId === null || typeof pending.parentId === "string") &&
        entry.parentId === pending.parentId &&
        entry.fromId === (pending.parentId ?? "root")
      ) {
        const event = pending.event;
        const key = hash(["omp-entry-v1", home.id, origin, event.omp.entryTimestampMs]);
        event.omp.aliasKeys = [event.omp.nativeKey];
        event.omp.nativeKey = event.sourceEventId = event.eventId = key;
        stage(event);
      } else issue("OMP_UNRESOLVED_DISCARD");
      pending = null;
    }
    const event = projectEntry(entry, header, home, filePath, issue);
    if (!event) return;
    if (event.omp.discarded) pending = { event, parentId: entry.parentId };
    else stage(event);
  }

  try {
    try {
      const target = await approvedTarget(filePath, home);
      handle = await open(target, "r");
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new SnapshotError("OMP_INVALID_FILE");
      const gz = filePath.endsWith(".jsonl.gz");
      const archive = gz || ompFileIsArchived(filePath, home);
      const consume = async (chunks) =>
        scanLines(chunks, options.maxLineBytes ?? MAX_LINE_BYTES, archive, visit, issue);
      const bytes = boundedBytes(handle, Number(before.size));
      if (gz) await pipeline(Readable.from(bytes), createGunzip(), consume);
      else await consume(bytes);
      if (pending) issue("OMP_UNRESOLVED_DISCARD");
      if (!header) throw new SnapshotError("OMP_MISSING_HEADER");
      if (
        !sameFileStat(before, await handle.stat({ bigint: true })) ||
        target !== (await approvedTarget(filePath, home)) ||
        !sameFileStat(before, await stat(target, { bigint: true }))
      ) {
        throw new SnapshotError("OMP_FILE_CHANGED");
      }
    } catch (error) {
      const code = error instanceof SnapshotError ? error.message : "OMP_READ_ERROR";
      diagnostics[code] = (diagnostics[code] || 0) + 1;
      return { status: code === "OMP_NOT_SESSION" ? "ignored" : "error", diagnostics, header };
    } finally {
      await handle?.close();
    }
    const resolve = options.repositoryResolver ?? createRepositoryResolver();
    const repository = rows.size ? await resolve(header.cwd) : null;
    for (const event of rows.values()) {
      await options.onEvent({
        ...event,
        repositoryKey: repository.key,
        repositoryPath: repository.path,
        repositoryKind: repository.kind,
      });
    }
    return { status, diagnostics, header };
  } finally {
    rows.close();
  }
}
