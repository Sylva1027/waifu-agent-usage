import { readFile, realpath, stat } from "node:fs/promises";
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

function pathApiFor(value, platform) {
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

export function createRepositoryResolver({ platform = process.platform } = {}) {
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
          await stat(pathApi.join(candidate, ".git"));
          let root = candidate;
          try {
            root = await realpath(candidate);
          } catch {
            // The lexical root remains usable for historical or inaccessible paths.
          }
          return makeIdentity("git", root, cwd, platform);
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

/** Add proven worktree membership without changing the dashboard's existing repository key. */
export function createCommonRepositoryResolver({ platform = process.platform } = {}) {
  const resolve = createRepositoryResolver({ platform });
  return async (cwd) => {
    const repository = await resolve(cwd);
    if (repository.kind !== "git" || platform !== process.platform) return { ...repository, commonKey: null };
    try {
      const entry = path.join(repository.path, ".git");
      const info = await stat(entry);
      let gitDirectory = entry;
      if (!info.isDirectory()) {
        const pointer = (await readFile(entry, "utf8")).trim().match(/^gitdir:\s*(.+)$/i);
        if (!pointer) return { ...repository, commonKey: null };
        gitDirectory = path.resolve(repository.path, pointer[1]);
      }
      gitDirectory = await realpath(gitDirectory);
      let commonDirectory = gitDirectory;
      try {
        const relative = (await readFile(path.join(gitDirectory, "commondir"), "utf8")).trim();
        if (!relative) return { ...repository, commonKey: null };
        commonDirectory = path.resolve(gitDirectory, relative);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      commonDirectory = await realpath(commonDirectory);
      if (!(await stat(commonDirectory)).isDirectory()) return { ...repository, commonKey: null };
      return {
        ...repository,
        commonKey: `git-common:${normalizeDirectoryPath(commonDirectory, platform)}`,
        evidence: { version: COMMON_REPOSITORY_IDENTITY_VERSION, gitDirectory, commonDirectory },
      };
    } catch {
      // Historical paths may be gone; the achievement archive can retain earlier proven aliases.
      return { ...repository, commonKey: null };
    }
  };
}
