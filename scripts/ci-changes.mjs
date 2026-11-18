import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

const markdown = /^(?:(?:docs\/(?!validation\/).+)|README(?:\.en)?|native\/windows-source-proof\/README)\.md$/i;
const docsImage = /^docs\/images\/.+\.(?:avif|gif|jpe?g|png|svg|webp)$/i;
const needsNative = /^(?:\.github\/|native\/|package(?:-lock)?\.json$|scripts\/(?:ci-|test\.|package-release|check-release|release-dependencies)|(?:src|public|test|test-support)\/.*(?:archive|source|hermes|native|windows|usage-(?:core|store|record|fact|executor)|cli|server|final-status))/i;

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function localTargets(file, content) {
  const prose = content
    .replace(/\r\n/g, "\n")
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[ \t]*$|`+[^`\n]*`+/gm, "");
  const targets = new Set();
  // shortcut: checks Markdown file paths and ignores anchors and raw HTML, expand if docs adopt a Markdown parser.
  const links = /(?:\]\(\s*|^[ \t]{0,3}\[(?!\^)[^\]\n]+\]:[ \t]*)(?:<([^>\n]+)>|((?:\\[()]|\([^()\s]*\)|[^()\s\\])+)(?=[\s)]|$))/gm;
  for (const match of prose.matchAll(links)) {
    const url = (match[1] ?? match[2]).split(/[?#]/, 1)[0];
    if (!url || /^(?:[a-z][\w+.-]*:|\/)/i.test(url)) continue;
    const target = decodeURIComponent(url.replace(/\\([()])/g, "$1").replace(/%(?![0-9a-f]{2})/gi, "%25"));
    targets.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), target)).replace(/\/$/, ""));
  }
  return targets;
}

const base = process.env.CI_BASE_SHA ?? "";
let changed;
if (/^[0-9a-f]{40}$/i.test(base) && !/^0+$/.test(base)) {
  const object = base + "^{commit}";
  if (git("cat-file", "-e", object) !== null || git("fetch", "--no-tags", "--depth=1", "origin", base) !== null) {
    changed = git("diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--")?.split("\0").filter(Boolean);
  }
}

const docsOnly = Boolean(changed?.length && changed.every((file) => markdown.test(file) || docsImage.test(file)));
const native = !changed?.length || changed.some((file) => needsNative.test(file));
if (docsOnly) {
  const tracked = git("ls-tree", "--name-only", "-r", "-z", "HEAD")?.split("\0").filter(Boolean);
  if (!tracked) throw new Error("Unable to read tracked documentation paths");
  const paths = new Set(["."]);
  for (const file of tracked) {
    paths.add(file);
    for (let dir = path.posix.dirname(file); !paths.has(dir); dir = path.posix.dirname(dir)) paths.add(dir);
  }
  const removed = changed.filter((file) => !paths.has(file));
  const markdownFiles = (removed.length ? tracked : changed).filter((file) => paths.has(file) && markdown.test(file));
  for (const file of markdownFiles) {
    const headText = git("show", "HEAD:" + file);
    if (headText === null) throw new Error("Unable to read " + file);
    const baseLinks = changed.includes(file) && localTargets(file, git("show", base + ":" + file) ?? "");
    for (const target of localTargets(file, headText)) {
      if (paths.has(target)) continue;
      if ((baseLinks && !baseLinks.has(target)) || removed.some((name) => name === target || name.startsWith(target + "/"))) {
        console.error(file + " references a missing path: " + target);
        process.exitCode = 1;
      }
    }
  }
}

const outputs = "docs-only=" + docsOnly + "\nnative=" + native + "\n";
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
else process.stdout.write(outputs);
