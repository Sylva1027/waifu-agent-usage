import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRepositoryResolver } from "./repository-identity.js";
import { createSourceRepositoryResolver } from "./repository-aliases.js";
import { readRolloutLines, plainRolloutPath } from "./codex-rollout.js";
import {
  assertCodexJsonlCheckpoint,
  CODEX_JSONL_PROGRESS_ADAPTER,
  CODEX_JSONL_PROGRESS_FORMAT,
  readCodexJsonlProgressRows,
  SourceProgressUnsupportedError,
} from "./usage-jsonl-progress.js";
import { requestInputFacts } from "./usage-event-inputs.js";
import { loadQuotaSourceEvidence } from "./quota-source-evidence.js";
import { quotaSourceResolver } from "./quota-usage-source.js";
import { readCodexQuotaObservations } from "./codex-quota-cache.js";
import { createQuotaSourceTracker } from "../public/quota-usage.js";
import {
  USAGE_DETAIL_MASK,
  USAGE_FIELDS,
  emptyUsage,
  isZeroUsage,
  validateUsageDetails,
} from "../public/usage-fields.js";
import {
  streamZcodeDbEvents,
  parseZcodeDb,
  parseSqliteUsageDb,
  zcodeDatabaseFile,
  zcodeSourceStat,
} from "./zcode-usage.js";
import { hermesDatabaseFile, hermesHomeLooksUsable, hermesSourceStat, streamHermesDbEvents } from "./hermes-usage.js";
import { dshSessionFiles, dshHomeLooksUsable, parseDshSessions, streamDshSessionEvents } from "./dsh-usage.js";
import {
  claudeHomeLooksUsable,
  claudeSessionFiles,
  parseClaudeSessions,
  streamClaudeSessionEvents,
} from "./claude-code-usage.js";
import {
  parseWorkbuddySessions,
  streamWorkbuddySessionEvents,
  workbuddyHomeLooksUsable,
  workbuddySessionFiles,
} from "./workbuddy-usage.js";
import {
  opencodeDatabaseFiles,
  opencodeHomeLooksUsable,
  opencodeSourceStat,
  parseOpencodeDb,
  streamOpencodeDbEvents,
} from "./opencode-usage.js";
import { homeSourceKinds } from "../public/timeline-utils.js";
import { COMPARISON_PERIOD_KEYS, summarizePeriodComparison } from "../public/period-comparison.js";
import { addUsage } from "./usage-query.js";
import { addOmpHome, classifyOmpDirectory, discoverOmpHomes, ompScanRoots, ompSessionFiles } from "./omp-source.js";
import { readOmpSnapshot } from "./omp-usage.js";
import { chooseOmpOccurrence, groupOmpOccurrences } from "./omp-usage-identity.js";

export { COMPARISON_PERIOD_KEYS, summarizePeriodComparison };

const SESSION_DIRS = ["sessions", "archived_sessions"];
const PROJECT_USAGE_DIR = ".codex-usage";
const PROJECT_USAGE_FILE = "usage.jsonl";
const PROJECT_LOG_SCHEMA_VERSION = "codex-usage.project-log.v1";
const USAGE_DETAIL_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];

export { emptyUsage, USAGE_DETAIL_MASK };

function usageFromRaw(raw = {}) {
  return {
    total: Number(raw.total_tokens || 0),
    input: Number(raw.input_tokens || 0),
    cached: Number(raw.cached_input_tokens || 0),
    output: Number(raw.output_tokens || 0),
    reasoning: Number(raw.reasoning_output_tokens || 0),
  };
}

function readCacheWrite(raw = {}) {
  const value = raw.cache_write_input_tokens;
  const known =
    Object.hasOwn(raw, "cache_write_input_tokens") &&
    value !== null &&
    value !== "" &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0;
  return { tokens: known ? Number(value) : 0, known };
}

function readServiceTier(row = {}, payload = {}) {
  const values = [
    payload.info?.response?.service_tier,
    payload.response?.service_tier,
    row.response?.service_tier,
    payload.info?.service_tier,
    payload.service_tier,
    row.service_tier,
  ];
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return value ? value.trim().toLowerCase() : "unknown";
}

function lastUsageMatchesDelta(last, lastMask, delta, deltaMask) {
  const required = USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.output;
  if ((lastMask & required) !== required || (deltaMask & required) !== required) return false;
  /** @type {Array<[keyof import("./usage-types.js").UsageTotals, number]>} */
  const detailFields = [
    ["input", USAGE_DETAIL_MASK.input],
    ["cached", USAGE_DETAIL_MASK.cached],
    ["output", USAGE_DETAIL_MASK.output],
    ["reasoning", USAGE_DETAIL_MASK.reasoning],
  ];
  for (const [field, bit] of detailFields) {
    if (lastMask & bit && (!(deltaMask & bit) || last[field] !== delta[field])) return false;
  }
  return true;
}

function cacheWriteForEvent({ cumulative, previous, last, lastMatches }) {
  if (!cumulative) return last || { tokens: 0, known: false };
  const hasDelta = cumulative.known && previous.known;
  const deltaTokens = hasDelta ? Math.max(0, cumulative.tokens - previous.tokens) : 0;
  if (lastMatches && last?.known) {
    if (hasDelta && deltaTokens !== last.tokens) return { tokens: 0, known: false };
    return last;
  }
  return hasDelta ? { tokens: deltaTokens, known: true } : { tokens: 0, known: false };
}

function contextForEvent(matches, usage, mask) {
  return requestInputFacts(matches && Boolean(mask & USAGE_DETAIL_MASK.input), usage.input);
}

function usageDetailMask(raw = {}, keys = USAGE_DETAIL_KEYS) {
  return keys.reduce((mask, key, index) => {
    const value = raw[key];
    const known =
      Object.hasOwn(raw, key) && value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
    return known ? mask | (1 << index) : mask;
  }, 0);
}

function projectLogDetailMask(raw = {}) {
  const has = (...keys) =>
    keys.some((key) => {
      const value = raw[key];
      return (
        Object.hasOwn(raw, key) &&
        value !== null &&
        value !== "" &&
        Number.isFinite(Number(value)) &&
        Number(value) >= 0
      );
    });
  return (
    (has("input", "input_tokens") ? USAGE_DETAIL_MASK.input : 0) |
    (has("cached", "cached_input_tokens") ? USAGE_DETAIL_MASK.cached : 0) |
    (has("output", "output_tokens") ? USAGE_DETAIL_MASK.output : 0) |
    (has("reasoning", "reasoning_output_tokens") ? USAGE_DETAIL_MASK.reasoning : 0)
  );
}

/** @param {number} currentMask @param {number} previousMask */
function diffUsage(
  current,
  previous,
  currentMask = USAGE_DETAIL_MASK.complete,
  previousMask = USAGE_DETAIL_MASK.complete,
) {
  const diff = emptyUsage();
  diff.total = Math.max(0, (current.total || 0) - (previous.total || 0));
  let detailMask = 0;
  /** @type {Array<[keyof import("./usage-types.js").UsageTotals, number]>} */
  const detailFields = [
    ["input", USAGE_DETAIL_MASK.input],
    ["cached", USAGE_DETAIL_MASK.cached],
    ["output", USAGE_DETAIL_MASK.output],
    ["reasoning", USAGE_DETAIL_MASK.reasoning],
  ];
  for (const [field, bit] of detailFields) {
    if (currentMask & bit && previousMask & bit) {
      diff[field] = Math.max(0, (current[field] || 0) - (previous[field] || 0));
      detailMask |= bit;
    }
  }
  return { usage: diff, detailMask };
}

function initialRequestUsage(cumulative, cumulativeMask, last, lastMask, diff, hasUsageInFile) {
  if (hasUsageInFile || !last || diff.total <= last.total || !last.total) return null;
  const required = USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.output;
  if ((lastMask & required) !== required || (cumulativeMask & required) !== required) return null;
  for (const field of USAGE_FIELDS) {
    if (last[field] > cumulative[field]) return null;
  }
  // A new rollout can inherit a counter from its parent conversation. Only the
  // last request is attributable to this file when the first delta is larger.
  return { usage: last, detailMask: lastMask };
}

function rememberSessionUsage(baselines, sessionId, usage, detailMask, cacheWriteTokens, cacheWriteKnown) {
  const baseline = baselines.get(sessionId) || {
    usage: emptyUsage(),
    detailMask: USAGE_DETAIL_MASK.complete,
    cacheWrite: { tokens: 0, known: true },
  };
  addUsage(baseline.usage, usage);
  baseline.detailMask &= detailMask & USAGE_DETAIL_MASK.complete;
  baseline.cacheWrite.tokens += cacheWriteTokens || 0;
  baseline.cacheWrite.known &&= Boolean(cacheWriteKnown);
  baselines.set(sessionId, baseline);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sourceId(kind, sourcePath) {
  const normalizedPath = path.resolve(sourcePath).replace(/\\/g, "/");
  const identity = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${kind}-${digest}`;
}

export async function importPathIdentity(directory) {
  let resolved = path.resolve(directory);
  try {
    resolved = await realpath(resolved);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function codexHomeLooksUsable(homePath) {
  const checks = await Promise.all([
    exists(path.join(homePath, "sessions")),
    exists(path.join(homePath, "archived_sessions")),
    exists(path.join(homePath, "state_5.sqlite")),
  ]);
  return checks.some(Boolean);
}

function uniquePaths(paths) {
  const seen = new Set();
  const unique = [];
  for (const candidate of paths.filter(Boolean)) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    unique.push(resolved);
  }
  return unique;
}

function optionImportDirs(options = {}) {
  const env = options.env || process.env;
  const configured = [];
  if (Array.isArray(options.importDirs)) {
    configured.push(...options.importDirs);
  } else if (typeof options.importDirs === "string") {
    configured.push(...options.importDirs.split(path.delimiter));
  }
  if (env.CODEX_USAGE_IMPORT_DIRS) {
    configured.push(...env.CODEX_USAGE_IMPORT_DIRS.split(path.delimiter));
  }
  return uniquePaths(configured);
}

/**
 * @returns {Promise<{type: string, path: string, id?: string, kind?: string, label?: string,
 * approvedScanRoots?: string[], excludedScanRoots?: string[], agentPath?: string,
 * usageLogPath?: string, dbFile?: string, reason?: string}>}
 */
export async function classifyImportDirectory(importPath, options = {}) {
  const resolved = path.resolve(importPath);
  if (options.ompExplicit) {
    const omp = await classifyOmpDirectory(resolved, options);
    return omp ?? { type: "unsupported", path: resolved, reason: "No Oh My Pi session logs found." };
  }
  if (await hermesHomeLooksUsable(resolved)) {
    return { type: "hermes-home", path: resolved, dbFile: await hermesDatabaseFile(resolved) };
  }
  // ZCode、DSH、OpenCode 与 Claude Code 的判据更具体，必须先于 Codex 判断。
  // codexHomeLooksUsable 只看「有没有 sessions 目录」，而 ~/.dsh/sessions 与 ~/.claude/sessions
  // 恰好同名，若先判 Codex，DSH/Claude home 会被误判成 codex-home。
  const zcodeDbFile = await zcodeDatabaseFile(resolved);
  if (zcodeDbFile) {
    return {
      type: "zcode-home",
      path: resolved,
      dbFile: zcodeDbFile,
    };
  }

  if (await dshHomeLooksUsable(resolved)) {
    return {
      type: "dsh-home",
      path: resolved,
    };
  }

  if (await opencodeHomeLooksUsable(resolved)) {
    return {
      type: "opencode-home",
      path: resolved,
    };
  }

  // WorkBuddy 必须判在 Claude Code **之前**：`~/.workbuddy-ai/projects/<slug>/*.jsonl` 会被
  // `claudeHomeLooksUsable` 的纯结构判据命中，靠内容（session-meta / function_call）才能区分。
  // 但也不能挪到 Codex 之前的最前面：ZCode/DSH/OpenCode 的判据更具体，保持现有相对次序。
  if (await workbuddyHomeLooksUsable(resolved)) {
    return {
      type: "workbuddy-home",
      path: resolved,
    };
  }

  if (await claudeHomeLooksUsable(resolved)) {
    return {
      type: "claude-home",
      path: resolved,
    };
  }

  const omp = await classifyOmpDirectory(resolved, options);
  if (omp) return omp;
  if (await codexHomeLooksUsable(resolved)) {
    return {
      type: "codex-home",
      path: resolved,
    };
  }

  const directUsageLogPath = path.join(resolved, PROJECT_USAGE_FILE);
  if (path.basename(resolved) === PROJECT_USAGE_DIR && (await exists(directUsageLogPath))) {
    return {
      type: "project-log",
      path: path.dirname(resolved),
      usageLogPath: directUsageLogPath,
    };
  }

  const usageLogPath = path.join(resolved, PROJECT_USAGE_DIR, PROJECT_USAGE_FILE);
  if (await exists(usageLogPath)) {
    return {
      type: "project-log",
      path: resolved,
      usageLogPath,
    };
  }

  return {
    type: "unsupported",
    path: resolved,
    reason: `目录需要是 Codex home、ZCode home、DSH home、OpenCode 数据目录、Claude Code home、WorkBuddy home、Oh My Pi 会话目录，或包含 ${PROJECT_USAGE_DIR}/${PROJECT_USAGE_FILE}`,
  };
}

function jetBrainsRoots({ homeDir, platform, env }) {
  const roots = [path.join(homeDir, "Library", "Caches", "JetBrains")];

  if (platform === "win32") {
    roots.push(
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "JetBrains") : "",
      env.APPDATA ? path.join(env.APPDATA, "JetBrains") : "",
      path.join(homeDir, "AppData", "Local", "JetBrains"),
      path.join(homeDir, "AppData", "Roaming", "JetBrains"),
    );
  }

  return uniquePaths(roots);
}

export async function discoverCodexHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || os.platform();
  const envHomes = options.extraHomes || env.CODEX_USAGE_HOMES || "";
  const homes = [];
  const seen = new Set();

  async function addHome(label, homePath, kind = "codex") {
    const resolved = path.resolve(homePath);
    options.sourceCandidates?.push(resolved);
    if (seen.has(resolved) || !(await codexHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    homes.push({
      id: sourceId(kind, resolved),
      label,
      path: resolved,
      kind,
    });
  }

  if (!options.onlyConfiguredSources) {
    await addHome("Main Codex", path.join(homeDir, ".codex"), "main");
    if (env.CODEX_HOME) await addHome("Codex", env.CODEX_HOME, "main");
  }

  for (const jetbrainsRoot of options.onlyConfiguredSources ? [] : jetBrainsRoots({ homeDir, platform, env })) {
    options.sourceCandidates?.push(path.resolve(jetbrainsRoot));
    if (!(await exists(jetbrainsRoot))) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(jetbrainsRoot, { withFileTypes: true });
    } catch (error) {
      if (!options.discoveryErrors) throw error;
      options.discoveryErrors.push({ path: jetbrainsRoot, code: error.code || "IMPORT_SCAN_FAILED" });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const productName = entry.name;
      await addHome(`JetBrains ${productName}`, path.join(jetbrainsRoot, productName, "aia", "codex"), "jetbrains");
    }
  }

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`Extra ${path.basename(extraHome)}`, extraHome, "extra");
  }

  return homes;
}

export async function discoverHermesHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const suffix = env.HERMES_DATA_DIR_SUFFIX || "";
  const root =
    platform === "win32"
      ? path.join(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), `hermes${suffix}`)
      : path.join(homeDir, `.hermes${suffix}`);
  const homes = [];
  const seen = new Set();
  const expandHome = (candidate) =>
    candidate
      .replace(/^~(?=$|[\\/])/, homeDir)
      .replace(
        /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([^%]+)%/g,
        (match, braced, plain, windows) => env[braced || plain || windows] ?? match,
      );
  const discoveryError = (error, candidate) => {
    const sourcePath = error.path || candidate;
    options.discoveryErrors?.push({ path: sourcePath, code: error.code || "IMPORT_SCAN_FAILED" });
    options.onWarning?.(`无法读取 ${sourcePath}: ${error.message}`);
  };
  async function addHome(candidate) {
    const resolved = path.resolve(expandHome(candidate));
    options.sourceCandidates?.push(resolved);
    try {
      if (!(await hermesHomeLooksUsable(resolved, { onError: (error) => discoveryError(error, resolved) }))) return;
      const identity = await importPathIdentity(resolved);
      if (seen.has(identity)) return;
      const usageLogPath = await hermesDatabaseFile(resolved);
      seen.add(identity);
      homes.push({
        id: sourceId("hermes", resolved),
        label: `Hermes ${path.basename(resolved)}`,
        path: resolved,
        kind: "hermes",
        usageLogPath,
      });
    } catch (error) {
      discoveryError(error, resolved);
    }
  }
  if (!options.onlyConfiguredSources && env.CODEX_USAGE_HERMES !== "0") {
    await addHome(root);
    if (env.HERMES_HOME) await addHome(env.HERMES_HOME);
    for (const profileRoot of new Set([root, env.HERMES_HOME].filter(Boolean))) {
      const directory = path.join(expandHome(profileRoot), "profiles");
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory() || entry.isSymbolicLink()) await addHome(path.join(directory, entry.name));
        }
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") discoveryError(error, directory);
      }
    }
  }
  for (const candidate of (options.extraHermesHomes || env.CODEX_USAGE_HERMES_HOMES || "")
    .split(path.delimiter)
    .filter(Boolean)) {
    await addHome(candidate);
  }
  return homes;
}

export async function discoverZcodeHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const envHomes = options.extraZcodeHomes || env.CODEX_USAGE_ZCODE_HOMES || "";
  const homes = [];
  const seen = new Set();

  if (env.CODEX_USAGE_ZCODE === "0") {
    return homes;
  }

  async function addHome(label, homePath) {
    const resolved = path.resolve(homePath);
    options.sourceCandidates?.push(resolved);
    if (seen.has(resolved)) {
      return;
    }
    const dbFile = await zcodeDatabaseFile(resolved);
    if (!dbFile) {
      return;
    }
    seen.add(resolved);
    homes.push({
      id: sourceId("zcode", resolved),
      label,
      path: resolved,
      kind: "zcode",
      usageLogPath: dbFile,
    });
  }

  if (!options.onlyConfiguredSources) await addHome("Main ZCode", path.join(homeDir, ".zcode"));

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`ZCode ${path.basename(extraHome) || extraHome}`, extraHome);
  }

  return homes;
}

export async function discoverDshHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const envHomes = options.extraDshHomes || env.CODEX_USAGE_DSH_HOMES || "";
  const homes = [];
  const seen = new Set();

  if (env.CODEX_USAGE_DSH === "0") {
    return homes;
  }

  async function addHome(label, homePath) {
    const resolved = path.resolve(homePath);
    options.sourceCandidates?.push(resolved);
    if (seen.has(resolved) || !(await dshHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    // DSH 的用量分散在 sessions/**/session.v*.jsonl.zstd 多个文件里，
    // 不像 ZCode 那样有单一数据库，所以这里不设 usageLogPath。
    homes.push({
      id: sourceId("dsh", resolved),
      label,
      path: resolved,
      kind: "dsh",
    });
  }

  if (!options.onlyConfiguredSources) await addHome("Main DSH", path.join(homeDir, ".dsh"));

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`DSH ${path.basename(extraHome) || extraHome}`, extraHome);
  }

  return homes;
}

function opencodeDataDirs({ homeDir, env }) {
  // OpenCode 数据目录因平台而异（Windows 本机实测为 XDG 风格路径），逐个探测。
  const dirs = [path.join(homeDir, ".local", "share", "opencode")];
  if (env.XDG_DATA_HOME) dirs.push(path.join(env.XDG_DATA_HOME, "opencode"));
  if (env.APPDATA) {
    dirs.push(path.join(env.APPDATA, "opencode"));
  }
  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, "opencode"));
  }
  dirs.push(path.join(homeDir, "Library", "Application Support", "opencode"));
  return uniquePaths(dirs.filter(Boolean));
}

export async function discoverOpencodeHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const envHomes = options.extraOpencodeHomes || env.CODEX_USAGE_OPENCODE_HOMES || "";
  const homes = [];
  const seen = new Set();

  if (env.CODEX_USAGE_OPENCODE === "0") {
    return homes;
  }

  async function addHome(label, homePath) {
    const resolved = path.resolve(homePath);
    options.sourceCandidates?.push(resolved);
    if (seen.has(resolved) || !(await opencodeHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    // 单个数据目录下可能有多个数据库（opencode.db、opencode-<channel>.db），
    // 用量在消费时按目录展开，所以这里不设 usageLogPath。
    homes.push({
      id: sourceId("opencode", resolved),
      label,
      path: resolved,
      kind: "opencode",
    });
  }

  for (const dataDir of options.onlyConfiguredSources ? [] : opencodeDataDirs({ homeDir, env })) {
    await addHome("Main OpenCode", dataDir);
  }

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`OpenCode ${path.basename(extraHome) || extraHome}`, extraHome);
  }

  return homes;
}

export async function discoverClaudeHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const envHomes = options.extraClaudeHomes || env.CODEX_USAGE_CLAUDE_HOMES || "";
  const homes = [];
  const seen = new Set();

  if (env.CODEX_USAGE_CLAUDE === "0") {
    return homes;
  }

  async function addHome(label, homePath) {
    const resolved = path.resolve(homePath);
    options.sourceCandidates?.push(resolved);
    if (seen.has(resolved) || !(await claudeHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    // 用量分散在 projects/**/*.jsonl（含 subagents），不像 ZCode 那样有单一数据库。
    homes.push({
      id: sourceId("claude", resolved),
      label,
      path: resolved,
      kind: "claude",
    });
  }

  if (!options.onlyConfiguredSources) await addHome("Main Claude Code", path.join(homeDir, ".claude"));
  // CLAUDE_CONFIG_DIR 是 Claude Code 自己的 home 覆盖变量，与默认位置并存时都要发现。
  if (!options.onlyConfiguredSources && env.CLAUDE_CONFIG_DIR) {
    await addHome(
      `Claude Code ${path.basename(env.CLAUDE_CONFIG_DIR) || env.CLAUDE_CONFIG_DIR}`,
      env.CLAUDE_CONFIG_DIR,
    );
  }

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`Claude Code ${path.basename(extraHome) || extraHome}`, extraHome);
  }

  return homes;
}

export async function discoverWorkbuddyHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const envHomes = options.extraWorkbuddyHomes || env.CODEX_USAGE_WORKBUDDY_HOMES || "";
  const homes = [];
  const seen = new Set();

  if (env.CODEX_USAGE_WORKBUDDY === "0") {
    return homes;
  }

  async function addHome(label, homePath) {
    const resolved = path.resolve(homePath);
    options.sourceCandidates?.push(resolved);
    if (seen.has(resolved) || !(await workbuddyHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    // 用量分散在 projects/**/*.jsonl（含按会话分目录的转录），不像 ZCode 那样有单一数据库。
    homes.push({
      id: sourceId("workbuddy", resolved),
      label,
      path: resolved,
      kind: "workbuddy",
    });
  }

  if (!options.onlyConfiguredSources) await addHome("Main WorkBuddy", path.join(homeDir, ".workbuddy-ai"));

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`WorkBuddy ${path.basename(extraHome) || extraHome}`, extraHome);
  }

  return homes;
}

export async function discoverUsageSources(options = {}) {
  if (Array.isArray(options.confirmedSources)) {
    const sources = [];
    for (const source of options.confirmedSources) {
      if (source.kind === "omp") {
        options.sourceCandidates?.push(...ompScanRoots(source));
        sources.push(source);
        continue;
      }
      options.sourceCandidates?.push(source.path);
      // Keep the persisted identity, including unavailable homes and historical aliases.
      // A known Codex home needs only its own probe, not every other parser's directory walk.
      if (source.kind === "hermes") {
        sources.push({ ...source, usageLogPath: path.join(source.path, "state.db") });
        continue;
      }
      if (source.kind === "zcode") {
        const usageLogPath = await zcodeDatabaseFile(source.path);
        if (usageLogPath) sources.push({ ...source, usageLogPath });
        continue;
      }
      if (source.kind === "project-log") {
        const usageLogPath = path.join(source.path, PROJECT_USAGE_DIR, PROJECT_USAGE_FILE);
        if (await exists(usageLogPath)) sources.push({ ...source, usageLogPath });
        continue;
      }
      const probe = {
        main: codexHomeLooksUsable,
        codex: codexHomeLooksUsable,
        extra: codexHomeLooksUsable,
        jetbrains: codexHomeLooksUsable,
        dsh: dshHomeLooksUsable,
        opencode: opencodeHomeLooksUsable,
        workbuddy: workbuddyHomeLooksUsable,
        claude: claudeHomeLooksUsable,
      }[source.kind];
      if (probe && (await probe(source.path))) sources.push({ ...source });
    }
    return sources;
  }
  const ompHomes = await discoverOmpHomes(options);
  const ompPaths = new Set(ompHomes.map(({ path }) => path));
  const sources = [...ompHomes, ...(await discoverCodexHomes(options)).filter((home) => !ompPaths.has(home.path))];
  const seenPaths = new Set(sources.map((source) => source.path));
  const seenHermesPaths = new Set();
  const seenProjectLogs = new Set();

  for (const home of await discoverHermesHomes(options)) {
    if (seenPaths.has(home.path)) continue;
    seenPaths.add(home.path);
    seenHermesPaths.add(await importPathIdentity(home.path));
    sources.push(home);
  }

  for (const zcodeHome of await discoverZcodeHomes(options)) {
    if (seenPaths.has(zcodeHome.path)) {
      continue;
    }
    seenPaths.add(zcodeHome.path);
    sources.push(zcodeHome);
  }

  for (const dshHome of await discoverDshHomes(options)) {
    if (seenPaths.has(dshHome.path)) {
      continue;
    }
    seenPaths.add(dshHome.path);
    sources.push(dshHome);
  }

  for (const opencodeHome of await discoverOpencodeHomes(options)) {
    if (seenPaths.has(opencodeHome.path)) {
      continue;
    }
    seenPaths.add(opencodeHome.path);
    sources.push(opencodeHome);
  }

  for (const claudeHome of await discoverClaudeHomes(options)) {
    if (seenPaths.has(claudeHome.path)) {
      continue;
    }
    seenPaths.add(claudeHome.path);
    sources.push(claudeHome);
  }

  for (const workbuddyHome of await discoverWorkbuddyHomes(options)) {
    if (seenPaths.has(workbuddyHome.path)) {
      continue;
    }
    seenPaths.add(workbuddyHome.path);
    sources.push(workbuddyHome);
  }

  for (const importDir of optionImportDirs(options)) {
    options.sourceCandidates?.push(path.resolve(importDir));
    let classified;
    try {
      classified = await classifyImportDirectory(importDir, options);
    } catch (error) {
      if (error.code !== "OMP_SOURCE_AMBIGUOUS") throw error;
      options.discoveryErrors?.push({ code: error.code, path: error.path });
      continue;
    }
    if (classified.type === "omp-home") {
      const { type: _type, ...home } = classified;
      addOmpHome(sources, { ...home, imported: true });
      continue;
    }
    if (classified.type === "codex-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("extra", classified.path),
        label: `Imported ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "extra",
        imported: true,
      });
      continue;
    }

    if (classified.type === "hermes-home") {
      if (seenPaths.has(classified.path)) continue;
      const identity = await importPathIdentity(classified.path);
      if (seenHermesPaths.has(identity)) continue;
      seenPaths.add(classified.path);
      seenHermesPaths.add(identity);
      sources.push({
        id: sourceId("hermes", classified.path),
        label: `Hermes ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "hermes",
        usageLogPath: classified.dbFile,
        imported: true,
      });
      continue;
    }

    if (classified.type === "zcode-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("zcode", classified.path),
        label: `ZCode ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "zcode",
        usageLogPath: classified.dbFile,
        imported: true,
      });
      continue;
    }

    if (classified.type === "dsh-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("dsh", classified.path),
        label: `DSH ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "dsh",
        imported: true,
      });
      continue;
    }

    if (classified.type === "opencode-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("opencode", classified.path),
        label: `OpenCode ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "opencode",
        imported: true,
      });
      continue;
    }

    if (classified.type === "claude-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("claude", classified.path),
        label: `Claude Code ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "claude",
        imported: true,
      });
      continue;
    }

    if (classified.type === "workbuddy-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("workbuddy", classified.path),
        label: `WorkBuddy ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "workbuddy",
        imported: true,
      });
      continue;
    }

    if (classified.type !== "project-log") {
      continue;
    }

    if (seenProjectLogs.has(classified.usageLogPath)) {
      continue;
    }
    seenProjectLogs.add(classified.usageLogPath);
    sources.push({
      id: sourceId("project-log", classified.usageLogPath),
      label: `Project ${path.basename(classified.path) || classified.path}`,
      path: classified.path,
      kind: "project-log",
      usageLogPath: classified.usageLogPath,
      imported: true,
    });
  }

  return sources;
}

async function walkJsonlFiles(root, files = []) {
  try {
    await stat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".tmp" || entry.name === "node_modules") {
        continue;
      }
      await walkJsonlFiles(fullPath, files);
    } else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function discoverSessionFiles(homePath) {
  const groups = await Promise.all(SESSION_DIRS.map((dir) => walkJsonlFiles(path.join(homePath, dir), [])));
  const files = groups.flat().sort();
  const key = (file) => (process.platform === "win32" ? file.toLowerCase() : file);
  const paths = new Set(files.map(key));
  return files.filter((file) => file === plainRolloutPath(file) || !paths.has(key(plainRolloutPath(file))));
}

export async function buildUsageFingerprint(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const hash = createHash("sha256");
  let fileCount = 0;
  const scannedByHome = new Map();
  for (const entry of options.scannedFiles || []) {
    const files = scannedByHome.get(entry.source.id) || [];
    files.push(entry);
    scannedByHome.set(entry.source.id, files);
  }
  const failedHomeIds = new Set((options.failedHomes || []).map((home) => home.id));

  async function addFile(filePath, info = null) {
    try {
      const details = info || (await stat(filePath));
      fileCount += 1;
      hash.update(`${filePath}\t${details.size}\t${details.mtimeMs}\n`);
      hash.update(
        `${details.dev ?? ""}\t${details.ino ?? ""}\t${details.birthtimeMs ?? ""}\t${details.ctimeMs ?? ""}\n`,
      );
      if (details.sqliteObservation) hash.update(`${details.sqliteObservation}\n`);
      if (details.contentDigest) hash.update(`${details.contentDigest}\n`);
    } catch (error) {
      hash.update(`${filePath}\t!${error.code || "unreadable"}\n`);
    }
  }

  for (const home of homes) {
    hash.update(`${home.id}\t${home.label}\t${home.path}\t${home.kind || ""}\t${home.usageLogPath || ""}\n`);
    if (home.kind === "omp") {
      hash.update(JSON.stringify([ompScanRoots(home), home.excludedScanRoots || [], home.agentPath || ""]));
    }
    if (Array.isArray(options.scannedFiles)) {
      for (const entry of scannedByHome.get(home.id) || []) await addFile(entry.filePath, entry.info);
      if (failedHomeIds.has(home.id)) hash.update("!scan-failed\n");
      continue;
    }
    if (home.kind === "project-log" && home.usageLogPath) {
      await addFile(home.usageLogPath);
      continue;
    }
    if (["zcode", "hermes"].includes(home.kind) && home.usageLogPath) {
      try {
        await addFile(
          home.usageLogPath,
          await (home.kind === "hermes" ? hermesSourceStat : zcodeSourceStat)(home.usageLogPath),
        );
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
      }
      continue;
    }
    if (home.kind === "dsh") {
      let sessionFiles;
      try {
        sessionFiles = await dshSessionFiles(home.path);
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
        continue;
      }
      for (const file of sessionFiles) await addFile(file);
      continue;
    }
    if (home.kind === "opencode") {
      // 单个数据目录下可能有多个数据库，逐个纳入指纹（含 -wal）。
      let dbFiles;
      try {
        dbFiles = await opencodeDatabaseFiles(home.path);
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
        continue;
      }
      for (const dbFile of dbFiles) {
        try {
          await addFile(dbFile, await opencodeSourceStat(dbFile));
        } catch (error) {
          hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
        }
      }
      continue;
    }
    if (home.kind === "claude") {
      let sessionFiles;
      try {
        sessionFiles = await claudeSessionFiles(home.path);
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
        continue;
      }
      for (const file of sessionFiles) await addFile(file);
      continue;
    }
    if (home.kind === "workbuddy") {
      let sessionFiles;
      try {
        sessionFiles = await workbuddySessionFiles(home.path);
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
        continue;
      }
      for (const file of sessionFiles) await addFile(file);
      continue;
    }
    if (home.kind === "omp") {
      try {
        for (const file of await ompSessionFiles(home)) await addFile(file);
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
      }
      continue;
    }
    let files;
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
      continue;
    }
    for (const file of files) await addFile(file);
  }
  return {
    fingerprint: hash.digest("hex"),
    fileCount,
    homeCount: homes.length,
    checkedAt: new Date().toISOString(),
  };
}

export function classifyChannel({ originator, source, homeLabel }) {
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const normalizedSource = normalize(source);
  const text = `${normalize(originator)} ${normalizedSource} ${normalize(homeLabel)}`;
  if (text.includes("jetbrains")) {
    return "JetBrains PyCharm";
  }
  if (text.includes("codex desktop")) {
    return "Codex Desktop";
  }
  if (normalizedSource === "cli" || text.includes("codex tui") || text.includes("codex cli")) {
    return "CLI";
  }
  if (normalizedSource === "exec" || text.includes("codex exec")) {
    return "Codex Exec";
  }
  if (normalizedSource === "vscode" || /(^|\s)(vscode|vs code)(\s|$)/.test(text) || text.includes("chrome extension")) {
    return "Editor Integration";
  }
  return originator || source || homeLabel || "Unknown";
}

function fallbackSessionId(filePath) {
  const base = path.basename(plainRolloutPath(filePath), ".jsonl");
  return base.replace(/^rollout-/, "") || filePath;
}

function readTokenUsage(payload, row = {}) {
  const info = payload?.info || {};
  const cumulativeRaw = info.total_token_usage;
  const lastRaw = info.last_token_usage;
  const cumulative = cumulativeRaw ? usageFromRaw(cumulativeRaw) : null;
  const last = lastRaw ? usageFromRaw(lastRaw) : null;
  return {
    cumulative,
    cumulativeMask: cumulativeRaw ? usageDetailMask(cumulativeRaw) : 0,
    cumulativeCacheWrite: readCacheWrite(cumulativeRaw),
    last,
    lastMask: lastRaw ? usageDetailMask(lastRaw) : 0,
    lastCacheWrite: readCacheWrite(lastRaw),
    serviceTier: readServiceTier(row, payload),
  };
}

function invalidRateLimitWarning(sourcePath, lineNumber, role, reason) {
  return `无法索引 Codex 限额观察值 ${sourcePath}:${lineNumber} (${role})：${reason}`;
}

/** @param {any} row @param {{ sourcePath?: string, lineNumber?: number, onWarning?: (warning: string) => void }} [options] */
export function parseRateLimitObservations(row, { sourcePath = "", lineNumber = 0, onWarning } = {}) {
  if (row?.type !== "event_msg" || row?.payload?.type !== "token_count" || !Object.hasOwn(row.payload, "rate_limits")) {
    return [];
  }
  const rateLimits = row.payload.rate_limits;
  if (rateLimits === null || rateLimits === undefined) return [];
  if (typeof rateLimits !== "object" || Array.isArray(rateLimits)) {
    onWarning?.(invalidRateLimitWarning(sourcePath, lineNumber, "primary/secondary", "rate_limits 格式无效"));
    return [];
  }
  const observedAtMs = Date.parse(row.timestamp || "");
  const observations = [];
  for (const role of ["primary", "secondary"]) {
    if (!Object.hasOwn(rateLimits, role) || rateLimits[role] === null || rateLimits[role] === undefined) continue;
    const raw = rateLimits[role];
    let reason = "";
    const rootLimitId = typeof rateLimits.limit_id === "string" ? rateLimits.limit_id.trim() : "";
    const windowLimitId = typeof raw?.limit_id === "string" ? raw.limit_id.trim() : "";
    const limitId = rootLimitId || windowLimitId;
    const windowMinutes =
      raw?.window_minutes === "" || raw?.window_minutes === null ? NaN : Number(raw?.window_minutes);
    const resetSeconds = raw?.resets_at === "" || raw?.resets_at === null ? NaN : Number(raw?.resets_at);
    const resetsAtMs = resetSeconds * 1000;
    const hasPercent =
      raw && Object.hasOwn(raw, "used_percent") && raw.used_percent !== null && raw.used_percent !== "";
    const usedPercent = hasPercent ? Number(raw.used_percent) : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) reason = "窗口数据格式无效";
    else if (!Number.isFinite(observedAtMs)) reason = "观察时间无效";
    else if (rootLimitId && windowLimitId && rootLimitId !== windowLimitId) reason = "顶层与窗口 limit_id 冲突";
    else if (!limitId) reason = "limit_id 为空";
    else if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) reason = "window_minutes 必须是正数";
    else if (
      !Number.isFinite(resetSeconds) ||
      resetSeconds <= 0 ||
      !Number.isFinite(resetsAtMs) ||
      Number.isNaN(new Date(resetsAtMs).getTime())
    )
      reason = "resets_at 无效";
    else if (hasPercent && (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100))
      reason = "used_percent 必须在 0 到 100 之间";
    if (reason) {
      onWarning?.(invalidRateLimitWarning(sourcePath, lineNumber, role, reason));
      continue;
    }
    observations.push({
      sourcePath,
      lineNumber,
      role,
      observedAtMs,
      limitId,
      limitName:
        typeof rateLimits.limit_name === "string"
          ? rateLimits.limit_name
          : typeof raw.limit_name === "string"
            ? raw.limit_name
            : null,
      planType:
        typeof rateLimits.plan_type === "string"
          ? rateLimits.plan_type
          : typeof raw.plan_type === "string"
            ? raw.plan_type
            : null,
      windowMinutes,
      resetsAtMs,
      usedPercent,
    });
  }
  return observations;
}

export async function parseSessionFile(filePath, home, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const threadNames = options.threadNames || new Map();
  const meta = {
    id: fallbackSessionId(filePath),
    source: "",
    originator: "",
    cwd: "",
    cliVersion: "",
    modelProvider: "",
  };
  let model = "";
  let firstAt = "";
  let lastAt = "";
  let previousCumulative = emptyUsage();
  /** @type {number} */
  let previousCumulativeMask = USAGE_DETAIL_MASK.complete;
  let previousCumulativeCacheWrite = { tokens: 0, known: false };
  let baselineLoaded = false;
  let hasUsageInFile = false;
  const finalUsage = emptyUsage();
  let tokenEventCount = 0;
  const events = [];
  const rateLimitObservations = [];

  // Stream JSONL rows so full-detail reports do not read large session files at once.
  const quotaSourceForRow = createQuotaSourceTracker();
  for await (const { row, lineNumber } of readJsonlRows(filePath, { withLineNumbers: true })) {
    const { quotaSource, quotaSourceUntil } = quotaSourceForRow(row);
    if (row.timestamp) {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }

    if (row.type === "session_meta") {
      meta.id = row.payload?.id || meta.id;
      meta.source = row.payload?.source || meta.source;
      meta.originator = row.payload?.originator || meta.originator;
      meta.cwd = row.payload?.cwd || meta.cwd;
      meta.cliVersion = row.payload?.cli_version || meta.cliVersion;
      meta.modelProvider = row.payload?.model_provider || meta.modelProvider;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      continue;
    }

    if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
      continue;
    }

    if (["plan", "credits"].includes(quotaSource))
      await options.onQuotaSource?.({
        homeId: home.homeId || home.id,
        sessionId: meta.id,
        timestampMs: Date.parse(row.timestamp),
        quotaSource,
        quotaSourceUntil,
      });
    const observations = parseRateLimitObservations(row, {
      sourcePath: filePath,
      lineNumber,
      onWarning: options.onWarning,
    });
    rateLimitObservations.push(...observations);
    for (const observation of observations) {
      await options.onRateLimit?.(observation);
    }

    if (!baselineLoaded && options.previousCumulativeForSession) {
      const baseline = await options.previousCumulativeForSession(meta.id, row.timestamp || lastAt);
      if (baseline) {
        previousCumulative = baseline.usage;
        previousCumulativeMask = baseline.detailMask;
        previousCumulativeCacheWrite = baseline.cacheWrite;
      }
      baselineLoaded = true;
    }
    const { cumulative, cumulativeMask, cumulativeCacheWrite, last, lastMask, lastCacheWrite, serviceTier } =
      readTokenUsage(row.payload, row);
    let increment = emptyUsage();
    let detailMask = 0;
    let cacheWrite = { tokens: 0, known: false };
    let lastMatchesDelta = false;
    if (cumulative) {
      const diff = diffUsage(cumulative, previousCumulative, cumulativeMask, previousCumulativeMask);
      const selected =
        initialRequestUsage(cumulative, cumulativeMask, last, lastMask, diff.usage, hasUsageInFile) || diff;
      increment = selected.usage;
      detailMask = selected.detailMask;
      lastMatchesDelta = Boolean(last && lastUsageMatchesDelta(last, lastMask, increment, detailMask));
      cacheWrite = cacheWriteForEvent({
        cumulative: cumulativeCacheWrite,
        previous: previousCumulativeCacheWrite,
        last: lastCacheWrite,
        lastMatches: lastMatchesDelta,
      });
      previousCumulative = cumulative;
      previousCumulativeMask = cumulativeMask;
      previousCumulativeCacheWrite = cumulativeCacheWrite;
    } else if (last) {
      increment = last;
      detailMask = lastMask;
      cacheWrite = lastCacheWrite;
    }
    if (!isZeroUsage(increment)) hasUsageInFile = true;
    addUsage(finalUsage, increment);
    const requestUsage = last && (!cumulative || lastMatchesDelta) ? last : null;
    const context = contextForEvent(
      Boolean(requestUsage),
      requestUsage || increment,
      requestUsage ? lastMask : detailMask,
    );

    if (isZeroUsage(increment)) {
      continue;
    }

    const timestamp = row.timestamp || lastAt || firstAt;
    if (!Number.isFinite(Date.parse(timestamp))) {
      continue;
    }

    tokenEventCount += 1;
    const channel = classifyChannel({
      originator: meta.originator,
      source: meta.source,
      homeLabel: home.homeLabel || home.label,
    });
    const repository = await resolveRepository(meta.cwd);
    const detailValidation = validateUsageDetails(increment, detailMask);
    events.push({
      id: `${meta.id}:${tokenEventCount}`,
      sessionId: meta.id,
      timestamp,
      homeId: home.homeId || home.id,
      homeLabel: home.homeLabel || home.label,
      homePath: home.homePath || home.path,
      channel,
      sourceKind: home.kind,
      source: meta.source,
      originator: meta.originator,
      cwd: meta.cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      conversationName: threadNames.get(meta.id) || "",
      model,
      total: increment,
      quotaSource,
      quotaSourceUntil,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier,
      priceVersion: "",
    });
  }

  if (!events.length && !rateLimitObservations.length) {
    return null;
  }

  const channel = classifyChannel({
    originator: meta.originator,
    source: meta.source,
    homeLabel: home.homeLabel || home.label,
  });

  return {
    session: events.length
      ? {
          id: meta.id,
          filePath,
          firstAt,
          lastAt,
          homeId: home.homeId || home.id,
          homeLabel: home.homeLabel || home.label,
          homePath: home.homePath || home.path,
          channel,
          source: meta.source,
          originator: meta.originator,
          cwd: meta.cwd,
          conversationName: threadNames.get(meta.id) || "",
          model,
          cliVersion: meta.cliVersion,
          modelProvider: meta.modelProvider,
          eventCount: events.length,
          total: finalUsage,
        }
      : null,
    events,
    rateLimitObservations,
  };
}

/**
 * @param {string} filePath
 * @param {{ withLineNumbers?: boolean, onMalformedLine?: (lineNumber: number) => void }} [options]
 */
async function* readJsonlRows(filePath, { withLineNumbers = false, onMalformedLine } = {}) {
  let lineNumber = 0;
  for await (const line of readRolloutLines(filePath)) {
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }
    try {
      const row = JSON.parse(line);
      yield withLineNumbers ? { row, lineNumber } : row;
    } catch {
      if (filePath.endsWith(".jsonl.zst")) throw new Error(`Invalid compressed rollout JSON at line ${lineNumber}`);
      // Other JSONL readers keep their existing silent-skip behavior.
      onMalformedLine?.(lineNumber);
    }
  }
}

export async function readSessionThreadNames(homePath) {
  const threadNames = new Map();
  const indexPath = path.join(homePath, "session_index.jsonl");
  if (!(await exists(indexPath))) {
    return threadNames;
  }
  try {
    for await (const row of readJsonlRows(indexPath)) {
      const id = String(row.id || "").trim();
      const name = String(row.thread_name || "").trim();
      if (id && name) {
        threadNames.set(id, name);
      }
    }
  } catch {
    // Thread names are optional metadata; usage aggregation must still work if the index is unreadable.
  }
  return threadNames;
}

function usageFromProjectLog(raw = {}) {
  const usage = raw || {};
  const input = Number(usage.input ?? usage.input_tokens ?? 0);
  const cached = Number(usage.cached ?? usage.cached_input_tokens ?? 0);
  const output = Number(usage.output ?? usage.output_tokens ?? 0);
  const reasoning = Number(usage.reasoning ?? usage.reasoning_output_tokens ?? 0);
  const total = Number(usage.total ?? usage.total_tokens ?? input + output);
  return { total, input, cached, output, reasoning };
}

function projectLogTimestamp(row) {
  return row.timestamp || row.created_at || row.createdAt || "";
}

function projectLogSource(row) {
  return row.source || "project-log";
}

function projectLogChannel(row) {
  if (row.channel) {
    return row.channel;
  }
  return projectLogSource(row) === "codex-oauth" ? "Codex OAuth" : "Project Log";
}

function projectLogUsage(row) {
  return usageFromProjectLog(row.usage || row.token_usage || row.total_token_usage || {});
}

function projectLogSessionId(row, source, rowNumber) {
  return row.session_id || row.sessionId || row.request_id || row.requestId || `${source.id}:${rowNumber}`;
}

function isSupportedProjectLogRow(row) {
  return !row.schema_version || row.schema_version === PROJECT_LOG_SCHEMA_VERSION;
}

async function parseProjectUsageLogFile(filePath, source, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const sessions = new Map();
  const events = [];
  let rowNumber = 0;

  for await (const row of readJsonlRows(filePath)) {
    rowNumber += 1;
    if (!isSupportedProjectLogRow(row)) {
      continue;
    }
    const timestamp = projectLogTimestamp(row);
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      continue;
    }
    const rawUsage = row.usage || row.token_usage || row.total_token_usage || {};
    const usage = projectLogUsage(row);
    const cacheWrite = readCacheWrite(rawUsage);
    const detailMask = projectLogDetailMask(rawUsage);
    const requestLinked = Boolean(row.request_id || row.requestId || row.response_id || row.responseId);
    const context = contextForEvent(requestLinked, usage, detailMask);
    if (isZeroUsage(usage)) {
      continue;
    }

    const sessionId = projectLogSessionId(row, source, rowNumber);
    const sourceName = projectLogSource(row);
    const channel = projectLogChannel(row);
    const cwd = row.cwd || row.project_root || row.projectRoot || source.path;
    const repository = await resolveRepository(cwd);
    const model = row.model || "Unknown model";
    const detailValidation = validateUsageDetails(usage, detailMask);
    const event = {
      id: row.event_id || row.eventId || row.request_id || row.requestId || `${sessionId}:${events.length + 1}`,
      sessionId,
      timestamp,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel,
      source: sourceName,
      originator: "",
      cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      model,
      total: usage,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier: readServiceTier(row, rawUsage),
      priceVersion: "",
    };
    events.push(event);

    const session = sessions.get(sessionId) || {
      id: sessionId,
      filePath,
      firstAt: timestamp,
      lastAt: timestamp,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel,
      source: sourceName,
      originator: "",
      cwd,
      model,
      cliVersion: "",
      modelProvider: "",
      eventCount: 0,
      total: emptyUsage(),
    };
    if (time < Date.parse(session.firstAt)) {
      session.firstAt = timestamp;
    }
    if (time > Date.parse(session.lastAt)) {
      session.lastAt = timestamp;
    }
    session.eventCount += 1;
    session.model = model;
    addUsage(session.total, usage);
    sessions.set(sessionId, session);
  }

  return {
    sessions: [...sessions.values()],
    events,
  };
}

function createStringInterner() {
  const values = [];
  const ids = new Map();
  return {
    values,
    intern(value) {
      const text = value || "";
      const existing = ids.get(text);
      if (existing !== undefined) {
        return existing;
      }
      const id = values.length;
      ids.set(text, id);
      values.push(text);
      return id;
    },
  };
}

async function streamSessionUsageFileEvents(filePath, home, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const compressed = filePath.endsWith(".jsonl.zst");
  const hasResume = Object.hasOwn(options, "resume");
  if (compressed && (hasResume || options.endOffset !== undefined)) {
    throw new SourceProgressUnsupportedError("Compressed Codex JSONL sources do not support byte progress.");
  }
  const resume = hasResume ? assertCodexJsonlCheckpoint(options.resume) : null;
  if (
    options.endOffset !== undefined &&
    (!Number.isSafeInteger(options.endOffset) || options.endOffset < (resume?.offset || 0))
  ) {
    throw new SourceProgressUnsupportedError("Codex JSONL progress endOffset is invalid.");
  }

  const saved = resume?.state;
  const meta = {
    id: saved?.meta.id || fallbackSessionId(filePath),
    source: saved?.meta.source || "",
    originator: saved?.meta.originator || "",
    cwd: saved?.meta.cwd || "",
  };
  let model = saved?.model || "";
  let firstAt = saved?.firstAt || "";
  let lastAt = saved?.lastAt || "";
  let previousCumulative = saved?.previousCumulative ? { ...saved.previousCumulative } : emptyUsage();
  /** @type {number} */
  let previousCumulativeMask = saved?.previousCumulativeMask ?? USAGE_DETAIL_MASK.complete;
  let previousCumulativeCacheWrite = saved?.previousCumulativeCacheWrite
    ? { ...saved.previousCumulativeCacheWrite }
    : { tokens: 0, known: false };
  let baselineLoaded = saved?.baselineLoaded || false;
  let hasUsageInFile = saved?.hasUsageInFile || false;
  let checkpointOffset = resume?.offset || 0;
  let checkpointLineNumber = resume?.lineNumber || 0;
  let consumedUnterminatedRow = false;

  const quotaSourceForRow = createQuotaSourceTracker(saved?.quota);
  const useProgressReader = !compressed && (hasResume || options.endOffset !== undefined || options.onProgress);
  const rows = useProgressReader
    ? readCodexJsonlProgressRows(filePath, {
        offset: resume?.offset || 0,
        lineNumber: resume?.lineNumber || 0,
        endOffset: options.endOffset,
        onSourceBytes: options.onSourceBytes,
      })
    : readJsonlRows(filePath, { withLineNumbers: true });

  for await (const entry of /** @type {AsyncIterable<{ row: any, lineNumber: number, parsed?: boolean, complete?: boolean, offset?: number }>} */ (
    rows
  )) {
    const { row, lineNumber } = entry;
    if (useProgressReader) {
      if (entry.complete) {
        checkpointOffset = entry.offset;
        checkpointLineNumber = lineNumber;
      } else if (entry.parsed) {
        consumedUnterminatedRow = true;
      }
    }
    if (entry.parsed === false) continue;
    const { quotaSource, quotaSourceUntil } = quotaSourceForRow(row);
    if (row.timestamp) {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }

    if (row.type === "session_meta") {
      meta.id = row.payload?.id || meta.id;
      meta.source = row.payload?.source || meta.source;
      meta.originator = row.payload?.originator || meta.originator;
      meta.cwd = row.payload?.cwd || meta.cwd;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      continue;
    }

    if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
      continue;
    }

    if (["plan", "credits"].includes(quotaSource))
      await options.onQuotaSource?.({
        homeId: home.homeId || home.id,
        sessionId: meta.id,
        timestampMs: Date.parse(row.timestamp),
        quotaSource,
        quotaSourceUntil,
      });
    for (const observation of parseRateLimitObservations(row, {
      sourcePath: filePath,
      lineNumber,
      onWarning: options.onWarning,
    })) {
      await options.onRateLimit?.(observation);
    }

    if (!baselineLoaded && options.previousCumulativeForSession) {
      const baseline = await options.previousCumulativeForSession(meta.id, row.timestamp || lastAt);
      if (baseline) {
        previousCumulative = baseline.usage;
        previousCumulativeMask = baseline.detailMask;
        previousCumulativeCacheWrite = baseline.cacheWrite;
      }
      baselineLoaded = true;
    }
    const { cumulative, cumulativeMask, cumulativeCacheWrite, last, lastMask, lastCacheWrite, serviceTier } =
      readTokenUsage(row.payload, row);
    let increment = emptyUsage();
    let detailMask = 0;
    let cacheWrite = { tokens: 0, known: false };
    let lastMatchesDelta = false;
    if (cumulative) {
      const diff = diffUsage(cumulative, previousCumulative, cumulativeMask, previousCumulativeMask);
      const selected =
        initialRequestUsage(cumulative, cumulativeMask, last, lastMask, diff.usage, hasUsageInFile) || diff;
      increment = selected.usage;
      detailMask = selected.detailMask;
      lastMatchesDelta = Boolean(last && lastUsageMatchesDelta(last, lastMask, increment, detailMask));
      cacheWrite = cacheWriteForEvent({
        cumulative: cumulativeCacheWrite,
        previous: previousCumulativeCacheWrite,
        last: lastCacheWrite,
        lastMatches: lastMatchesDelta,
      });
      previousCumulative = cumulative;
      previousCumulativeMask = cumulativeMask;
      previousCumulativeCacheWrite = cumulativeCacheWrite;
    } else if (last) {
      increment = last;
      detailMask = lastMask;
      cacheWrite = lastCacheWrite;
    }
    if (!isZeroUsage(increment)) hasUsageInFile = true;
    const requestUsage = last && (!cumulative || lastMatchesDelta) ? last : null;
    const context = contextForEvent(
      Boolean(requestUsage),
      requestUsage || increment,
      requestUsage ? lastMask : detailMask,
    );

    if (isZeroUsage(increment)) {
      continue;
    }

    const channel = classifyChannel({
      originator: meta.originator,
      source: meta.source,
      homeLabel: home.homeLabel || home.label,
    });
    const timestamp = row.timestamp || lastAt || firstAt;
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    const repository = await resolveRepository(meta.cwd);
    const detailValidation = validateUsageDetails(increment, detailMask);
    await onEvent({
      timestampMs,
      sessionId: meta.id,
      homeId: home.homeId || home.id,
      homeLabel: home.homeLabel || home.label,
      channel,
      sourceKind: home.kind,
      project: meta.cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      model,
      usage: increment,
      quotaSource,
      quotaSourceUntil,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier,
      priceVersion: "",
    });
  }

  if (compressed) {
    await options.onProgress?.(null);
    return;
  }
  if (typeof options.onProgress === "function") {
    let checkpoint = null;
    if (!consumedUnterminatedRow) {
      const candidate = {
        format: CODEX_JSONL_PROGRESS_FORMAT,
        adapter: CODEX_JSONL_PROGRESS_ADAPTER,
        offset: checkpointOffset,
        lineNumber: checkpointLineNumber,
        state: {
          meta: { ...meta },
          model,
          previousCumulative: { ...previousCumulative },
          previousCumulativeMask,
          previousCumulativeCacheWrite: { ...previousCumulativeCacheWrite },
          baselineLoaded,
          hasUsageInFile,
          firstAt,
          lastAt,
          quota: quotaSourceForRow.snapshot(),
        },
      };
      try {
        checkpoint = assertCodexJsonlCheckpoint(candidate);
      } catch (error) {
        if (!(error instanceof SourceProgressUnsupportedError)) throw error;
      }
    }
    await options.onProgress(checkpoint);
  }
}

async function streamProjectUsageFileEvents(filePath, source, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  let rowNumber = 0;

  for await (const row of readJsonlRows(filePath, {
    onMalformedLine: (lineNumber) => {
      options.onWarning?.(`project-log 来源存在无法解析的 JSONL 行：${filePath}（第 ${lineNumber} 行）`, {
        lineNumber,
      });
    },
  })) {
    rowNumber += 1;
    if (!isSupportedProjectLogRow(row)) {
      continue;
    }
    const timestamp = projectLogTimestamp(row);
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      continue;
    }
    const rawUsage = row.usage || row.token_usage || row.total_token_usage || {};
    const usage = projectLogUsage(row);
    const cacheWrite = readCacheWrite(rawUsage);
    const detailMask = projectLogDetailMask(rawUsage);
    const requestLinked = Boolean(row.request_id || row.requestId || row.response_id || row.responseId);
    const context = contextForEvent(requestLinked, usage, detailMask);
    if (isZeroUsage(usage)) {
      continue;
    }

    const cwd = row.cwd || row.project_root || row.projectRoot || source.path;
    const repository = await resolveRepository(cwd);
    const detailValidation = validateUsageDetails(usage, detailMask);
    await onEvent({
      timestampMs: time,
      sessionId: projectLogSessionId(row, source, rowNumber),
      homeId: source.id,
      homeLabel: source.label,
      channel: projectLogChannel(row),
      project: cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      model: row.model || "Unknown model",
      usage,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier: readServiceTier(row, row),
      priceVersion: "",
    });
  }
}

export async function streamUsageFileEvents(filePath, source, onEvent, options = {}) {
  if (source.kind === "omp") {
    return readOmpSnapshot(filePath, source, { ...options, onEvent });
  }
  if (source.kind === "hermes") {
    await streamHermesDbEvents(filePath, source, onEvent, options);
    return;
  }
  if (source.kind === "project-log") {
    await streamProjectUsageFileEvents(filePath, source, onEvent, options);
    return;
  }
  if (source.kind === "zcode") {
    await streamZcodeDbEvents(filePath, source, onEvent, options);
    return;
  }
  if (source.kind === "dsh") {
    await streamDshSessionEvents(filePath, source, onEvent, options);
    return;
  }
  if (source.kind === "opencode") {
    await streamOpencodeDbEvents(filePath, source, onEvent, options);
    return;
  }
  if (source.kind === "claude") {
    await streamClaudeSessionEvents(filePath, source, onEvent, options);
    return;
  }
  if (source.kind === "workbuddy") {
    await streamWorkbuddySessionEvents(filePath, source, onEvent, options);
    return;
  }
  await streamSessionUsageFileEvents(filePath, source, onEvent, options);
}

async function readOmpEvents(home, repositoryResolver, warnings) {
  const occurrences = [];
  let files;
  try {
    files = await ompSessionFiles(home);
  } catch (error) {
    warnings.push(`Oh My Pi: ${error.code || "OMP_SCAN_FAILED"}`);
    return [];
  }
  for (const filePath of files) {
    const snapshot = await readOmpSnapshot(filePath, home, {
      repositoryResolver,
      onEvent: (event) => occurrences.push(event),
    });
    for (const [code, count] of Object.entries(snapshot.diagnostics)) {
      warnings.push(`Oh My Pi: ${code} (${count})`);
    }
  }
  const events = [];
  for (const group of groupOmpOccurrences(occurrences)) {
    const { winner, conflict } = chooseOmpOccurrence(group);
    if (winner) events.push(winner);
    if (conflict) warnings.push("Oh My Pi: OMP_CALL_CONFLICT");
  }
  return events;
}

async function parseSessionFileForIndex(
  filePath,
  home,
  intern,
  resolveRepository,
  previousCumulativeForSession,
  onRateLimit,
  onWarning,
  onQuotaSource,
) {
  const events = [];
  await streamSessionUsageFileEvents(
    filePath,
    home,
    (event) => {
      events.push({
        t: event.timestampMs,
        s: intern(event.sessionId),
        h: intern(event.homeId),
        l: intern(event.homeLabel),
        c: intern(event.channel),
        p: intern(event.project),
        rk: intern(event.repositoryKey),
        rp: intern(event.repositoryPath),
        rt: intern(event.repositoryKind),
        m: intern(event.model),
        quotaSource: event.quotaSource || "unknown",
        quotaSourceUntil: event.quotaSourceUntil || 0,
        total: event.usage.total,
        input: event.usage.input,
        cached: event.usage.cached,
        output: event.usage.output,
        reasoning: event.usage.reasoning,
        detailMask: event.detailMask,
        reconciliationGap: event.reconciliationGap,
        cacheWriteTokens: event.cacheWriteTokens,
        cacheWriteKnown: event.cacheWriteKnown,
        requestInputTokens: event.requestInputTokens,
        contextLevel: intern(event.contextLevel),
        serviceTier: intern(event.serviceTier),
        priceVersion: intern(event.priceVersion),
      });
    },
    { repositoryResolver: resolveRepository, previousCumulativeForSession, onRateLimit, onWarning, onQuotaSource },
  );
  return events;
}

async function parseProjectUsageLogFileForIndex(filePath, source, intern, resolveRepository) {
  const events = [];
  await streamProjectUsageFileEvents(
    filePath,
    source,
    (event) => {
      events.push({
        t: event.timestampMs,
        s: intern(event.sessionId),
        h: intern(event.homeId),
        l: intern(event.homeLabel),
        c: intern(event.channel),
        p: intern(event.project),
        rk: intern(event.repositoryKey),
        rp: intern(event.repositoryPath),
        rt: intern(event.repositoryKind),
        m: intern(event.model),
        total: event.usage.total,
        input: event.usage.input,
        cached: event.usage.cached,
        output: event.usage.output,
        reasoning: event.usage.reasoning,
        detailMask: event.detailMask,
        reconciliationGap: event.reconciliationGap,
        cacheWriteTokens: event.cacheWriteTokens,
        cacheWriteKnown: event.cacheWriteKnown,
        requestInputTokens: event.requestInputTokens,
        contextLevel: intern(event.contextLevel),
        serviceTier: intern(event.serviceTier),
        priceVersion: intern(event.priceVersion),
      });
    },
    { repositoryResolver: resolveRepository },
  );
  return events;
}

async function parseClaudeForIndex(filePath, source, intern, resolveRepository, onWarning) {
  const events = [];
  await streamClaudeSessionEvents(
    filePath,
    source,
    (event) => {
      events.push({
        t: event.timestampMs,
        s: intern(event.sessionId),
        h: intern(event.homeId),
        l: intern(event.homeLabel),
        c: intern(event.channel),
        p: intern(event.project),
        rk: intern(event.repositoryKey),
        rp: intern(event.repositoryPath),
        rt: intern(event.repositoryKind),
        m: intern(event.model),
        total: event.usage.total,
        input: event.usage.input,
        cached: event.usage.cached,
        output: event.usage.output,
        reasoning: event.usage.reasoning,
        detailMask: event.detailMask,
        reconciliationGap: event.reconciliationGap,
        cacheWriteTokens: event.cacheWriteTokens,
        cacheWriteKnown: event.cacheWriteKnown,
        requestInputTokens: event.requestInputTokens,
        contextLevel: intern(event.contextLevel),
        serviceTier: intern(event.serviceTier),
        priceVersion: intern(event.priceVersion),
      });
    },
    { repositoryResolver: resolveRepository, onWarning },
  );
  return events;
}

async function parseWorkbuddyForIndex(filePath, source, intern, resolveRepository, onWarning) {
  const events = [];
  await streamWorkbuddySessionEvents(
    filePath,
    source,
    (event) => {
      events.push({
        t: event.timestampMs,
        s: intern(event.sessionId),
        h: intern(event.homeId),
        l: intern(event.homeLabel),
        c: intern(event.channel),
        p: intern(event.project),
        rk: intern(event.repositoryKey),
        rp: intern(event.repositoryPath),
        rt: intern(event.repositoryKind),
        m: intern(event.model),
        total: event.usage.total,
        input: event.usage.input,
        cached: event.usage.cached,
        output: event.usage.output,
        reasoning: event.usage.reasoning,
        detailMask: event.detailMask,
        reconciliationGap: event.reconciliationGap,
        cacheWriteTokens: event.cacheWriteTokens,
        cacheWriteKnown: event.cacheWriteKnown,
        requestInputTokens: event.requestInputTokens,
        contextLevel: intern(event.contextLevel),
        serviceTier: intern(event.serviceTier),
        priceVersion: intern(event.priceVersion),
      });
    },
    { repositoryResolver: resolveRepository, onWarning },
  );
  return events;
}

async function parseZcodeDbForIndex(dbFile, source, intern, resolveRepository, onWarning) {
  const events = [];
  await (source.kind === "hermes" ? streamHermesDbEvents : streamZcodeDbEvents)(
    dbFile,
    source,
    (event) => events.push(compactStreamEvent(event, intern)),
    { repositoryResolver: resolveRepository, onWarning },
  );
  return events;
}

function compactStreamEvent(event, intern) {
  return {
    t: event.timestampMs,
    s: intern(event.sessionId),
    h: intern(event.homeId),
    l: intern(event.homeLabel),
    c: intern(event.channel),
    p: intern(event.project),
    rk: intern(event.repositoryKey),
    rp: intern(event.repositoryPath),
    rt: intern(event.repositoryKind),
    m: intern(event.model),
    total: event.usage.total,
    input: event.usage.input,
    cached: event.usage.cached,
    output: event.usage.output,
    reasoning: event.usage.reasoning,
    detailMask: event.detailMask,
    reconciliationGap: event.reconciliationGap,
    cacheWriteTokens: event.cacheWriteTokens,
    cacheWriteKnown: event.cacheWriteKnown,
    requestInputTokens: event.requestInputTokens,
    contextLevel: intern(event.contextLevel),
    serviceTier: intern(event.serviceTier),
    priceVersion: intern(event.priceVersion),
  };
}

/** 把一个 DSH home 下所有会话日志摊平成索引事件。 */
async function parseDshForIndex(homePath, source, intern, resolveRepository, onWarning) {
  const events = [];
  let sessionFiles = [];
  try {
    sessionFiles = await dshSessionFiles(homePath);
  } catch (error) {
    onWarning?.(`无法读取 ${homePath}: ${error.message}`);
    return events;
  }

  for (const filePath of sessionFiles) {
    try {
      await streamDshSessionEvents(
        filePath,
        source,
        (event) => {
          events.push({
            t: event.timestampMs,
            s: intern(event.sessionId),
            h: intern(event.homeId),
            l: intern(event.homeLabel),
            c: intern(event.channel),
            p: intern(event.project),
            rk: intern(event.repositoryKey),
            rp: intern(event.repositoryPath),
            rt: intern(event.repositoryKind),
            m: intern(event.model),
            total: event.usage.total,
            input: event.usage.input,
            cached: event.usage.cached,
            output: event.usage.output,
            reasoning: event.usage.reasoning,
            detailMask: event.detailMask,
            reconciliationGap: event.reconciliationGap,
            cacheWriteTokens: event.cacheWriteTokens,
            cacheWriteKnown: event.cacheWriteKnown,
            requestInputTokens: event.requestInputTokens,
            contextLevel: intern(event.contextLevel),
            serviceTier: intern(event.serviceTier),
            priceVersion: event.priceVersion,
          });
        },
        { repositoryResolver: resolveRepository, onWarning },
      );
    } catch (error) {
      onWarning?.(`无法解析 ${filePath}: ${error.message}`);
    }
  }
  return events;
}

/** 把一个 OpenCode 数据库的用量摊平成索引事件。 */
async function parseOpencodeDbForIndex(dbFile, source, intern, resolveRepository, onWarning) {
  const events = [];
  await streamOpencodeDbEvents(
    dbFile,
    source,
    (event) => {
      events.push({
        t: event.timestampMs,
        s: intern(event.sessionId),
        h: intern(event.homeId),
        l: intern(event.homeLabel),
        c: intern(event.channel),
        p: intern(event.project),
        rk: intern(event.repositoryKey),
        rp: intern(event.repositoryPath),
        rt: intern(event.repositoryKind),
        m: intern(event.model),
        total: event.usage.total,
        input: event.usage.input,
        cached: event.usage.cached,
        output: event.usage.output,
        reasoning: event.usage.reasoning,
        detailMask: event.detailMask,
        reconciliationGap: event.reconciliationGap,
        cacheWriteTokens: event.cacheWriteTokens,
        cacheWriteKnown: event.cacheWriteKnown,
        requestInputTokens: event.requestInputTokens,
        contextLevel: intern(event.contextLevel),
        serviceTier: intern(event.serviceTier),
        priceVersion: event.priceVersion,
      });
    },
    { repositoryResolver: resolveRepository, onWarning },
  );
  return events;
}

/** Project the public usage report fields. */
export function toPublicUsageReport(report) {
  if (!report || typeof report !== "object") {
    return report;
  }
  return {
    events: report.events,
    generatedAt: report.generatedAt,
    homes: report.homes,
    rateLimitObservations: report.rateLimitObservations,
    sessions: report.sessions,
    warnings: report.warnings,
  };
}

/** @returns {Promise<import("./usage-types.js").UsageReport>} */
export async function buildUsageReport(options = {}, { createEventDecorator = null } = {}) {
  const warnings = [];
  const homes =
    options.homes || (await discoverUsageSources({ ...options, onWarning: (warning) => warnings.push(warning) }));
  const repositoryResolver = createSourceRepositoryResolver(homes);
  const sessions = [];
  const events = [];
  const rateLimitObservations = [];
  const quotaSourceObservations = [];

  for (const home of homes) {
    if (home.kind === "omp") {
      if (options.skipOmpRead) continue;
      const occurrences = await readOmpEvents(home, repositoryResolver, warnings);
      const parsed = await parseSqliteUsageDb(
        async (_file, _source, onEvent) => {
          for (const occurrence of occurrences) await onEvent(occurrence);
        },
        home.path,
        home,
      );
      sessions.push(...parsed.sessions);
      events.push(...parsed.events);
      continue;
    }
    if (home.kind === "project-log" && home.usageLogPath) {
      try {
        const parsed = await parseProjectUsageLogFile(home.usageLogPath, home, { repositoryResolver });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    if ((home.kind === "zcode" || home.kind === "hermes") && home.usageLogPath) {
      try {
        const parsed =
          home.kind === "hermes"
            ? await parseSqliteUsageDb(streamHermesDbEvents, home.usageLogPath, home, {
                repositoryResolver,
                onWarning: (warning) => warnings.push(warning),
              })
            : await parseZcodeDb(home.usageLogPath, home, { repositoryResolver });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    if (home.kind === "dsh") {
      try {
        const parsed = await parseDshSessions(home.path, home, {
          repositoryResolver,
          onWarning: (warning) => warnings.push(warning),
        });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.path}: ${error.message}`);
      }
      continue;
    }

    if (home.kind === "opencode") {
      for (const dbFile of await opencodeDatabaseFiles(home.path)) {
        try {
          const parsed = await parseOpencodeDb(dbFile, home, {
            repositoryResolver,
            onWarning: (warning) => warnings.push(warning),
          });
          sessions.push(...parsed.sessions);
          events.push(...parsed.events);
        } catch (error) {
          warnings.push(`无法解析 ${dbFile}: ${error.message}`);
        }
      }
      continue;
    }

    if (home.kind === "claude") {
      try {
        const parsed = await parseClaudeSessions(home.path, home, {
          repositoryResolver,
          onWarning: (warning) => warnings.push(warning),
        });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.path}: ${error.message}`);
      }
      continue;
    }

    if (home.kind === "workbuddy") {
      // ⚠️ 报告路径的事件形状与 store 路径**不同**：这里的 `total` 是**用量对象**（与
      // parseClaudeSessions 同形），不是标量 —— 直接把流事件塞进 `events` 会让
      // `summarizeUsage` 读不到 `event.total.total`。因此复用 `parseWorkbuddySessions` 的投影。
      try {
        const parsed = await parseWorkbuddySessions(home.path, home, {
          repositoryResolver,
          onWarning: (warning) => warnings.push(warning),
        });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.path}: ${error.message}`);
      }
      continue;
    }

    const threadNames = await readSessionThreadNames(home.path);
    const previousBySession = new Map();
    let files = [];
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
        const parsed = await parseSessionFile(file, home, {
          repositoryResolver,
          threadNames,
          previousCumulativeForSession: (sessionId) => previousBySession.get(sessionId),
          onWarning: (warning) => warnings.push(warning),
          onQuotaSource: (row) => quotaSourceObservations.push(row),
        });
        if (!parsed) {
          continue;
        }
        if (parsed.session) sessions.push(parsed.session);
        events.push(...parsed.events);
        rateLimitObservations.push(...parsed.rateLimitObservations);
        for (const event of parsed.events) {
          rememberSessionUsage(
            previousBySession,
            event.sessionId,
            event.total,
            event.detailMask,
            event.cacheWriteTokens,
            event.cacheWriteKnown,
          );
        }
      } catch (error) {
        warnings.push(`无法解析 ${file}: ${error.message}`);
      }
    }
  }

  rateLimitObservations.push(...readCodexQuotaObservations({ ...options, homes }));
  const decorateEvent = createEventDecorator?.(homes);
  const quotaEvidence = loadQuotaSourceEvidence(homes, options.quotaSourceEvidenceSnapshot);
  const resolveQuotaSource = quotaSourceResolver([...events, ...quotaSourceObservations], quotaEvidence);
  for (const event of events) {
    decorateEvent?.(event);
    if (event.sourceKind === "omp") continue;
    event.quotaSource = resolveQuotaSource(
      event.homeId,
      event.sessionId,
      Date.parse(event.timestamp),
      event.quotaSource,
    );
  }
  events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  sessions.sort((a, b) => Date.parse(a.lastAt) - Date.parse(b.lastAt));

  return {
    generatedAt: new Date().toISOString(),
    homes,
    sessions,
    events,
    rateLimitObservations,
    warnings,
  };
}

export async function buildUsageIndex(options = {}, { createEventDecorator = null } = {}) {
  const warnings = [];
  const homes =
    options.homes || (await discoverUsageSources({ ...options, onWarning: (warning) => warnings.push(warning) }));
  const repositoryResolver = createSourceRepositoryResolver(homes);
  const events = [];
  const rateLimitObservations = [];
  const quotaSourceObservations = [];
  const interner = createStringInterner();

  for (const home of homes) {
    if (home.kind === "omp") {
      for (const occurrence of await readOmpEvents(home, repositoryResolver, warnings)) {
        events.push(compactStreamEvent(occurrence, interner.intern));
      }
      continue;
    }
    if (home.kind === "project-log" && home.usageLogPath) {
      try {
        events.push(
          ...(await parseProjectUsageLogFileForIndex(home.usageLogPath, home, interner.intern, repositoryResolver)),
        );
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    if ((home.kind === "zcode" || home.kind === "hermes") && home.usageLogPath) {
      try {
        events.push(
          ...(await parseZcodeDbForIndex(home.usageLogPath, home, interner.intern, repositoryResolver, (warning) =>
            warnings.push(warning),
          )),
        );
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    if (home.kind === "dsh") {
      events.push(
        ...(await parseDshForIndex(home.path, home, interner.intern, repositoryResolver, (warning) =>
          warnings.push(warning),
        )),
      );
      continue;
    }

    if (home.kind === "opencode") {
      for (const dbFile of await opencodeDatabaseFiles(home.path)) {
        try {
          events.push(
            ...(await parseOpencodeDbForIndex(dbFile, home, interner.intern, repositoryResolver, (warning) =>
              warnings.push(warning),
            )),
          );
        } catch (error) {
          warnings.push(`无法解析 ${dbFile}: ${error.message}`);
        }
      }
      continue;
    }

    if (home.kind === "claude") {
      for (const filePath of await claudeSessionFiles(home.path)) {
        try {
          events.push(
            ...(await parseClaudeForIndex(filePath, home, interner.intern, repositoryResolver, (warning) =>
              warnings.push(warning),
            )),
          );
        } catch (error) {
          warnings.push(`无法解析 ${filePath}: ${error.message}`);
        }
      }
      continue;
    }

    if (home.kind === "workbuddy") {
      for (const filePath of await workbuddySessionFiles(home.path)) {
        try {
          events.push(
            ...(await parseWorkbuddyForIndex(filePath, home, interner.intern, repositoryResolver, (warning) =>
              warnings.push(warning),
            )),
          );
        } catch (error) {
          warnings.push(`无法解析 ${filePath}: ${error.message}`);
        }
      }
      continue;
    }

    const previousBySession = new Map();
    let files = [];
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
        const parsed = await parseSessionFileForIndex(
          file,
          home,
          interner.intern,
          repositoryResolver,
          (sessionId) => previousBySession.get(sessionId),
          (observation) => rateLimitObservations.push(observation),
          (warning) => warnings.push(warning),
          (row) => quotaSourceObservations.push(row),
        );
        events.push(...parsed);
        for (const event of parsed) {
          rememberSessionUsage(
            previousBySession,
            interner.values[event.s],
            event,
            event.detailMask,
            event.cacheWriteTokens,
            event.cacheWriteKnown,
          );
        }
      } catch (error) {
        warnings.push(`无法解析 ${file}: ${error.message}`);
      }
    }
  }

  rateLimitObservations.push(...readCodexQuotaObservations({ ...options, homes }));
  const decorateEvent = createEventDecorator?.(homes);
  const quotaEvidence = loadQuotaSourceEvidence(homes, options.quotaSourceEvidenceSnapshot);
  const resolveQuotaSource = quotaSourceResolver(
    [
      ...quotaSourceObservations,
      ...events.map((event) => ({
        homeId: interner.values[event.h],
        sessionId: interner.values[event.s],
        timestampMs: event.t,
        quotaSource: event.quotaSource,
        quotaSourceUntil: event.quotaSourceUntil,
      })),
    ],
    quotaEvidence,
  );
  const kindsByHome = homeSourceKinds(homes);
  for (const event of events) {
    const sourceKind = kindsByHome.get(String(interner.values[event.h]));
    if (decorateEvent) {
      const raw = {
        sourceKind,
        sessionId: interner.values[event.s],
        timestampMs: event.t,
        serviceTier: interner.values[event.serviceTier],
      };
      decorateEvent(raw);
      event.serviceTier = interner.intern(raw.serviceTier);
    }
    if (sourceKind === "omp") continue;
    event.quotaSource = resolveQuotaSource(
      interner.values[event.h],
      interner.values[event.s],
      event.t,
      event.quotaSource,
    );
  }
  events.sort((a, b) => a.t - b.t);

  return {
    generatedAt: new Date().toISOString(),
    homes,
    warnings,
    strings: interner.values,
    events,
    rateLimitObservations,
    sessionCount: new Set(events.map((event) => JSON.stringify([event.h, event.s]))).size,
  };
}
