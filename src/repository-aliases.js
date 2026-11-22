import path from "node:path";
import { readCodexHomeWorktreeRoots } from "./codex-worktree-roots.js";
import {
  createRepositoryResolver,
  linkedWorktreeMain,
  normalizeDirectoryPath,
  pathApiFor,
} from "./repository-identity.js";

// Raw indexes and verified archive segments retain the identity recorded at import.
// Resolve those keys before grouping so DISTINCT cwd and session counts stay exact.
export function createRepositoryAliases(
  homes = [],
  database = null,
  attachmentRoots = readCodexHomeWorktreeRoots(homes),
) {
  const roots = new Map(attachmentRoots);

  const cache = new Map();
  function resolve(key) {
    if (!key || key.includes("\0")) return null;
    if (cache.has(key)) return cache.get(key);
    let source = "";
    if (key.startsWith("git:")) {
      const root = key.slice(4);
      if (
        database &&
        !roots.has(root) &&
        path.isAbsolute(root) &&
        !(process.platform === "win32" && root.startsWith("/"))
      ) {
        const main = linkedWorktreeMain(root);
        if (main) roots.set(root, main);
      }
      source = roots.get(root);
    } else if (roots.size && key.startsWith("directory:")) {
      let root = key.slice(10);
      const paths = pathApiFor(root);
      while (root && !roots.has(root)) {
        const parent = paths.dirname(root);
        if (parent === root) break;
        root = parent;
      }
      source = roots.get(root);
    }
    const seen = new Set();
    let canonical = normalizeDirectoryPath(source);
    while (canonical && roots.has(canonical) && !seen.has(canonical)) {
      seen.add(canonical);
      source = roots.get(canonical);
      canonical = normalizeDirectoryPath(source);
    }
    const alias = canonical && !seen.has(canonical) ? { key: `git:${canonical}`, path: source, kind: "git" } : null;
    cache.set(key, alias);
    return alias;
  }

  const matches = new Map();
  if (database) {
    const keys = database.prepare("SELECT DISTINCT repository_key FROM events WHERE repository_key GLOB ?");
    for (const pattern of ["git:*", "directory:*"]) {
      if (pattern === "directory:*" && !roots.size) break;
      for (const { repository_key: key } of keys.iterate(pattern)) {
        const alias = resolve(key);
        if (alias) matches.set(key, alias);
      }
    }
  }
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  return {
    resolve,
    sql(key, name, kind) {
      if (!matches.size) return { key, path: name, kind };
      const expression = (field, fallback) => {
        const cases = Array.from(matches, ([raw, alias]) => `WHEN ${literal(raw)} THEN ${literal(alias[field])}`);
        return `CASE ${key} ${cases.join(" ")} ELSE ${fallback} END`;
      };
      return { key: expression("key", key), path: expression("path", name), kind: expression("kind", kind) };
    },
  };
}

export function createSourceRepositoryResolver(
  homes,
  attachmentRoots = undefined,
  resolveCheckout = createRepositoryResolver(),
) {
  let aliases;
  return async (cwd) => {
    const repository = await resolveCheckout(cwd);
    aliases ??= createRepositoryAliases(homes, null, attachmentRoots);
    return aliases.resolve(repository.key) || repository;
  };
}
