import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAchievementUnread } from "../public/achievement-unread.js";
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } from "../src/achievement-catalog.js";

function snapshot(overrides = {}) {
  return {
    profileId: "profile-a",
    rulesVersion: ACHIEVEMENT_RULES_VERSION,
    catalogHash: createHash("sha256").update(JSON.stringify(ACHIEVEMENT_CATALOG)).digest("hex"),
    state: "ready",
    timeZone: "UTC",
    progressRevision: 7,
    awardRevision: 3,
    seenAwardRevision: 0,
    rows: ACHIEVEMENT_CATALOG.map(({ id, tiers, thresholds }) => ({
      id,
      observedValue: "0",
      nextTarget: thresholds[0],
      highestEarned: null,
      earnedAt: Object.fromEntries(tiers.map((tier) => [tier, null])),
      updatedAt: null,
    })),
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const shown = (seenThroughRevision = 3, profileId = "profile-a") => ({ profileId, seenThroughRevision });

function mockFetch(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", (url, options) => {
    const result = deferred();
    calls.push({ url, options, ...result });
    return result.promise;
  });
  return calls;
}

test("production catalog compatibility, captured revision payload and successful deduplication", async (t) => {
  const calls = mockFetch(t);
  const changes = [];
  const unread = createAchievementUnread({ onChange: (next) => changes.push(next) });
  const initial = snapshot();
  assert.equal(unread.getSnapshot(), null);
  assert.equal(unread.accept(initial), true);
  const request = unread.markShown(shown());
  assert.equal(unread.markShown(shown()), request);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/achievements/seen");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), shown());
  calls[0].resolve(response({ seenThroughRevision: 3 }));
  assert.equal(await request, true);
  assert.equal(await unread.markShown(shown(2)), true);
  assert.equal(calls.length, 1);
  assert.equal(unread.getSnapshot().seenAwardRevision, 3);
  assert.equal(initial.seenAwardRevision, 0, "accept and confirmation do not mutate the caller's snapshot");
  assert.equal(changes.length, 2);
});

test("invalid envelopes and incomplete rows cannot replace a usable snapshot", async (t) => {
  const calls = mockFetch(t);
  const unread = createAchievementUnread();
  const initial = snapshot();
  unread.accept(initial);
  const invalid = [
    null,
    {},
    { ...initial, profileId: " " },
    { ...initial, profileId: 1 },
    { ...initial, state: "failed" },
    { ...initial, rows: null },
    { ...initial, rows: initial.rows.slice(1) },
    { ...initial, state: "preparing" },
    { ...initial, rulesVersion: null },
    { ...initial, catalogHash: "" },
    { ...initial, seenAwardRevision: 4 },
  ];
  for (const key of ["progressRevision", "awardRevision", "seenAwardRevision"])
    for (const value of [-1, 0.5, "3", undefined, Number.MAX_SAFE_INTEGER + 1])
      invalid.push({ ...initial, [key]: value });
  for (const value of invalid) assert.equal(unread.accept(value), false);
  assert.deepEqual(unread.getSnapshot(), initial);
  for (const value of [-1, 0.5, "3", Number.MAX_SAFE_INTEGER + 1, 4])
    assert.equal(await unread.markShown(shown(value)), false);
  assert.equal(await unread.markShown(shown(3, "different")), false);
  assert.equal(await unread.markShown(), false);
  assert.equal(calls.length, 0);
});

test("unknown rule or catalog versions and preparing state never send seen", async (t) => {
  const calls = mockFetch(t);
  for (const patch of [
    { rulesVersion: "future-rules" },
    { catalogHash: "unknown-catalog" },
    { state: "preparing", rows: null },
  ]) {
    const unread = createAchievementUnread();
    assert.equal(unread.accept(snapshot(patch)), true);
    assert.equal(await unread.markShown(shown()), false);
  }
  assert.equal(calls.length, 0);
});

test("out-of-order snapshots retain newer progress and monotonic seen without change notifications for repeats", () => {
  const changes = [];
  const unread = createAchievementUnread({ onChange: (next) => changes.push(next) });
  const latest = snapshot({ progressRevision: 9, awardRevision: 4, seenAwardRevision: 1 });
  latest.rows[0].observedValue = "42";
  unread.accept(latest);
  unread.accept(snapshot({ progressRevision: 8, seenAwardRevision: 3 }));
  assert.deepEqual(unread.getSnapshot(), { ...latest, seenAwardRevision: 3 });
  unread.accept(snapshot({ progressRevision: 10, awardRevision: 4, seenAwardRevision: 0 }));
  assert.equal(unread.getSnapshot().progressRevision, 10);
  assert.equal(unread.getSnapshot().seenAwardRevision, 3);
  const count = changes.length;
  unread.accept(structuredClone(unread.getSnapshot()));
  assert.equal(changes.length, count);
  unread.accept(snapshot({ progressRevision: 11, awardRevision: 2 }));
  assert.equal(unread.getSnapshot().progressRevision, 10);
  assert.equal(unread.getSnapshot().awardRevision, 4);
});

test("a delayed seen success merges only seen and preserves awards and rows received during display", async (t) => {
  const calls = mockFetch(t);
  const unread = createAchievementUnread();
  unread.accept(snapshot());
  const request = unread.markShown(shown());
  await Promise.resolve();
  const newer = snapshot({ progressRevision: 8, awardRevision: 4 });
  newer.rows[0].observedValue = "99";
  unread.accept(newer);
  calls[0].resolve(response({ seenThroughRevision: 3 }));
  assert.equal(await request, true);
  assert.deepEqual(unread.getSnapshot(), { ...newer, seenAwardRevision: 3 });
  assert.ok(unread.getSnapshot().awardRevision > unread.getSnapshot().seenAwardRevision);
  unread.accept(snapshot());
  assert.deepEqual(unread.getSnapshot(), { ...newer, seenAwardRevision: 3 });
});

test("out-of-order confirmations and a peer page's larger acknowledgement remain monotonic", async (t) => {
  const calls = mockFetch(t);
  const unread = createAchievementUnread();
  unread.accept(snapshot({ awardRevision: 5 }));
  const older = unread.markShown(shown(2));
  const newer = unread.markShown(shown(4));
  await Promise.resolve();
  calls[1].resolve(response({ seenThroughRevision: 5 }));
  assert.equal(await newer, true);
  calls[0].resolve(response({ seenThroughRevision: 2 }));
  assert.equal(await older, true);
  assert.equal(unread.getSnapshot().seenAwardRevision, 5);
  unread.accept(snapshot({ progressRevision: 8, awardRevision: 6, seenAwardRevision: 1 }));
  assert.equal(unread.getSnapshot().seenAwardRevision, 5);
  assert.equal(unread.getSnapshot().awardRevision, 6);
});

test("a peer acknowledgement ahead of locally known awards never manufactures an award revision", async (t) => {
  const calls = mockFetch(t);
  const unread = createAchievementUnread();
  unread.accept(snapshot());
  const request = unread.markShown(shown());
  await Promise.resolve();
  calls[0].resolve(response({ seenThroughRevision: 4 }));
  assert.equal(await request, true);
  assert.equal(unread.getSnapshot().awardRevision, 3);
  assert.equal(unread.getSnapshot().seenAwardRevision, 3);
  unread.accept(snapshot({ progressRevision: 8, awardRevision: 4, seenAwardRevision: 4 }));
  assert.equal(unread.getSnapshot().seenAwardRevision, 4);
});

test("failed or malformed confirmations leave unread intact and retry only on a later markShown", async (t) => {
  let attempts = 0;
  const failures = [
    () => {
      throw new Error("offline");
    },
    () => response({}, 503),
    () => response({ seenThroughRevision: "3" }),
    () => response({ seenThroughRevision: 2 }),
    () => ({
      ok: true,
      json: async () => {
        throw new Error("invalid JSON");
      },
    }),
  ];
  t.mock.method(globalThis, "fetch", async () => {
    const failure = failures[attempts++];
    return failure ? failure() : response({ seenThroughRevision: 3 });
  });
  const unread = createAchievementUnread();
  unread.accept(snapshot());
  for (const _failure of failures) {
    assert.equal(await unread.markShown(shown()), false);
    assert.equal(unread.getSnapshot().seenAwardRevision, 0);
  }
  assert.equal(attempts, failures.length);
  assert.equal(await unread.markShown(shown()), true);
  assert.equal(attempts, failures.length + 1);
});

test("refresh catches up calls made before its first fetch and during either request, then stops", async (t) => {
  const calls = mockFetch(t);
  const changes = [];
  const unread = createAchievementUnread({ onChange: (next) => changes.push(next) });
  const first = unread.refresh();
  assert.equal(unread.refresh(), first);
  assert.equal(unread.refresh(), first);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(unread.refresh(), first);
  assert.equal(calls[0].url, "/api/achievements");
  assert.equal(calls[0].options.cache, "no-store");
  const secondStarted = deferred();
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (...args) => {
    const result = fetch(...args);
    secondStarted.resolve();
    return result;
  });
  calls[0].resolve(response(snapshot()));
  await secondStarted.promise;
  assert.equal(calls.length, 2);
  assert.equal(unread.refresh(), first);
  const thirdStarted = deferred();
  t.mock.method(globalThis, "fetch", (...args) => {
    const result = fetch(...args);
    thirdStarted.resolve();
    return result;
  });
  calls[1].resolve(response(snapshot()));
  await thirdStarted.promise;
  assert.equal(calls.length, 3);
  calls[2].resolve(response(snapshot()));
  assert.deepEqual(await first, snapshot());
  assert.equal(calls.length, 3);
  assert.equal(changes.length, 1, "unchanged snapshots cannot start callback-driven refresh loops");
});

test("refresh failure preserves a complete snapshot, catches up pending demand and permits later retry", async (t) => {
  const outcomes = [
    response({}, 503),
    response(snapshot({ progressRevision: 8 })),
    new Error("offline"),
    response(snapshot({ progressRevision: 9 })),
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const next = outcomes[calls++];
    if (next instanceof Error) throw next;
    return next;
  });
  const unread = createAchievementUnread();
  unread.accept(snapshot());
  const first = unread.refresh();
  unread.refresh();
  await first;
  assert.equal(calls, 2);
  assert.equal(unread.getSnapshot().progressRevision, 8);
  await unread.refresh();
  assert.equal(unread.getSnapshot().progressRevision, 8);
  await unread.refresh();
  assert.equal(unread.getSnapshot().progressRevision, 9);
  assert.equal(calls, 4);
});

test("profile switches isolate old GET and POST completions, including a switch back to the same ID", async (t) => {
  const calls = mockFetch(t);
  const unread = createAchievementUnread();
  unread.accept(snapshot());
  const get = unread.refresh();
  const old = unread.markShown(shown());
  await Promise.resolve();
  unread.accept(snapshot({ profileId: "profile-b", progressRevision: 1, awardRevision: 1 }));
  unread.accept(snapshot());
  const current = unread.markShown(shown());
  await Promise.resolve();
  assert.equal(calls.length, 3, "old profile requests do not deduplicate a new generation");
  calls[0].resolve(response(snapshot({ progressRevision: 20, awardRevision: 8, seenAwardRevision: 8 })));
  calls[1].resolve(response({ seenThroughRevision: 3 }));
  await get;
  assert.equal(await old, false);
  assert.equal(unread.getSnapshot().seenAwardRevision, 0);
  assert.equal(unread.getSnapshot().progressRevision, 7);
  assert.equal(unread.markShown(shown()), current, "old completion cannot remove a new in-flight request");
  calls[2].resolve(response({ seenThroughRevision: 3 }));
  assert.equal(await current, true);
});

test("a profile switch before POST starts cancels the obsolete confirmation", async (t) => {
  const calls = mockFetch(t);
  const unread = createAchievementUnread();
  unread.accept(snapshot());
  const request = unread.markShown(shown());
  unread.accept(snapshot({ profileId: "profile-b", progressRevision: 1, awardRevision: 1 }));
  assert.equal(await request, false);
  assert.equal(calls.length, 0);
  assert.equal(unread.getSnapshot().profileId, "profile-b");
  assert.equal(unread.getSnapshot().seenAwardRevision, 0);
});

test("refresh demand after a profile switch catches up the new profile without accepting the old response", async (t) => {
  const first = deferred();
  const second = deferred();
  const secondStarted = deferred();
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    if (calls === 1) return first.promise;
    secondStarted.resolve();
    return second.promise;
  });
  const changes = [];
  const unread = createAchievementUnread({ onChange: (next) => changes.push(next) });
  unread.accept(snapshot());
  const request = unread.refresh();
  await Promise.resolve();
  const switched = snapshot({ profileId: "profile-b", progressRevision: 1, awardRevision: 1 });
  unread.accept(switched);
  assert.equal(unread.refresh(), request);
  first.resolve(response(snapshot({ progressRevision: 20, awardRevision: 8 })));
  await secondStarted.promise;
  assert.deepEqual(unread.getSnapshot(), switched);
  second.resolve(response({ ...switched, progressRevision: 2 }));
  await request;
  assert.equal(calls, 2);
  assert.equal(unread.getSnapshot().profileId, "profile-b");
  assert.equal(unread.getSnapshot().progressRevision, 2);
  assert.equal(changes.length, 3);
});

test("shared refresh returns the current merged snapshot and background updates never acknowledge themselves", async (t) => {
  const calls = mockFetch(t);
  const unread = createAchievementUnread();
  unread.accept(snapshot());
  const request = unread.refresh();
  const confirmation = unread.markShown(shown());
  await Promise.resolve();
  const newer = snapshot({ progressRevision: 8, awardRevision: 4 });
  unread.accept(newer);
  calls[1].resolve(response({ seenThroughRevision: 3 }));
  assert.equal(await confirmation, true);
  calls[0].resolve(response(snapshot()));
  const returned = await request;
  assert.equal(returned, unread.getSnapshot());
  assert.deepEqual(returned, { ...newer, seenAwardRevision: 3 });
  assert.equal(calls.length, 2, "only the captured explicit confirmation sends a POST");
});

test("initial refresh failures reject for the dialog and release the request for a successful retry", async (t) => {
  const outcomes = [
    response({}, 503),
    new Error("offline"),
    {
      ok: true,
      json: async () => {
        throw new Error("invalid JSON");
      },
    },
    response({ state: "ready", rows: [] }),
    response(snapshot()),
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const next = outcomes[calls++];
    if (next instanceof Error) throw next;
    return next;
  });
  const unread = createAchievementUnread();
  for (const message of [/HTTP 503/, /offline/, /invalid JSON/, /Invalid achievement snapshot/]) {
    await assert.rejects(unread.refresh(), message);
    assert.equal(unread.getSnapshot(), null);
  }
  assert.equal(await unread.refresh(), unread.getSnapshot());
  assert.deepEqual(unread.getSnapshot(), snapshot());
  assert.equal(calls, 5);
});

test("valid preparing and ready transitions notify consumers and each refresh returns its accepted state", async (t) => {
  const preparing = snapshot({ state: "preparing", rows: null, progressRevision: 0, awardRevision: 0 });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => response(calls++ === 0 ? preparing : snapshot()));
  const states = [];
  const unread = createAchievementUnread({ onChange: (next) => states.push(next.state) });
  assert.deepEqual(await unread.refresh(), preparing);
  assert.deepEqual(await unread.refresh(), snapshot());
  assert.deepEqual(states, ["preparing", "ready"]);
  assert.equal(calls, 2);
});
