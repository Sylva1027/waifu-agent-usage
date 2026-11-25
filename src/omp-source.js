import { lstat, open, readdir, realpath } from "node:fs/promises";
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
  !name.startsWith(".") &&
  !["node_modules", "blobs", "tool-results", "backups"].includes(name) &&
  !/\.(?:bak|tmp)$/.test(name);

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
  return sorted.filter(
    (root, index) =>
      !sorted.some((other, j) => j !== index && within(root, other) && (!same(root, other) || j < index)),
  );
}

export function ompScanRoots(home) {
  return Array.isArray(home.approvedScanRoots) ? minimalRoots(home.approvedScanRoots) : [];
}

export function validOmpGrant(home) {
  const logical = home.agentPath ?? home.path;
  const absolute = (value) => typeof value === "string" && path.isAbsolute(value);
  return (
    absolute(logical) &&
    within(home.path, logical) &&
    Array.isArray(home.approvedScanRoots) &&
    home.approvedScanRoots.length > 0 &&
    home.approvedScanRoots.every((root) => absolute(root) && within(root, logical)) &&
    (home.excludedScanRoots === undefined ||
      (Array.isArray(home.excludedScanRoots) &&
        home.excludedScanRoots.every((dir) => absolute(dir) && within(dir, logical))))
  );
}

export async function ompWatchRoots(home) {
  const roots = [];
  for (const root of ompScanRoots(home)) {
    const excluded = home.excludedScanRoots || [];
    if (excluded.some((dir) => within(root, dir))) continue;
    if (await directory(root).catch(() => false))
      roots.push({ path: root, recursive: !excluded.some((dir) => within(dir, root)) });
  }
  return roots;
}

export function mergeOmpScopes(existing, added) {
  return { ...existing, approvedScanRoots: minimalRoots([...ompScanRoots(existing), ...ompScanRoots(added)]) };
}

/** Keep a confirmed owner's identity when a wider grant proves that folders overlap. */
export function addOmpHome(homes, incoming) {
  const logical = incoming.agentPath || incoming.path;
  const roots = ompScanRoots(incoming);
  const known = homes.filter((home) => home.kind === "omp");
  const owners = known.filter(
    (home) =>
      home.id === incoming.id ||
      same(home.agentPath || home.path, logical) ||
      ompScanRoots(home).some((prior) =>
        roots.some(
          (root) =>
            (within(prior, root) || within(root, prior)) &&
            !(home.excludedScanRoots || []).some((excluded) => within(root, excluded)),
        ),
      ),
  );
  const primary = owners.find((home) => home.id === incoming.id) || owners[0];
  if (!primary) {
    homes.push(incoming);
    return incoming;
  }
  const merged = mergeOmpScopes(primary, incoming);
  const oldLogical = primary.agentPath || primary.path;
  if (!same(primary.path, logical) && within(oldLogical, logical)) merged.agentPath = logical;
  const reserved = owners
    .filter((home) => home !== primary)
    .flatMap(ompScanRoots)
    .filter((root) => merged.approvedScanRoots.some((allowed) => within(root, allowed)));
  const excluded = minimalRoots([
    ...(primary.excludedScanRoots || []),
    ...(incoming.excludedScanRoots || []),
    ...reserved,
  ]);
  if (excluded.length) merged.excludedScanRoots = excluded;
  return Object.assign(primary, merged);
}

export function ompFileIsArchived(filePath, home) {
  return (
    filePath.endsWith(".jsonl.gz") ||
    within(filePath, path.join(home.agentPath || home.path, archive)) ||
    ompScanRoots(home).some(
      (root) =>
        within(filePath, root) &&
        root.split(path.sep).some((part, i, parts) => part === "archive" && parts[i + 1] === sessions),
    )
  );
}

async function* walk(root, budget = null, depth = Infinity, excluded = []) {
  if (excluded.some((dir) => within(root, dir))) return;
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
  if (depth > 0) {
    for (const entry of entries) {
      if (budget && (budget.directories <= 0 || budget.files <= 0)) return;
      if (entry.isDirectory() && eligibleDir(entry.name))
        yield* walk(path.join(root, entry.name), budget, depth - 1, excluded);
    }
  }
}

/** The parser verifies the header and the opened file's identity before publishing. */
export async function ompSessionFiles(home) {
  const files = [];
  const seen = new Set();
  for (const root of ompScanRoots(home)) {
    for await (const file of walk(root, null, Infinity, home.excludedScanRoots || [])) {
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
async function probeFile(file, explicit) {
  if (!same(file, await realpath(file))) return null;
  const handle = await open(file, "r");
  try {
    const [before, current, resolved] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(file, { bigint: true }),
      realpath(file),
    ]);
    if (
      !before.isFile() ||
      !current.isFile() ||
      !same(file, resolved) ||
      before.dev !== current.dev ||
      before.ino !== current.ino
    )
      return null;
    return await probeHeader(handle, file, explicit);
  } finally {
    await handle.close();
  }
}

async function probeHeader(handle, file, explicit) {
  const input = handle.createReadStream({ highWaterMark: 16 * 1024, autoClose: false });
  const stream = file.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  if (stream !== input) input.on("error", (error) => stream.destroy(error));
  try {
    const chunks = [];
    let bytes = 0;
    const limit = explicit ? 16 * 1024 * 1024 + 256 : 64 * 1024;
    let newlines = 0;
    for await (const chunk of stream) {
      chunks.push(chunk.subarray(0, limit - bytes));
      bytes += chunks.at(-1).length;
      if (explicit) {
        for (let i = chunk.indexOf(10); i >= 0 && newlines < 2; i = chunk.indexOf(10, i + 1)) newlines++;
      }
      if (bytes === limit || newlines >= 2) break;
    }
    let header = false;
    let slot = false;
    for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        break;
      }
      if (!row || typeof row !== "object") break;
      if (!header) {
        if (!slot && row.type === "title" && row.v === 1) {
          slot = true;
          continue;
        }
        if (row.type !== "session" || typeof row.id !== "string" || !row.id) break;
        header = true;
        if (slot || Object.hasOwn(row, "providerPromptCacheKey") || Object.hasOwn(row, "previousSessionFiles"))
          return "omp";
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
  if (options.confirmedSources?.some((home) => home.kind === "omp" && same(agent, home.agentPath || home.path)))
    return true;
  const defaultConfig = path.join(options.homeDir || os.homedir(), ".omp");
  if (same(agent, path.join(defaultConfig, "agent")) || (configured.xdg && same(agent, configured.xdg))) return true;
  if (path.basename(agent) === "agent") {
    const parent = path.dirname(agent);
    if (path.basename(parent) === ".omp") return true;
    if (
      profileName(path.basename(parent)) &&
      path.basename(path.dirname(parent)) === "profiles" &&
      path.basename(path.dirname(path.dirname(parent))) === ".omp"
    )
      return true;
  }
  const base = path.basename(agent) === "agent" ? path.dirname(agent) : agent;
  return [defaultConfig, configured.xdg]
    .filter(Boolean)
    .some((root) => same(path.join(root, "profiles"), path.dirname(base)) && profileName(path.basename(base)));
}

function describe(agent, roots) {
  const profileRoot = path.basename(agent) === "agent" ? path.dirname(agent) : agent;
  const label =
    path.basename(path.dirname(profileRoot)) === "profiles" ? `Oh My Pi · ${path.basename(profileRoot)}` : "Oh My Pi";
  return {
    type: "omp-home",
    kind: "omp",
    id: sourceId("omp", agent),
    path: agent,
    label,
    approvedScanRoots: minimalRoots(roots),
  };
}

/** A full agent import selects both current and future active/archive directories. */
export function ompSelectionPaths(home) {
  const roots = ompScanRoots(home);
  const logical = home.agentPath || home.path;
  return roots.length === 2 &&
    [sessions, archive].every((sub) => roots.some((root) => same(root, path.join(logical, sub))))
    ? [logical]
    : roots;
}

async function agentLayout(agent) {
  const roots = [path.join(agent, sessions), path.join(agent, archive)];
  return (await directory(roots[0])) || (await directory(roots[1])) ? describe(agent, roots) : null;
}

export async function classifyOmpDirectory(directoryPath, options = {}) {
  const requested = path.resolve(directoryPath);
  let selected;
  try {
    selected = await realpath(requested);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (!(await directory(selected))) return null;
  // E.g. macOS /var/folders and /private/var/folders designate the same temp home.
  if (options.homeDir)
    options = {
      ...options,
      homeDir: await realpath(options.homeDir).catch((error) => {
        if (missing(error)) return options.homeDir;
        throw error;
      }),
    };
  const configured = configuredRoots(options);
  const from = fromSessions(selected);
  const existing = options.confirmedSources?.find(
    (home) =>
      home.kind === "omp" &&
      ompScanRoots(home).some((root) => within(selected, root)) &&
      !(home.excludedScanRoots || []).some((root) => within(selected, root)),
  );
  if (existing)
    return {
      ...describe(existing.path, [selected]),
      id: existing.id,
      ...(existing.agentPath ? { agentPath: existing.agentPath } : {}),
    };
  for (const home of options.confirmedSources || []) {
    const reserved = home.kind === "omp" && home.excludedScanRoots?.find((root) => within(selected, root));
    if (reserved) return describe(reserved, [selected]);
  }
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
  // A copied project beneath an unrelated directory named "sessions" is not evidence
  // that its parent owns *other* projects. Keep that selection's independent identity.
  const envAgent = (options.env || process.env).PI_CODING_AGENT_DIR;
  const standalone = from && path.basename(from) !== "agent" && !(envAgent && same(from, envAgent));
  const candidate = !layout || standalone ? describe(selected, [selected]) : layout;
  const budget = explicit ? null : { directories: 40, files: 8 };
  let compatible = false;
  for (const root of roots) {
    for await (const file of walk(root, budget, layout || explicit || options.ompSessionDir ? Infinity : 1)) {
      const signature = await probeFile(file, explicit);
      if (signature === "omp" || (signature && explicit)) return candidate;
      if (signature) compatible = true;
    }
  }
  if (compatible)
    throw Object.assign(new Error("Confirm this Pi-compatible source as Oh My Pi."), {
      code: "OMP_SOURCE_AMBIGUOUS",
      statusCode: 400,
      path: requested,
      ompCandidate: candidate,
    });
  return null;
}

export async function discoverOmpHomes(options = {}) {
  const env = options.env || process.env;
  if (env.CODEX_USAGE_OMP === "0") return [];
  const configured = configuredRoots(options);
  const homes = [];
  const report = (error, dir) => {
    if (missing(error) || error.code === "OMP_SOURCE_AMBIGUOUS") return;
    options.discoveryErrors?.push({ path: dir, code: error.code || "IMPORT_SCAN_FAILED" });
    options.onWarning?.(`Oh My Pi: ${dir} (${error.code || "IMPORT_SCAN_FAILED"})`);
  };
  async function add(dir, extra = {}) {
    if (!dir) return;
    options.sourceCandidates?.push(path.resolve(dir));
    try {
      const home = await classifyOmpDirectory(dir, { ...options, ...extra });
      if (home) addOmpHome(homes, home);
    } catch (error) {
      if (
        options.ompCandidates &&
        error.code === "OMP_SOURCE_AMBIGUOUS" &&
        !homes.some((home) => home.id === error.ompCandidate.id)
      )
        addOmpHome(homes, { ...error.ompCandidate, needsOmpConfirmation: true });
      else report(error, dir);
    }
  }
  if (!options.onlyConfiguredSources) {
    for (const agent of configured.agentDirs) await add(agent);
    for (const root of configured.profiles) {
      options.sourceCandidates?.push(root);
      try {
        if (!(await directory(root))) continue;
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && profileName(entry.name))
            await add(
              root === path.join(configured.config, "profiles")
                ? path.join(root, entry.name, "agent")
                : path.join(root, entry.name),
            );
        }
      } catch (error) {
        report(error, root);
      }
    }
    await add(env.PI_CODING_AGENT_DIR);
    await add(env.PI_CODING_AGENT_SESSION_DIR, { ompSessionDir: true });
  }
  const explicit = options.extraOmpHomes || env.CODEX_USAGE_OMP_HOMES || "";
  for (const dir of explicit.split(path.delimiter).filter(Boolean)) await add(dir, { ompExplicit: true });
  return homes.sort((a, b) => a.path.localeCompare(b.path));
}
