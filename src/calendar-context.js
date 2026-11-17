/** The service's actual IANA identity; never a browser preference or the string "local". */
export function calendarContext(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!timeZone || timeZone === "local") throw new TypeError("A fixed IANA calendar time zone is required");
  return { timeZone: new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone };
}
