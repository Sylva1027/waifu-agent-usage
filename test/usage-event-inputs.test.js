import assert from "node:assert/strict";
import test from "node:test";
import { requestInputFacts } from "../src/usage-event-inputs.js";
import { estimateEventCost } from "../src/pricing.js";

test("request facts retain zero and unknown validity without applying rate thresholds", () => {
  assert.deepEqual(requestInputFacts(true, 0), { requestInputTokens: 0, contextLevel: "known" });
  assert.deepEqual(requestInputFacts(false, 300_000), { requestInputTokens: 0, contextLevel: "unknown" });
  for (const input of [272_000, 272_001, 1_000_000]) {
    assert.deepEqual(requestInputFacts(true, input), { requestInputTokens: input, contextLevel: "known" });
  }
});

test("Waifu derives the same rates from raw request facts as from legacy context tiers", () => {
  for (const model of ["gpt-6-sol", "gpt-6.1-sol", "claude-sonnet-4-5", "unknown-future"]) {
    for (const input of [0, 272_000, 272_001, 500_001]) {
      const event = {
        model,
        ...requestInputFacts(true, input),
        detailMask: 15,
        cacheWriteTokens: 0,
        cacheWriteKnown: true,
        serviceTier: "standard",
        total: { total: input + 10, input, cached: 0, output: 10, reasoning: 0 },
      };
      assert.deepEqual(
        estimateEventCost(event),
        estimateEventCost({
          ...event,
          contextLevel: input > 272_000 ? "long" : "short",
        }),
        `${model}/${input}`,
      );
    }
  }
});
