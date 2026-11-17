import assert from "node:assert/strict";
import test from "node:test";
import {
  recordAchievementShare,
  recordAchievementSkin,
  retryAchievementOperations,
} from "../public/achievement-events.js";

test("browser helpers retain success credentials on failure and only send allowed HTTP fields", async (t) => {
  const calls = [];
  let fail = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (fail) throw new Error("offline");
    return { ok: true };
  });
  assert.equal(await recordAchievementShare(null), false);
  assert.equal(await recordAchievementShare(Promise.reject(new Error("capture failed"))), false);
  assert.equal(await recordAchievementSkin("classic"), false);
  assert.equal(calls.length, 0);
  assert.equal(await recordAchievementShare("original-receipt"), false);
  assert.equal(await recordAchievementSkin("deepseek"), false);
  fail = false;
  assert.deepEqual(await retryAchievementOperations(), [true, true]);
  assert.deepEqual(
    calls.map(({ body }) => body),
    [
      { kind: "share", receipt: "original-receipt" },
      { kind: "skin", characterId: "deepseek" },
      { kind: "share", receipt: "original-receipt" },
      { kind: "skin", characterId: "deepseek" },
    ],
  );
  assert.deepEqual(await retryAchievementOperations(), []);
  for (const { url, options } of calls) {
    assert.equal(url, "/api/achievements/operations");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers["Content-Type"], "application/json");
  }
});

test("undelivered success receipts survive a page reload and retain their original identity", async (t) => {
  const values = new Map();
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  t.after(() => (old ? Object.defineProperty(globalThis, "localStorage", old) : delete globalThis.localStorage));
  let offline = true;
  const delivered = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (offline) throw new Error("offline");
    delivered.push(JSON.parse(options.body));
    return { ok: true };
  });
  const first = await import("../public/achievement-events.js?offline-first");
  assert.equal(await first.recordAchievementShare("captured-before-reload"), false);
  offline = false;
  const reloaded = await import("../public/achievement-events.js?offline-reloaded");
  assert.deepEqual(await reloaded.retryAchievementOperations(), [true]);
  assert.deepEqual(delivered, [{ kind: "share", receipt: "captured-before-reload" }]);
  assert.deepEqual(JSON.parse([...values.values()][0]), []);
});

test("permanently rejected credentials are removed instead of retrying on every refresh", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 400 }));
  const page = await import("../public/achievement-events.js?rejected-credential");
  assert.equal(await page.recordAchievementShare("invalid-old-profile-receipt"), false);
  assert.deepEqual(await page.retryAchievementOperations(), []);
});
