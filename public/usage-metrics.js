/** @param {{ cacheRateInput?: number, cacheRateCached?: number } | null | undefined} details */
export function cacheHitRate(details) {
  // The existing details aggregate selects valid input/cached pairs, including legacy mask semantics.
  const input = details?.cacheRateInput;
  const cached = details?.cacheRateCached;
  if (!Number.isFinite(input) || !Number.isFinite(cached) || input <= 0 || cached < 0 || cached > input) {
    return null;
  }
  return cached / input;
}
