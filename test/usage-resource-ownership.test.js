import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { UsageStore } from "../src/usage-store.js";

test("borrowed read connections and period caches survive reader close", () => {
  const database = new DatabaseSync(":memory:");
  const cache = new Map([["scope", { total: 7 }]]);
  const reader = new UsageStore();
  reader.borrowReadDatabase(database);
  reader.borrowPeriodComparisonCache(cache);
  try {
    reader.close();
    reader.close();
    assert.equal(database.prepare("SELECT 7 AS value").get().value, 7);
    assert.equal(cache.get("scope").total, 7);
    assert.equal(reader.database, null);
  } finally {
    database.close();
  }
});

test("a released borrow can be rebound without closing either owner", () => {
  const first = new DatabaseSync(":memory:");
  const next = new DatabaseSync(":memory:");
  const reader = new UsageStore();
  try {
    reader.borrowReadDatabase(first);
    assert.throws(() => reader.borrowReadDatabase(next), /already attached/);
    reader.releaseReadDatabase();
    reader.borrowReadDatabase(next);
    reader.close();
    for (const database of [first, next]) assert.equal(database.prepare("SELECT 1 AS n").get().n, 1);
  } finally {
    first.close();
    next.close();
  }
});

test("cleanup continues after an owner fails and preserves the first error", () => {
  const store = new UsageStore();
  const calls = [];
  const failure = new Error("source cleanup failed");
  store.sourceProof = {
    close() {
      calls.push("source");
      throw failure;
    },
  };
  store.historySqlDashboardCache = {
    store: {
      close() {
        calls.push("reader");
      },
    },
  };
  store.historyProjectionStore = {
    close() {
      calls.push("projection");
      throw new Error("second");
    },
  };
  const database = new DatabaseSync(":memory:");
  store.database = database;
  assert.throws(
    () => store.close(),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["source", "reader", "projection"]);
  assert.throws(() => database.prepare("SELECT 1"), /not open/);
  assert.doesNotThrow(() => store.close());
});
