const TRIGGERS = ["usage_record_dirty_insert", "usage_record_dirty_update", "usage_record_dirty_delete"];

/** Remove only legacy persistent record triggers; safe for the common/Lite fact opener. */
export function removeLegacyUsageRecordTriggers(database) {
  const present = database
    .prepare(
      `SELECT 1 FROM main.sqlite_schema WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => "?").join(",")}) LIMIT 1`,
    )
    .get(...TRIGGERS);
  if (!present) return false;
  database.exec("SAVEPOINT usage_record_trigger_migration");
  try {
    for (const name of TRIGGERS) database.exec(`DROP TRIGGER IF EXISTS main.${name}`);
    database.exec("RELEASE usage_record_trigger_migration");
    return true;
  } catch (error) {
    try {
      database.exec("ROLLBACK TO usage_record_trigger_migration");
      database.exec("RELEASE usage_record_trigger_migration");
    } catch {
      // Preserve the migration failure if the connection also fails during cleanup.
    }
    throw error;
  }
}
