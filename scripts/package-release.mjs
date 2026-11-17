import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export { releaseInputs, isLiteForbidden } from "./release-dependencies.mjs";
import { EDITIONS, ENTRY_OVERRIDES, releaseInputs, readReleaseInput } from "./release-dependencies.mjs";
const NATIVE = "native/windows-source-proof";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function walk(directory, extension) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing linked release input: ${file}`);
    if (entry.isDirectory()) files.push(...(await walk(file, extension)));
    else if (entry.isFile() && file.endsWith(extension)) files.push(file);
  }
  return files;
}

export async function releaseFiles(edition, root = ROOT) {
  return Object.keys(await releaseInputs(edition, root));
}

// Only a new output child is writable; no overwrite or recursive removal of caller-provided paths.
export async function releaseDirectory(root, output) {
  const directory = path.resolve(root, output);
  const relative = path.relative(path.resolve(root, "output"), directory);
  assert.ok(
    relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "Release directory must be a child of workspace/output",
  );
  let current = path.resolve(root);
  for (const segment of path.relative(current, directory).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Refusing linked/non-directory output: ${current}`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return directory;
}

export async function removeTemporary(directory, parent, prefix) {
  assert.equal(path.dirname(directory), parent);
  assert.ok(path.basename(directory).startsWith(prefix));
  assert.ok(!(await lstat(directory)).isSymbolicLink());
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function nativeCheck(directory) {
  await exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(directory, NATIVE, "build.ps1"), "-Check"], {
    cwd: directory,
  });
}

export async function fileHashes(directory) {
  const files = await walk(directory, "");
  const hashes = {};
  for (const file of files.sort())
    hashes[path.relative(directory, file).split(path.sep).join("/")] = sha256(await readFile(file));
  return hashes;
}

export function commonHashes(lite, waifu) {
  const core = {};
  for (const file of Object.keys(lite).sort()) {
    if (!Object.hasOwn(waifu, file) || Object.hasOwn(ENTRY_OVERRIDES, file)) continue;
    assert.equal(lite[file], waifu[file], `Shared core differs: ${file}`);
    core[file] = lite[file];
  }
  assert.ok(Object.keys(core).length > 0, "No shared release modules");
  return core;
}

export async function extractChecked(zip, destination, expected) {
  const { stdout } = await exec("tar", ["-tf", zip], { maxBuffer: 4 * 1024 * 1024 });
  const entries = stdout
    .trim()
    .split(/\r?\n/)
    .map((name) => name.replaceAll("\\", "/"));
  for (const name of entries) {
    assert.ok(
      !name.startsWith("/") && !name.includes(":") && !name.split("/").includes(".."),
      `Unsafe ZIP entry: ${name}`,
    );
    assert.ok(
      Object.hasOwn(expected, name) ||
        (name.endsWith("/") && Object.keys(expected).some((file) => file.startsWith(name))),
      `Unexpected ZIP entry: ${name}`,
    );
  }
  const files = entries.filter((name) => !name.endsWith("/"));
  assert.equal(new Set(files).size, files.length, "Duplicate ZIP entry");
  assert.deepEqual(files.sort(), Object.keys(expected).sort(), "ZIP inventory differs");
  await mkdir(destination);
  await exec("tar", ["-xf", zip, "-C", destination]);
  assert.deepEqual(await fileHashes(destination), expected, "Extracted ZIP hashes differ");
}

export async function packageRelease(output = "output/releases") {
  const directory = await releaseDirectory(ROOT, output);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory); // EEXIST keeps earlier releases and unrelated files intact.
  const work = await mkdtemp(path.join(directory, ".package-"));
  try {
    for (const edition of EDITIONS) {
      const stage = path.join(work, edition);
      for (const [file, sourceFile] of Object.entries(await releaseInputs(edition, ROOT))) {
        const bytes = await readReleaseInput(ROOT, sourceFile);
        await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
        await writeFile(path.join(stage, file), bytes);
      }
      await nativeCheck(stage);
      assert.deepEqual(
        Object.keys(await fileHashes(stage)).sort(),
        Object.keys(await releaseInputs(edition, stage, { packaged: true })).sort(),
        "Packaged dependency closure differs",
      );
    }
    const waifu = path.join(work, "waifu");
    const { version, releaseVersion } = JSON.parse(await readFile(path.join(waifu, "package.json"), "utf8"));
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
    assert.match(releaseVersion, /^\d+\.\d+[a-z]?$/);
    const variants = {};
    for (const edition of EDITIONS) {
      const stage = path.join(work, edition);
      const filename = `${releaseVersion}-${edition}.zip`;
      const zip = path.join(directory, filename);
      await exec(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          '$ErrorActionPreference = "Stop"; Get-ChildItem -LiteralPath $env:AGENT_USAGE_PACKAGE_STAGE | Compress-Archive -DestinationPath $env:AGENT_USAGE_PACKAGE_ZIP',
        ],
        { env: { ...process.env, AGENT_USAGE_PACKAGE_STAGE: stage, AGENT_USAGE_PACKAGE_ZIP: zip } },
      );
      const files = await fileHashes(stage);
      await extractChecked(zip, path.join(work, `verify-${edition}`), files);
      variants[edition] = { filename, sha256: sha256(await readFile(zip)), files };
    }
    const core = commonHashes(variants.lite.files, variants.waifu.files);
    const manifest = {
      version,
      releaseVersion,
      createdAt: new Date().toISOString(),
      coreSha256: sha256(JSON.stringify(core)),
      core,
      variants,
    };
    await writeFile(path.join(directory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      directory,
      version,
      releaseVersion,
      coreSha256: manifest.coreSha256,
      archives: Object.values(variants).map(({ filename }) => filename),
    };
  } finally {
    await removeTemporary(work, directory, ".package-");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv.length <= 3, "Usage: node scripts/package-release.mjs [output/new-directory]");
  console.log(JSON.stringify(await packageRelease(process.argv[2]), null, 2));
}
