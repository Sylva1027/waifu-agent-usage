import { createUsageFactStoreClass } from "./usage-fact-store.js";
import { UsageProjectionOwner } from "./usage-projection-owner.js";

export { STORE_SCHEMA_VERSION } from "./usage-fact-store.js";
export class UsageStore extends createUsageFactStoreClass(UsageProjectionOwner) {}
