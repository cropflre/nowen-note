import { parseServerTime } from "./dateTime";

/** SQLite UTC SQL and ISO 8601 are both normalized to the user's local calendar day. */
export function noteLocalDayKey(value: string): string | null {
  const date = parseServerTime(value);
  if (!date) return null;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Mobile knowledge-tree timestamps always use the same UTC parsing contract. */
export function formatKnowledgeTreeUpdatedAt(value: string, locale: string): string {
  const parsed = parseServerTime(value);
  if (!parsed) return "";
  const now = new Date();
  const sameYear = parsed.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: "numeric" as const }),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}
