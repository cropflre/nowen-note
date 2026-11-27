import {
  formatAppDateTime,
  formatDateKeyInTimeZone,
  getAppTimeZoneParts,
  parseServerTime,
} from "./dateTime";

/** SQLite UTC SQL and ISO 8601 are both normalized to the user's configured calendar day. */
export function noteLocalDayKey(value: string): string | null {
  const date = parseServerTime(value);
  if (!date) return null;
  return formatDateKeyInTimeZone(date);
}

/** Mobile knowledge-tree timestamps always use the same UTC parsing contract. */
export function formatKnowledgeTreeUpdatedAt(value: string, locale: string): string {
  const parsed = parseServerTime(value);
  if (!parsed) return "";
  const sameYear = getAppTimeZoneParts(parsed).year === getAppTimeZoneParts(new Date()).year;
  return formatAppDateTime(
    parsed,
    {
      ...(sameYear ? {} : { year: "numeric" as const }),
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
    "",
    locale,
  );
}
