import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { linkedWorktreeMain, normalizeDirectoryPath } from "./repository-identity.js";

const codexKinds = new Set(["main", "extra", "jetbrains", "codex"]);
export const CODEX_WORKTREE_ROOTS_META = "codex_worktree_roots";

function absolutePath(value) {
  return typeof value === "string" && !value.includes("\0") && path.isAbsolute(value) ? path.normalize(value) : "";
}

function sourceCheckout(cwd) {
  if (!cwd) return "";
  try {
    let directory = realpathSync.native(cwd);
    for (;;) {
      const entry = statSync(path.join(directory, ".git"), { throwIfNoEntry: false });
      if (entry) return entry.isDirectory() ? directory : linkedWorktreeMain(directory);
      const parent = path.dirname(directory);
      if (parent === directory) return "";
      directory = parent;
    }
  } catch {
    return "";
  }
}

/** Recover checkout roots even after Codex archives and removes a worktree. */
export function readCodexWorktreeRoots(homePath) {
  const roots = new Map();
  const conflicts = new Set();
  let database;
  try {
    database = new DatabaseSync(path.join(homePath, "state_5.sqlite"), { readOnly: true });
    const rows = database.prepare(`SELECT attachment_type, payload FROM thread_attachments
      WHERE attachment_type IN ('worktree', 'archived_worktree')`);
    for (const row of rows.iterate()) {
      let attachment;
      try {
        attachment = JSON.parse(String(row.payload));
      } catch {
        continue;
      }
      const tree = row.attachment_type === "archived_worktree" ? attachment?.worktree : attachment;
      if (tree?.hostId !== "local") continue;
      const root = normalizeDirectoryPath(absolutePath(tree.root));
      if (!root || conflicts.has(root)) continue;
      const source = absolutePath(tree.sourceGitRoot) || sourceCheckout(absolutePath(tree.sourceCwd));
      const sourceKey = normalizeDirectoryPath(source);
      if (!sourceKey || sourceKey === root) continue;
      if (roots.has(root) && normalizeDirectoryPath(roots.get(root)) !== sourceKey) {
        roots.delete(root);
        conflicts.add(root);
      } else {
        roots.set(root, source);
      }
    }
  } catch {
    // Older Codex homes can have no attachment table or state database.
    roots.clear();
  } finally {
    database?.close();
  }
  return roots;
}

export function readCodexHomeWorktreeRoots(homes) {
  const roots = new Map();
  for (const home of homes) {
    if (!home.path || !codexKinds.has(home.kind)) continue;
    for (const [root, main] of readCodexWorktreeRoots(home.path)) {
      if (roots.has(root) && normalizeDirectoryPath(roots.get(root)) !== normalizeDirectoryPath(main)) {
        roots.set(root, null);
      } else {
        roots.set(root, main);
      }
    }
  }
  return roots;
}

export function serializeCodexWorktreeRoots(roots) {
  const entries = [...roots].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}
