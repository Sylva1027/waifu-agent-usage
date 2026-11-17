import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Literal contract oracle; no production parser, normalizer or accumulator builds these values.
const CASES = [
  { id: "A", detailMask: 15, total: { total: 120, input: 100, cached: 40, output: 20, reasoning: 5 } },
  { id: "B", detailMask: 15, total: { total: 60, input: 50, cached: 10, output: 10, reasoning: 2 } },
  { id: "C", detailMask: 5, total: { total: 100, input: 80, cached: 0, output: 20, reasoning: 0 } },
  { id: "D", detailMask: 0, total: { total: 30, input: 0, cached: 0, output: 0, reasoning: 0 } },
];
const EXPECTED = {
  eventCount: 4,
  sessionCount: 4,
  totals: { total: 310, input: 230, cached: 50, output: 50, reasoning: 7 },
  cacheRateInput: 150,
  cacheRateCached: 50,
  cacheHitRate: 1 / 3,
};

export function createLiteEditionFixture() {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(path.join(parent, "lite-edition-"));
  const originalRoot = realpathSync(root);
  let closed = false;
  const close = () => {
    if (closed) return;
    assert.equal(path.dirname(root), parent);
    if (existsSync(root)) {
      assert.equal(realpathSync(root), originalRoot, "refuse cleanup of a replaced fixture root");
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    closed = true;
  };
  try {
    const codexHome = path.join(root, "codex-fixture");
    const sessions = path.join(codexHome, "sessions");
    mkdirSync(sessions, { recursive: true });
    const events = structuredClone(CASES).map(({ id, ...event }, index) => ({
      ...event,
      timestamp: `2026-11-16T12:0${index}:00.000Z`,
      sessionId: `lite-${id}`,
      homeId: "lite-fixture",
      channel: "Codex",
      sourceKind: "codex",
      model: "gpt-6-sol",
      project: root,
    }));
    const rolloutFiles = events.map((event) => {
      const usage = { total_tokens: event.total.total };
      for (const [key, rawKey, bit] of [
        ["input", "input_tokens", 1],
        ["cached", "cached_input_tokens", 2],
        ["output", "output_tokens", 4],
        ["reasoning", "reasoning_output_tokens", 8],
      ]) {
        if (event.detailMask & bit) usage[rawKey] = event.total[key];
      }
      const rows = [
        { type: "session_meta", payload: { id: event.sessionId, source: "cli", cwd: root } },
        { type: "turn_context", payload: { model: event.model } },
        {
          type: "event_msg",
          timestamp: event.timestamp,
          payload: { type: "token_count", info: { last_token_usage: usage } },
        },
      ];
      const file = path.join(sessions, `${event.sessionId}.jsonl`);
      writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
      return file;
    });
    const options = {
      homeDir: root,
      env: {},
      extraHomes: codexHome,
      importDirs: [],
      automaticDiscoveryEnabled: false,
      pricingRefreshSchedulerEnabled: false,
      databaseFile: path.join(root, "usage.sqlite"),
      importStoreFile: path.join(root, "imports.json"),
    };
    const now = "2026-11-16T13:00:00.000Z";
    return {
      root,
      codexHome,
      rolloutFiles,
      events,
      report: { events, homes: [{ id: "lite-fixture", path: codexHome, kind: "codex" }], generatedAt: now },
      options,
      filters: { preset: "all", bucket: "day", now },
      expected: structuredClone(EXPECTED),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
