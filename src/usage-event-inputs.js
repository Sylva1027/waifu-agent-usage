/** Preserve request-input validity; rate thresholds belong to the pricing reader. */
export function requestInputFacts(known, input) {
  return {
    requestInputTokens: known ? input : 0,
    contextLevel: known ? "known" : "unknown",
  };
}
