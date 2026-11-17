import { canonicalFactPayload } from "./usage-sql.js";

// Compare source facts across editions without changing stored/archived payloads.
export function sourceFactIdentity(row, excludedColumns = []) {
  const payload = canonicalFactPayload(row, excludedColumns);
  if (Object.hasOwn(payload, "request_input_tokens")) {
    delete payload.price_version;
    if (payload.context_level === "short" || payload.context_level === "long") payload.context_level = "known";
  }
  return payload;
}
