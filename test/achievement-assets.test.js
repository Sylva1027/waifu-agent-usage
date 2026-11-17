import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ACHIEVEMENT_CONTENT } from "../public/achievement-content.js";
import { createUsageServer } from "../src/server.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";

test("real static routes serve achievement assets from an isolated Waifu static fixture", async (t) => {
  const parent = await realpath(tmpdir());
  const homeDir = await mkdtemp(path.join(parent, "achievement-assets-"));
  let server;
  t.after(async () => {
    await server?.close();
    assert.equal(path.dirname(await realpath(homeDir)), parent);
    assert.ok(path.basename(homeDir).startsWith("achievement-assets-"));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const importStoreFile = path.join(homeDir, "imports.json");
  await writeFile(importStoreFile, JSON.stringify({ version: 2, imports: [] }));
  server = createUsageServer({
    achievementsEnabled: false,
    homeDir,
    env: {},
    importStoreFile,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  });
  await listenOnFetchPort(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/achievements`)).status, 404, "this fixture only exercises static assets");

  await t.test("all 96 badge URLs return approved SHA-256 bytes and 256px transparent WebP", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("./fixtures/achievements/resources.json", import.meta.url), "utf8"),
    );
    const expected = ACHIEVEMENT_CONTENT.flatMap((row) =>
      (row.tiered ? ["bronze", "silver", "gold"] : ["stone"]).map(
        (grade) => `/assets/achievements/${row.id}/${grade}.webp`,
      ),
    );
    assert.equal(expected.length, 96);
    assert.equal(new Set(expected).size, 96);
    assert.deepEqual(manifest.resources.map((resource) => resource.url).sort(), expected.sort());
    let totalBytes = 0;
    for (const resource of manifest.resources) {
      const response = await fetch(base + resource.url);
      assert.equal(response.status, 200, resource.url);
      assert.equal(response.headers.get("content-type"), "image/webp", resource.url);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, resource.bytes, resource.url);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), resource.sha256, resource.url);
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF", resource.url);
      assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, resource.url);
      assert.equal(bytes.toString("ascii", 8, 16), "WEBPVP8X", resource.url);
      assert.equal(bytes[20] & 0x10, 0x10, resource.url);
      assert.equal(bytes.readUIntLE(24, 3) + 1, 256, resource.url);
      assert.equal(bytes.readUIntLE(27, 3) + 1, 256, resource.url);
      totalBytes += bytes.length;
    }
    assert.equal(totalBytes, 1618302);
    assert.equal(totalBytes, manifest.summary.bytes);
  });

  await t.test("all achievement JS/CSS routes return the actual source with the proper content type", async () => {
    const publicRoot = new URL("../public/", import.meta.url);
    const files = (await readdir(publicRoot)).filter((file) => /^achievement-.*\.(?:js|css)$/.test(file));
    for (const file of [
      "achievement-content.js",
      "achievement-list.js",
      "achievement-detail.js",
      "achievement-dialog.js",
      "achievement-detail.css",
      "achievement-dialog.css",
    ])
      assert.ok(files.includes(file), file);
    for (const file of [...files, "html-utils.js"]) {
      const response = await fetch(`${base}/${file}`);
      assert.equal(response.status, 200, file);
      assert.equal(
        response.headers.get("content-type"),
        file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
        file,
      );
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(file, publicRoot)), file);
    }
    assert.equal(existsSync(path.join(homeDir, "achievements.sqlite")), false);
  });
});
