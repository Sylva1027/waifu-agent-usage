import assert from "node:assert/strict";
import test from "node:test";
import { sourceAdapterDigest } from "../test-support/source-adapter-digest.mjs";

test("frozen source digests preserve field values and order while normalizing disposable paths", () => {
  assert.equal(sourceAdapterDigest({ b: -0, a: undefined }), sourceAdapterDigest({ a: undefined, b: -0 }));
  assert.equal(
    sourceAdapterDigest("/fixture/session.jsonl", [["/fixture/session.jsonl", "<source>"]]),
    sourceAdapterDigest("<source>"),
  );
  for (const [left, right] of [
    [-0, 0],
    [Infinity, null],
    [NaN, null],
    [undefined, null],
    [{ a: undefined }, {}],
    [
      [1, 2],
      [2, 1],
    ],
    [{ a: 1 }, { a: "1" }],
  ])
    assert.notEqual(sourceAdapterDigest(left), sourceAdapterDigest(right));
});
