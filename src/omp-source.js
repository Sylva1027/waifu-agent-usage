import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { sourceId } from "./usage-sources.js";

const sessions = "sessions";
const archive = path.join("archive", sessions);
const missing = (error) => ["ENOENT", "ENOTDIR"].includes(error.code);
const same = (a, b) => path.relative(a, b) === "";
const within = (file, dir) => {
  const relative = path.relative(dir, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const profileName = (name) =>
  /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) &&
  name !== "default" &&
  !name.endsWith(".") &&
  !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
const eligibleFile = (name) => !name.startsWith(".") && /\.jsonl(?:\.gz)?$/.test(name);
const eligibleDir = (name) =>
  !name.startsWith(".") && !["node_modules", "blobs", "tool-results", "backups"].includes(name) && !/\.(?:bak|tmp)$/.test(name);

async function directory(dir) {
  try {
    return (await lstat(dir)).isDirectory() && same(await realpath(dir), dir);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

function configuredRoots(options) {
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const config = path.join(home, env.PI_CONFIG_DIR || ".omp");
  const xdg = ["linux", "darwin"].includes(options.platform || process.platform)
    ? path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "omp")
    : null;
  const profile = (env.OMP_PROFILE ?? env.PI_PROFILE ?? "").trim();
  const profiles = [config, xdg].filter(Boolean).map((root) => path.join(root, "profiles"));
  const agentDirs = [path.join(home, ".omp", "agent"), path.join(config, "agent"), xdg];
  if (profileName(profile)) {
    agentDirs.push(path.join(config, "profiles", profile, "agent"));
    if (xdg) agentDirs.push(path.join(xdg, "profiles", profile));
  }
  return { agentDirs: [...new Set(agentDirs.filter(Boolean))], profiles, config, xdg };
}

function minimalRoots(roots) {
  const sorted = [...new Set(roots.map((root) => path.resolve(root)))].sort();
  return sorted.filter((root, index) => !sorted.some((other, j) => j !== index && within(root, other) && (!same(root, other) || j < index)));
}

export function ompScanRoots(home) {
  return Array.isArray(home.approvedScanRoots) ? minimalRoots(home.approvedScanRoots) : [];
}

export function mergeOmpScopes(existing, added) {
  return { ...existing, approvedScanRoots: minimalRoots([...ompScanRoots(existing), ...ompScanRoots(added)]) };
}

export function ompFileIsArchived(filePath, home) {
  return filePath.endsWith(".jsonl.gz") || within(filePath, path.join(home.path, archive)) ||
    ompScanRoots(home).some((root) => within(filePath, root) && root.split(path.sep).some(
      (part, i, parts) => part === "archive" && parts[i + 1] === sessions,
    ));
}

async function* walk(root, budget = null, recursive = true) {
  if (budget && --budget.directories < 0) return;
  if (!(await directory(root))) return;
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isFile() && eligibleFile(entry.name)) {
      if (budget && --budget.files < 0) return;
      yield path.join(root, entry.name);
    }
  }
  if (recursive) {
    for (const entry of entries) {
      if (budget && (budget.directories <= 0 || budget.files <= 0)) return;
      if (entry.isDirectory() && eligibleDir(entry.name)) yield* walk(path.join(root, entry.name), budget);
    }
  }
}

/** The parser verifies the header and the opened file's identity before publishing. */
export async function ompSessionFiles(home) {
  const files = [];
  const seen = new Set();
  for (const root of ompScanRoots(home)) {
    for await (const file of walk(root)) {
      const info = await lstat(file, { bigint: true });
      if (!info.isFile()) continue;
      if (info.nlink > 1n && info.ino) {
        const identity = `${info.dev}/${info.ino}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
      }
      files.push(file);
    }
  }
  return files.sort();
}

// A plain session header is shared with Pi. Only OMP-specific records or an
// identified OMP installation let a manual directory be attributed automatically.
async function probeFile(file) {
  if (!same(file, await realpath(file))) return null;
  const input = createReadStream(file, { highWaterMark: 16 * 1024 });
  const stream = file.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  if (stream !== input) input.on("error", (error) => stream.destroy(error));
  try {
    const chunks = [];
    let bytes = 0;
    const limit = 64 * 1024;
    for await (const chunk of stream) {
      chunks.push(chunk.subarray(0, limit - bytes));
      bytes += chunks.at(-1).length;
      if (bytes === limit) break;
    }
    let header = false;
    let slot = false;
    for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { break; }
      if (!row || typeof row !== "object") break;
      if (!header) {
        if (!slot && row.type === "title" && row.v === 1) { slot = true; continue; }
        if (row.type !== "session" || typeof row.id !== "string" || !row.id) break;
        header = true;
        if (slot || Object.hasOwn(row, "providerPromptCacheKey") || Object.hasOwn(row, "previousSessionFiles")) return "omp";
      } else if (row.type === "model_usage") return "omp";
    }
    return header ? "pi" : null;
  } catch (error) {
    if (file.endsWith(".gz") && ["Z_DATA_ERROR", "Z_BUF_ERROR"].includes(error.code)) return null;
    throw error;
  } finally {
    stream.destroy();
    input.destroy();
  }
}

function fromSessions(dir) {
  const parent = path.dirname(dir);
  const sessionRoot = path.basename(dir) === sessions ? dir : path.basename(parent) === sessions ? parent : null;
  if (!sessionRoot) return null;
  const root = path.dirname(sessionRoot);
  return path.basename(root) === "archive" ? path.dirname(root) : root;
}

function knownAgent(agent, options, configured) {
  if (configured.agentDirs.some((dir) => same(agent, dir))) return true;
  if (options.confirmedSources?.some((home) => home.kind === "omp" && same(agent, home.path))) return true;
  const base = path.basename(agent) === "agent" ? path.dirname(agent) : agent;
  return configured.profiles.some((root) => same(root, path.dirname(base)) && profileName(path.basename(base)));
}

function describe(agent, roots) {
  const profileRoot = path.basename(agent) === "agent" ? path.dirname(agent) : agent;
  const label = path.basename(path.dirname(profileRoot)) === "profiles" ? `Oh My Pi · ${path.basename(profileRoot)}` : "Oh My Pi";
  return { type: "omp-home", kind: "omp", id: sourceId("omp", agent), path: agent, label, approvedScanRoots: minimalRoots(roots) };
}

async function agentLayout(agent) {
  const roots = [path.join(agent, sessions), path.join(agent, archive)];
  return (await directory(roots[0])) || (await directory(roots[1])) ? describe(agent, roots) : null;
}

export async function classifyOmpDirectory(directoryPath, options = {}) {
  const requested = path.resolve(directoryPath);
  let selected;
  try { selected = await realpath(requested); } catch (error) { if (missing(error)) return null; throw error; }
  if (!(await directory(selected))) return null;
  const configured = configuredRoots(options);
  const from = fromSessions(selected);
  const child = path.join(selected, "agent");
  let layout = null;
  if (from) layout = describe(from, [selected]);
  else {
    if (knownAgent(child, options, configured) || (await directory(child))) layout = await agentLayout(child);
    layout ||= await agentLayout(selected);
    if (!layout && knownAgent(selected, options, configured)) return null;
  }
  if (layout && knownAgent(layout.path, options, configured)) return layout;
  const explicit = options.ompExplicit === true;
  const roots = layout ? ompScanRoots(layout) : [selected];
  const budget = { directories: 40, files: 8 };
  let compatible = false;
  for (const root of roots) {
    for await (const file of walk(root, budget, Boolean(layout) || explicit || options.ompSessionDir === true)) {
      const signature = await probeFile(file);
      if (signature === "omp" || (signature && explicit)) return layout || describe(selected, [selected]);
      if (signature) compatible = true;
    }
  }
  if (compatible) throw Object.assign(new Error("Confirm this Pi-compatible source as Oh My Pi."), {
    code: "OMP_SOURCE_AMBIGUOUS", statusCode: 400, path: requested,
  });
  return null;
}

export async function discoverOmpHomes(options = {}) {
  const env = options.env || process.env;
  if (env.CODEX_USAGE_OMP === "0") return [];
  const configured = configuredRoots(options);
  const homes = new Map();
  const report = (error, dir) => {
    if (missing(error) || error.code === "OMP_SOURCE_AMBIGUOUS") return;
    options.discoveryErrors?.push({ path: dir, code: error.code || "IMPORT_SCAN_FAILED" });
    options.onWarning?.(`Oh My Pi: ${dir} (${error.code || "IMPORT_SCAN_FAILED"})`);
  };
  async function add(dir, extra = {}) {
    if (!dir) return;
    try {
      const home = await classifyOmpDirectory(dir, { ...options, ...extra });
      if (home) {
        const existing = homes.get(home.id);
        homes.set(home.id, existing ? mergeOmpScopes(existing, home) : home);
      }
    } catch (error) { report(error, dir); }
  }
  if (!options.onlyConfiguredSources) {
    for (const agent of configured.agentDirs) await add(agent);
    for (const root of configured.profiles) {
      try {
        if (!(await directory(root))) continue;
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && profileName(entry.name))
            await add(root === path.join(configured.config, "profiles") ? path.join(root, entry.name, "agent") : path.join(root, entry.name));
        }
      } catch (error) { report(error, root); }
    }
    await add(env.PI_CODING_AGENT_DIR);
    await add(env.PI_CODING_AGENT_SESSION_DIR, { ompSessionDir: true });
  }
  const explicit = options.extraOmpHomes || env.CODEX_USAGE_OMP_HOMES || "";
  for (const dir of explicit.split(path.delimiter).filter(Boolean)) await add(dir, { ompExplicit: true });
  return [...homes.values()].sort((a,b) => a.path.localeCompare(b.path));
}
