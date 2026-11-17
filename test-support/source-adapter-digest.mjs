import { createHash } from "node:crypto";

// Preserve every field, array position and special number while replacing fixture paths.
export function sourceAdapterDigest(value, paths = []) {
  function canonical(item) {
    if (typeof item === "string") {
      for (const [from, to] of paths) item = item.replaceAll(from, to);
      return ["string", item];
    }
    if (typeof item === "number") return ["number", Object.is(item, -0) ? "-0" : String(item)];
    if (Array.isArray(item)) return ["array", item.map(canonical)];
    if (item && typeof item === "object")
      return ["object", Object.keys(item).sort().map((key) => [key, canonical(item[key])])];
    return [typeof item, String(item)];
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
