import assert from "node:assert/strict";
import test from "node:test";
import { createAchievementNotice } from "../public/achievement-notice.js";

test("notice is appended to the refresh well and only accepts a ready, valid unread revision", (t) => {
  const attributes = new Map();
  const button = Object.assign(new EventTarget(), {
    dataset: {},
    setAttribute: (name, value) => attributes.set(name, value),
  });
  const appended = [];
  const old = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag) => {
        assert.equal(tag, "button");
        return button;
      },
      querySelector: (selector) => {
        assert.equal(selector, ".auto-refresh-well");
        return { append: (node) => appended.push(node) };
      },
    },
  });
  t.after(() => (old ? Object.defineProperty(globalThis, "document", old) : delete globalThis.document));
  let opened = 0;
  const notice = createAchievementNotice({ onOpen: () => opened++ });
  assert.deepEqual(appended, [button]);
  assert.equal(button.hidden, true);
  assert.equal(button.textContent, "新成就");
  assert.equal(attributes.get("aria-haspopup"), "dialog");
  assert.equal(attributes.get("aria-controls"), "achievementDialog");
  for (const snapshot of [
    null,
    {},
    { state: "preparing", awardRevision: 1, seenAwardRevision: 0 },
    ...[
      [-1, 0],
      [0, 0],
      [2, 2],
      [2, 3],
      [2, -1],
      ["2", 0],
      [2, "0"],
      [1.5, 0],
      [2, NaN],
      [Infinity, 0],
      [Number.MAX_SAFE_INTEGER + 1, 0],
    ].map(([awardRevision, seenAwardRevision]) => ({ state: "ready", awardRevision, seenAwardRevision })),
  ]) {
    notice.update(snapshot);
    assert.equal(button.hidden, true, JSON.stringify(snapshot));
  }
  notice.update({ state: "ready", awardRevision: 2, seenAwardRevision: 1 });
  assert.equal(button.hidden, false);
  button.dispatchEvent(new Event("click"));
  assert.equal(opened, 1);
  assert.equal(button.hidden, false, "Clicking delegates viewing; it cannot acknowledge an award");
  notice.update({ state: "ready", awardRevision: 2, seenAwardRevision: 2 });
  assert.equal(button.hidden, true);

  let attempted = 0;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: () => {
        attempted++;
        return { matches: true };
      },
    },
  });
  t.after(() =>
    previousWindow ? Object.defineProperty(globalThis, "window", previousWindow) : delete globalThis.window,
  );
  const accept = (profileId, awardRevision, seenAwardRevision = 0, state = "ready") =>
    notice.update({ profileId, state, awardRevision, seenAwardRevision });
  accept("a", 8);
  accept("a", 8);
  accept("b", 101);
  accept("b", 101, 0, "preparing");
  assert.equal(attempted, 0, "initial unread and profile changes only establish a baseline");
  accept("b", 102);
  assert.equal(attempted, 1, "a temporary preparing state retains the ready revision watermark");
  accept("b", 102, 1);
  accept("b", 101);
  accept("b", 102);
  accept("b", 103, 103);
  accept("c", 1);
  assert.equal(attempted, 1, "seen awards, repeat/stale snapshots and new profiles never replay");
  accept("c", 2);
  assert.equal(attempted, 2, "a later unread revision after switching profiles is eligible");
});
