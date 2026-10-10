import cronParser from "cron-parser";

/** IANA time zones are validated at the API boundary before saving. */
export function isValidBackupTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Next daily backup instant.
 *
 * New settings carry an explicit IANA time zone. The schedule must follow
 * that zone independently of Node/Docker TZ, including DST transitions.
 * Existing settings without a timeZone preserve the original server-local
 * schedule until an administrator edits and saves them.
 */
export function nextDailyBackupRunAt(hhmm: string, timeZone?: string, from = new Date()): Date {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) {
    throw new Error("Invalid daily backup time");
  }
  const [hours, minutes] = hhmm.split(":").map(Number);
  if (timeZone) {
    if (!isValidBackupTimeZone(timeZone)) throw new Error("Invalid backup time zone");
    const cron = `${minutes} ${hours} * * *`;
    return cronParser.parseExpression(cron, { currentDate: from, tz: timeZone }).next().toDate();
  }

  // Legacy behavior: Node's process-local time zone, not the administrator's.
  const next = new Date(from);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}
