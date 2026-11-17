import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export const EDITIONS = ["lite", "waifu"];
export const ENTRY_OVERRIDES = {
  "src/cli.js": "src/cli-lite.js",
  "src/server.js": "src/server-lite.js",
  "src/usage-executor.js": "src/usage-executor-lite.js",
};
// These guarded edges belong to Waifu's explicitly bound history options.
// Lite binds null pricing and snapshot evidence; achievement creation is never bound.
const LITE_OPTIONAL_EDGES = new Set([
  "src/history-backup.js:./pricing.js",
  "src/history-backup.js:./service-tier-evidence.js",
  "src/history-backup.js:./achievement-backup.js",
  "src/history-archive.js:./achievement-backup.js",
]);
const FORMAT_MODULES = new Set([
  "src/achievement-backup-format.js",
  "src/achievement-format-descriptor.js",
  "src/pricing-catalog-format.js",
  "src/service-tier-evidence-format.js",
]);

export function isLiteForbidden(file) {
  if (FORMAT_MODULES.has(file) || file === "src/usage-record-migration.js") return false;
  return (
    /^src\/(?:waifu\/|achievement-|pricing(?:[.-])|service-tier-evidence\.js|history-quote-inputs\.js|usage-(?:core|store|record-store|executor-waifu)\.js)/.test(
      file,
    ) ||
    /^public\/(?:assets\/|achievement-|skin|share|pricing-|i18n\.js|range-metrics\.js|waifu-|app(?:-state)?\.js|index\.html|styles\.css)/.test(
      file,
    )
  );
}

export async function readReleaseInput(root, file) {
  assert.ok(
    file &&
      !file.includes("\\") &&
      !file.includes(":") &&
      !path.posix.isAbsolute(file) &&
      !file.split("/").includes(".."),
    `Unsafe release input: ${file}`,
  );
  const source = path.resolve(root, file);
  for (let item = source; item !== path.resolve(root); item = path.dirname(item)) {
    assert.ok(!(await lstat(item)).isSymbolicLink(), `Refusing linked release input: ${item}`);
  }
  return readFile(source);
}

function localReference(file, reference) {
  return reference.startsWith("/") && file.startsWith("public/")
    ? `public${reference}`
    : path.posix.normalize(path.posix.join(path.posix.dirname(file), reference));
}

export function scriptReferences(file, source) {
  const references = new Set();
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const add = (node) => {
    assert.ok(node && ts.isStringLiteralLike(node), `Nonliteral release dependency in ${file}`);
    const name = node.text;
    if (name.startsWith("node:")) return;
    assert.ok(
      name.startsWith(".") || (file.startsWith("public/") && name.startsWith("/")),
      `External release dependency in ${file}: ${name}`,
    );
    references.add(name);
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      add(node.moduleSpecifier);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      add(node.arguments[0]);
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.[1]?.getText(ast) === "import.meta.url"
    )
      add(node.arguments[0]);
    if (file.startsWith("public/") && ts.isStringLiteralLike(node) && node.text.startsWith("/assets/"))
      references.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...references];
}

function arrayInitializer(file, source, name) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let result;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(result && ts.isArrayLiteralExpression(result), `Missing literal ${name} in ${file}`);
  return result.elements;
}

export async function releaseInputs(edition, root, { packaged = false, browserOnly = false } = {}) {
  assert.ok(EDITIONS.includes(edition), `Unknown edition: ${edition}`);
  const inputs = new Map();
  const queue = browserOnly ? [] : ["package.json", "LICENSE", "src/cli.js", "src/server.js", "src/usage-executor.js"];
  if (!browserOnly) {
    const native = "native/windows-source-proof";
    const receipt = JSON.parse(await readReleaseInput(root, `${native}/bin/windows-source-proof.build.json`));
    queue.push(
      `${native}/bin/windows-source-proof.exe`,
      `${native}/bin/windows-source-proof.build.json`,
      ...Object.keys(receipt.sourceSha256).map((file) => `${native}/${file}`),
    );
  }
  if (edition === "lite") {
    const file = "src/server-lite.js";
    const elements = arrayInitializer(file, (await readReleaseInput(root, file)).toString("utf8"), "LITE_PUBLIC_FILES");
    for (const node of elements) {
      assert.ok(ts.isStringLiteral(node), "Lite public allowlist must contain literal paths");
      queue.push(`public/${node.text}`);
    }
  } else {
    queue.push("public/index.html", "public/skin-palette-studio.html");
    const file = "public/achievement-content.js";
    for (const node of arrayInitializer(
      file,
      (await readReleaseInput(root, file)).toString("utf8"),
      "ACHIEVEMENT_CONTENT",
    )) {
      assert.ok(ts.isObjectLiteralExpression(node));
      const values = new Map(
        node.properties
          .filter(ts.isPropertyAssignment)
          .map((property) => [property.name.getText(), property.initializer]),
      );
      assert.ok(ts.isStringLiteral(values.get("id")));
      const tiered = values.get("tiered").kind;
      assert.ok([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(tiered));
      for (const material of tiered === ts.SyntaxKind.TrueKeyword ? ["bronze", "silver", "gold"] : ["stone"])
        queue.push(`public/assets/achievements/${values.get("id").text}/${material}.webp`);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    if (inputs.has(file)) continue;
    assert.ok(!browserOnly || file.startsWith("public/"), `Browser dependency escaped public/: ${file}`);
    assert.ok(edition !== "lite" || !isLiteForbidden(file), `Lite dependency is forbidden: ${file}`);
    const sourceFile = edition === "lite" && !packaged ? ENTRY_OVERRIDES[file] || file : file;
    const bytes = await readReleaseInput(root, sourceFile);
    inputs.set(file, sourceFile);
    const source = bytes.toString("utf8");
    let references = [];
    if (file.endsWith(".js")) {
      references = scriptReferences(file, source).filter(
        (name) => edition !== "lite" || !LITE_OPTIONAL_EDGES.has(`${file}:${name}`),
      );
    } else if (file.endsWith(".html")) {
      references = [...source.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((name) => name !== "/" && !/^(?:[a-z]+:|#)/i.test(name));
    } else if (file.endsWith(".css")) {
      references = [...source.matchAll(/(?:url\(\s*|@import\s*)["']?([^\s"')]+)["']?\s*\)?/g)]
        .map((match) => match[1])
        .filter((name) => !/^(?:[a-z]+:|#)/i.test(name));
    }
    for (const reference of references) queue.push(localReference(file, reference));
  }
  return Object.fromEntries([...inputs.entries()].sort(([a], [b]) => a.localeCompare(b, "en")));
}
