import { readFileSync, realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export function normalizeDirectoryPath(value, platform = process.platform) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const windowsStyle =
    /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw) || (platform === "win32" && !raw.startsWith("/"));
  const pathApi = windowsStyle ? path.win32 : path.posix;
  const normalized = pathApi.normalize(windowsStyle ? raw.replace(/\//g, "\\") : raw);
  const root = pathApi.parse(normalized).root;
  const withoutTrailingSeparator = normalized !== root ? normalized.replace(/[\\/]+$/, "") : normalized;
  return windowsStyle ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

export function pathApiFor(value, platform = process.platform) {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || (platform === "win32" && !value.startsWith("/"))
    ? path.win32
    : path.posix;
}

function makeIdentity(kind, directory, cwd, platform) {
  const keyPath = normalizeDirectoryPath(directory, platform);
  const label = directory || cwd || "Unknown cwd";
  return {
    key: directory ? `${kind}:${keyPath}` : "unknown:cwd",
    path: label,
    kind: directory ? kind : "unknown",
  };
}

function createResolver(platform, resolveGit) {
  const cache = new Map();

  async function resolveUncached(cwd) {
    const pathApi = pathApiFor(cwd, platform);
    const canResolveOnHost = platform === process.platform && !(platform === "win32" && pathApi === path.posix);
    let current = pathApi.normalize(cwd);

    // Canonicalize existing paths to merge symlink aliases. Keep lexical paths when
    // a historical working directory has since been removed.
    if (canResolveOnHost) {
      try {
        current = await realpath(current);
      } catch {
        // Continue with the recorded path and try its parents.
      }
    }

    let candidate = current;
    while (candidate) {
      if (canResolveOnHost) {
        try {
          const entry = await stat(pathApi.join(candidate, ".git"));
          let root = candidate;
          try {
            root = await realpath(candidate);
          } catch {
            // The lexical root remains usable for historical or inaccessible paths.
          }
          return resolveGit(makeIdentity("git", root, cwd, platform), entry.isDirectory());
        } catch {
          // A .git entry can be either a directory or a worktree pointer file.
        }
      }
      const parent = pathApi.dirname(candidate);
      if (parent === candidate) {
        break;
      }
      candidate = parent;
    }

    return makeIdentity("directory", current, cwd, platform);
  }

  return async function resolveRepository(cwdValue) {
    const cwd = String(cwdValue || "").trim();
    if (!cwd) {
      return makeIdentity("unknown", "", "", platform);
    }
    const cacheKey = normalizeDirectoryPath(cwd, platform);
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, resolveUncached(cwd));
    }
    return cache.get(cacheKey);
  };
}

export const COMMON_REPOSITORY_IDENTITY_VERSION = "git-common-v1";

function commonGitEvidence(root, isDirectory) {
  try {
    const entry = path.join(root, ".git");
    let gitDirectory = entry;
    if (!isDirectory) {
      const pointer = readFileSync(entry, "utf8")
        .trim()
        .match(/^gitdir:\s*(.+)$/i);
      if (!pointer) return null;
      gitDirectory = path.resolve(root, pointer[1]);
    }
    gitDirectory = realpathSync.native(gitDirectory);
    let commonDirectory = gitDirectory;
    try {
      const relative = readFileSync(path.join(gitDirectory, "commondir"), "utf8").trim();
      if (!relative) return null;
      commonDirectory = path.resolve(gitDirectory, relative);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    commonDirectory = realpathSync.native(commonDirectory);
    if (!statSync(commonDirectory).isDirectory()) return null;
    return { version: COMMON_REPOSITORY_IDENTITY_VERSION, gitDirectory, commonDirectory };
  } catch {
    return null;
  }
}

export function linkedWorktreeMain(root) {
  const evidence = commonGitEvidence(root, false);
  // A submodule or separate Git directory doesn't identify its main checkout by its parent.
  return evidence &&
    evidence.gitDirectory !== evidence.commonDirectory &&
    path.basename(evidence.commonDirectory) === ".git"
    ? path.dirname(evidence.commonDirectory)
    : null;
}

export function createRepositoryResolver({ platform = process.platform } = {}) {
  return createResolver(platform, (checkout, isDirectory) => {
    const main = isDirectory ? null : linkedWorktreeMain(checkout.path);
    return main ? makeIdentity("git", main, checkout.path, platform) : checkout;
  });
}

/** Achievement alias records keep their original checkout keys. */
export function createCommonRepositoryResolver({ platform = process.platform } = {}) {
  const resolve = createResolver(platform, (checkout, isDirectory) => {
    const evidence = commonGitEvidence(checkout.path, isDirectory);
    if (!evidence) return checkout;
    return {
      ...checkout,
      commonKey: `git-common:${normalizeDirectoryPath(evidence.commonDirectory, platform)}`,
      evidence,
    };
  });
  return async (cwd) => ({ commonKey: null, ...(await resolve(cwd)) });
}
