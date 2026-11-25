import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { readOmpSnapshot } from "../src/omp-usage.js";

const header = { type: "session", version: 3, id: "s", cwd: "/omp-example", title: "private title" };
const timestamp = "2026-11-24T16:00:00.000Z";
const usage = { input: 60, output: 13, cacheRead: 20, cacheWrite: 7, reasoningTokens: 5, totalTokens: 100 };
function assistant(id = "native-a", fields = {}) {
  return {
    type: "message",
    id,
    timestamp,
    parentId: null,
    message: {
      role: "assistant",
      provider: "provider",
      api: "api",
      model: "model",
      timestamp: Date.parse(timestamp) - 500,
      responseId: "private response ID",
      serviceTier: "priority",
      stopReason: "error",
      content: "private text",
      usage: { ...usage, cost: { total: 0 } },
      ...fields,
    },
  };
}
function side(id = "native-b", fields = {}) {
  return {
    type: "model_usage",
    id,
    timestamp,
    parentId: null,
    provider: "provider",
    api: "api",
    model: "model",
    usage,
    stopReason: "aborted",
    completion: { prompt: "private prompt", reply: "private reply" },
    ...fields,
  };
}

function jsonl(records, trailing = true) {
  return records.map((row) => JSON.stringify(row)).join("\r\n") + (trailing ? "\r\n" : "");
}

async function setup(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "usage-omp-test-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = { id: "omp:fixture", label: "Oh My Pi", path: dir, approvedScanRoots: [dir] };
  const resolve = async () => ({ key: "directory:demo", path: "/omp-example", kind: "directory" });
  return async (body, name = "sessions/main.jsonl", overrides = {}) => {
    const filePath = path.join(dir, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    const events = [];
    const result = await readOmpSnapshot(filePath, home, {
      onEvent: (e) => events.push(e),
      repositoryResolver: resolve,
      ...overrides,
    });
    return { ...result, events };
  };
}

test("OMP reads both journal record types, merges orchestration, and projects only accounting fields", async (t) => {
  const read = await setup(t);
  const rows = [
    { type: "title", title: "private title" },
    header,
    assistant(),
    side("side", {
      usage: {
        ...usage,
        totalTokens: undefined,
        orchestration: { input: 3, cacheRead: 4, output: 2 },
        contextTokens: 999999,
      },
    }),
    { type: "message", message: { role: "toolResult", details: { usage } } },
  ];
  const result = await read(jsonl(rows), undefined, { maxRowsBytes: 0 });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.diagnostics, {});
  assert.equal(result.events.length, 2);
  const [a, b] = result.events;
  assert.equal(a.channel, "Oh My Pi");
  assert.equal(a.sourceKind, "omp");
  assert.equal(a.serviceTier, "fast");
  assert.equal(a.timestampMs, Date.parse(timestamp) - 500);
  assert.equal(a.omp.entryTimestampMs, Date.parse(timestamp));
  assert.equal(a.sourceEventId, a.omp.nativeKey);
  assert.match(a.omp.responseKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(a.usage, { total: 100, input: 87, cached: 20, output: 13, reasoning: 5 });
  assert.equal(a.detailMask, 47);
  assert.equal(a.cacheWriteTokens, 7);
  assert.equal(a.requestInputTokens, 87);
  assert.equal(b.serviceTier, "unknown");
  assert.equal(b.omp.responseKey, "");
  assert.equal(b.timestampMs, Date.parse(timestamp));
  assert.deepEqual(b.usage, { total: 109, input: 94, cached: 24, output: 15, reasoning: 0 });
  assert.equal(b.detailMask, 39);
  assert.doesNotMatch(JSON.stringify(result), /private (?:response ID|text|prompt|reply|title)/);
});

test("OMP detail known bits distinguish zero, missing, malformed and conflicting counters", async (t) => {
  const read = await setup(t);
  const result = await read(
    jsonl([
      header,
      side("partial", { usage: { ...usage, cacheWrite: "7", totalTokens: 100 } }),
      side("gap", { usage: { ...usage, totalTokens: 102 } }),
      side("bad-extra", { usage: { ...usage, orchestration: null } }),
      side("invalid-reason", { usage: { ...usage, reasoningTokens: 14 } }),
      side("partial-conflict", { usage: { totalTokens: 5, output: 8, cacheRead: 100, cacheWrite: 0 } }),
      side("partial-overflow", {
        usage: { totalTokens: Number.MAX_SAFE_INTEGER, input: Number.MAX_SAFE_INTEGER, cacheRead: 1 },
      }),
      side("missing", { usage: null }),
      side("cannot-sum", { usage: { input: true, output: 0 } }),
      side("zero-conflict", { usage: { ...usage, totalTokens: 0 } }),
      side("local", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }),
      side("overflow", { usage: { ...usage, input: Number.MAX_SAFE_INTEGER, totalTokens: undefined } }),
    ]),
  );
  assert.equal(result.status, "partial");
  assert.deepEqual(result.diagnostics, { OMP_MISSING_USAGE: 1, OMP_INCOMPLETE_USAGE: 2, OMP_CONFLICTING_TOTAL: 1 });
  assert.equal(result.events.length, 6);
  const [partial, gap, extra, reasoning, partialConflict, partialOverflow] = result.events;
  assert.deepEqual(partial.usage, { total: 100, input: 0, cached: 20, output: 13, reasoning: 5 });
  assert.equal(partial.contextLevel, "unknown");
  assert.equal(partial.cacheWriteKnown, false);
  assert.equal(partial.detailMask, 14);
  assert.equal(gap.detailMask, 16);
  assert.equal(gap.reconciliationGap, 2);
  assert.deepEqual(gap.usage, { total: 102, input: 0, cached: 0, output: 0, reasoning: 0 });
  assert.equal(extra.detailMask, 32);
  assert.equal(reasoning.usage.reasoning, 0);
  assert.equal(reasoning.detailMask, 39);
  assert.equal(partialConflict.detailMask, 16);
  assert.deepEqual(partialConflict.usage, { total: 5, input: 0, cached: 0, output: 0, reasoning: 0 });
  assert.equal(partialConflict.reconciliationGap, 103);
  assert.equal(partialOverflow.detailMask, 16);
  assert.equal(partialOverflow.reconciliationGap, 1);
});

test("OMP recognizes only the explicit sibling marker and preserves native and response identity across copies", async (t) => {
  const read = await setup(t);
  const kept = assistant();
  const before = await read(jsonl([header, kept]));
  const marker = {
    type: "branch_summary",
    id: "marker",
    parentId: null,
    fromId: "root",
    details: { kind: "discarded-entry-branch", discardedEntryId: kept.id },
  };
  const discarded = side("replaced", { purpose: "discarded-turn" });
  const after = await read(jsonl([header, discarded, marker]));
  const rewound = await read(
    jsonl([
      { ...header, id: "fork", parentSession: header.id },
      { ...kept, id: "new-native", timestamp: "2026-12-01T21:00:00Z" },
    ]),
  );
  const a = before.events[0],
    b = after.events[0],
    c = rewound.events[0];
  assert.equal(b.omp.discarded, true);
  assert.equal(a.sourceEventId, b.sourceEventId);
  assert.equal(a.omp.usageDigest, b.omp.usageDigest);
  assert.equal(b.omp.aliasKeys.length, 1);
  assert.notEqual(b.omp.aliasKeys[0], a.sourceEventId);
  assert.notEqual(c.sourceEventId, a.sourceEventId);
  assert.equal(c.omp.responseKey, a.omp.responseKey);
  assert.equal(c.omp.parentSession, "s");
  const invalid = await read(jsonl([header, discarded, { ...marker, parentId: "different" }]));
  assert.equal(invalid.status, "partial");
  assert.equal(invalid.diagnostics.OMP_UNRESOLVED_DISCARD, 1);
  assert.deepEqual(invalid.events, []);
});

test("OMP accepts only complete snapshots and keeps active tails pending", async (t) => {
  const read = await setup(t);
  const record = jsonl([header, assistant()]);
  const pending = await read(`${record}{"partial"`);
  assert.equal(pending.status, "partial");
  assert.deepEqual(pending.diagnostics, { OMP_INCOMPLETE_TAIL: 1 });
  assert.equal(pending.events.length, 1);
  const broken = await read(`${record}{"bad"\n`);
  assert.equal(broken.status, "error");
  assert.deepEqual(broken.events, []);
  const gz = gzipSync(jsonl([header, assistant()], false));
  assert.equal((await read(gz, "archive/sessions/archive.jsonl.gz")).events.length, 1);
  const truncated = await read(gz.subarray(0, gz.length - 4), "archive/sessions/archive.jsonl.gz");
  assert.equal(truncated.status, "error");
  assert.deepEqual(truncated.events, []);
  const long = await read(record, "sessions/main.jsonl", { maxLineBytes: 120 });
  assert.deepEqual(long.diagnostics, { OMP_LINE_TOO_LARGE: 1 });
  assert.deepEqual(long.events, []);
  const unsupported = await read(jsonl([{ ...header, version: 1 }, assistant()]));
  assert.equal(unsupported.status, "error");
  assert.equal(unsupported.diagnostics.OMP_UNSUPPORTED_SESSION_VERSION, 1);
  const foreign = await read(jsonl([{ type: "tool-output" }, assistant()]));
  assert.equal(foreign.status, "ignored");
});

test("OMP decodes UTF-8 split across chunks without treating Unicode separators as line breaks", async (t) => {
  const read = await setup(t);
  const prefix = `${jsonl([header])}{"type":"custom","text":"`;
  const padding = "a".repeat(65535 - Buffer.byteLength(prefix));
  const result = await read(`${prefix + padding}雪\u2028线\u2029"}\r\n${jsonl([assistant()])}`);
  assert.equal(result.status, "complete");
  assert.equal(result.events.length, 1);
});

test("OMP opens files only beneath a present approved root and rejects redirected roots", async (t) => {
  const read = await setup(t);
  const confirmed = await read(jsonl([header, assistant()]));
  const event = confirmed.events[0];
  const dir = path.dirname(event.sourcePath);
  const link = path.join(event.homePath, "redirect");
  async function blocked(file, roots) {
    const home = { id: event.homeId, label: event.homeLabel, path: event.homePath, approvedScanRoots: roots };
    const result = await readOmpSnapshot(file, home, { onEvent: () => assert.fail("unexpected event") });
    assert.equal(result.status, "error");
    assert.equal(result.diagnostics.OMP_OUTSIDE_SCAN_ROOT, 1);
  }
  await blocked(event.sourcePath, undefined);
  await blocked(event.sourcePath, []);
  try {
    await symlink(dir, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    t.diagnostic("The test filesystem disallows directory links.");
    return;
  }
  await blocked(path.join(link, "main.jsonl"), [link]);
});
