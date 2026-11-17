export function invalidTimelineState(message) {
  /** @type {TypeError & { code?: string }} */
  const error = new TypeError(`Invalid timeline accumulator state: ${message}`);
  error.code = "TIMELINE_STATE_INVALID";
  return error;
}

export function requireState(condition, message) {
  if (!condition) throw invalidTimelineState(message);
}

export function finiteStateNumber(value, field) {
  requireState(typeof value === "number" && Number.isFinite(value), `${field} must be a finite number`);
  return value;
}
