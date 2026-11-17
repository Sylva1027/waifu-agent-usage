import { HistoryProjectionStore as UsageHistoryProjectionStore } from "../usage-history-projection-store.js";
import { ensureUsageAllSummarySchema, markStoredHistoryAllSummaryDirty } from "../usage-all-summary-store.js";
import { ensureUsageRecordSchema, markStoredHistoryRecordsDirty } from "../usage-record-store.js";
import { createEventPricing } from "../pricing.js";
import { createWaifuAllSummaryExtension } from "./usage-all-summary.js";

export * from "../usage-history-projection-store.js";

const RECORD_OPERATIONS = "usage_history_record_cache_operations";
const summaryOptions = () => ({ mode: "history", extension: createWaifuAllSummaryExtension(createEventPricing()) });
const revision = (database) =>
  database.prepare("SELECT revision FROM main.usage_business_revision WHERE singleton=1").get().revision;

function covered(database) {
  const operations = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
    .get(RECORD_OPERATIONS);
  return Boolean(
    operations &&
      database.prepare(`SELECT * FROM ${RECORD_OPERATIONS} WHERE slot=1`).get()?.maintained_revision ===
        revision(database),
  );
}

/** The fact carrier owns publication/recovery; only this concrete owner maintains Waifu projections. */
export class HistoryProjectionStore extends UsageHistoryProjectionStore {
  ensureDerivedSchema(database) {
    database.exec("SAVEPOINT waifu_history_projection_schema");
    try {
      super.ensureDerivedSchema(database);
      const options = summaryOptions();
      ensureUsageAllSummarySchema(database, options);
      ensureUsageRecordSchema(database, { mode: "history" });
      if (!covered(database)) {
        // A pure carrier can advance shared facts without maintaining either Waifu projection.
        database.exec(`DELETE FROM usage_history_record_cache; DELETE FROM ${options.extension.tables.history.STATE}`);
        database.prepare(`UPDATE ${RECORD_OPERATIONS} SET maintained_revision=? WHERE slot=1`).run(revision(database));
      }
      database.exec("RELEASE waifu_history_projection_schema");
    } catch (error) {
      database.exec("ROLLBACK TO waifu_history_projection_schema; RELEASE waifu_history_projection_schema");
      throw error;
    }
  }

  markDerivedDirty(database, dirty) {
    super.markDerivedDirty(database, dirty);
    markStoredHistoryAllSummaryDirty(database, dirty, summaryOptions());
    for (const row of database.prepare("SELECT timestamp_ms FROM history_projection_dirty_times").iterate()) {
      markStoredHistoryRecordsDirty(database, { ms: Number(row.timestamp_ms), id: Number.MIN_SAFE_INTEGER });
    }
    database.prepare(`UPDATE ${RECORD_OPERATIONS} SET maintained_revision=? WHERE slot=1`).run(revision(database));
  }

  openPublished(source, identity, calendar) {
    const published = super.openPublished(source, identity, calendar);
    if (!published || covered(published.database)) return published;
    published.database.close();
    return null;
  }
}
