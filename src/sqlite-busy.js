// SQLite keeps the primary result code in the low byte of extended codes such as BUSY_SNAPSHOT.
export function isSqliteBusy(error) {
  return error?.code === "ERR_SQLITE_ERROR" && (Number(error.errcode) & 0xff) === 5;
}
