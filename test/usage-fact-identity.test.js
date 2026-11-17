import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { canonicalFactPayload } from "../src/usage-sql.js";
import { sourceFactIdentity } from "../src/usage-fact-identity.js";
import { UsageStore } from "../src/usage-store-lite.js";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";
import { createRemainingHarnessFixture } from "../test-support/remaining-harness-fixture.mjs";

test("source identity ignores local derived price stamps while serialized facts remain exact", () => {
  const legacy = {
    id: 7,
    request_input_tokens: 300000,
    context_level: "long",
    price_version: "old-catalog",
    detail_mask: 15,
    total: 310000,
  };
  const current = { ...legacy, context_level: "known", price_version: "" };
  assert.deepEqual(sourceFactIdentity(legacy), sourceFactIdentity(current));
  assert.notDeepEqual(canonicalFactPayload(legacy), canonicalFactPayload(current));
  for (const changed of [
    { total: 310001 },
    { request_input_tokens: 0 },
    { context_level: "unknown" },
    { detail_mask: 5 },
  ])
    assert.notDeepEqual(sourceFactIdentity(current), sourceFactIdentity({ ...current, ...changed }));
  assert.equal(legacy.price_version, "old-catalog");
});

test("reparsing an unchanged legacy source retains its original rows and price stamp", async (t) => {
  const fixture = createLiteEditionFixture();
  const store = new UsageStore(fixture.options);
  t.after(() => {
    try {
      store.close();
    } finally {
      fixture.close();
    }
  });
  const { filePath, source } = createRemainingHarnessFixture(path.join(fixture.root, "legacy-source"), "claude", 1);
  await store.open();
  await store.replaceFile({ filePath, source, info: await stat(filePath) });
  store.database
    .prepare("UPDATE events SET price_version='legacy-catalog',context_level='short' WHERE source_path=?")
    .run(filePath);
  const before = store.database.prepare("SELECT * FROM events WHERE source_path=? ORDER BY id").all(filePath);
  const result = await store.replaceFile({ filePath, source, info: await stat(filePath) });
  assert.equal(result.reusedPrefix, true);
  assert.deepEqual(
    store.database.prepare("SELECT * FROM events WHERE source_path=? ORDER BY id").all(filePath),
    before,
  );
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM history_replaced_facts").get().n, 0);
});
