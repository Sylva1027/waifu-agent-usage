import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";

test("all standalone source adapters load without pricing or achievement code", async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const probe = createLiteBoundaryProbe(fixture.root, {
    forbiddenModules: [
      "src/pricing.js",
      "src/pricing-store.js",
      "public/pricing-models.js",
      "src/achievement-hermes-source.js",
      "src/achievement-runtime.js",
      "src/achievement-store.js",
      "public/waifu-timeline.js",
    ],
  });
  const files = [
    "claude-code-usage",
    "opencode-usage",
    "workbuddy-usage",
    "zcode-usage",
    "dsh-usage",
    "hermes-usage",
    "usage-source-inputs",
    "usage-sources",
    "usage-source-acquisition",
    "usage-query",
    "usage-summary",
    "usage-reader",
    "usage-sql",
  ].map((file) => new URL(`../src/${file}.js`, import.meta.url).href);
  files.push(new URL("../public/timeline-utils.js", import.meta.url).href);
  const exec = promisify(execFile);
  await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    for (const file of ${JSON.stringify(files)}) await import(file);
  `,
    ],
    { env: probe.env, windowsHide: true },
  );
  for (const file of files) assert.ok(probe.read().some((entry) => entry.kind === "load" && entry.url === file));
  assert.equal(probe.read().filter((entry) => entry.forbidden).length, 0);
});
