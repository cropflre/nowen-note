export type DailyRecordsView = "moments" | "calendar" | "journal";

export function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

export function parseLocalDateKey(dateKey: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new Error(`Invalid local date key: ${dateKey}`);
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0);
  if (
    date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)
  ) {
    throw new Error(`Invalid calendar date: ${dateKey}`);
  }
  return date;
}

export function shiftLocalDateKey(dateKey: string, days: number): string {
  const date = parseLocalDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return formatLocalDateKey(date);
}

export function shiftLocalMonthKey(dateKey: string, months: number): string {
  const source = parseLocalDateKey(dateKey);
  const sourceDay = source.getDate();
  const target = new Date(source.getFullYear(), source.getMonth() + months, 1, 12, 0, 0, 0);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12, 0, 0, 0).getDate();
  target.setDate(Math.min(sourceDay, lastDay));
  return formatLocalDateKey(target);
}

export function relativeLocalDateKey(offsetDays: number, now = new Date()): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return formatLocalDateKey(date);
}

export function formatJournalHeading(dateKey: string, locale = "zh-CN"): string {
  const date = parseLocalDateKey(dateKey);
  const dateLabel = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  return `${dateLabel} ${weekday}`;
}

export function formatCurrentTimestamp(now = new Date()): string {
  return `${formatLocalDateKey(now)} ${padDatePart(now.getHours())}:${padDatePart(now.getMinutes())}`;
}

function collectTiptapText(node: unknown, chunks: string[]): void {
  if (!node || typeof node !== "object") return;
  const value = node as { type?: unknown; text?: unknown; content?: unknown[] };
  if (typeof value.text === "string") chunks.push(value.text);
  if (Array.isArray(value.content)) {
    for (const child of value.content) collectTiptapText(child, chunks);
  }
  if (
    value.type === "paragraph"
    || value.type === "heading"
    || value.type === "blockquote"
    || value.type === "listItem"
    || value.type === "taskItem"
    || value.type === "codeBlock"
  ) {
    chunks.push("\n");
  }
}

export function extractJournalPreview(content: string, contentText = "", maxLength = 800): string {
  const fallback = contentText.trim();
  let text = fallback;

  if (!text && content.trim()) {
    try {
      const parsed = JSON.parse(content) as unknown;
      const chunks: string[] = [];
      collectTiptapText(parsed, chunks);
      text = chunks.join("");
    } catch {
      text = content
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
        .replace(/[*_`>~-]/g, "");
    }
  }

  // The journal card is a compact read-only overview rather than the editor canvas.
  // Preserve real line breaks, but collapse empty paragraph separators produced by
  // Tiptap contentText or Markdown so each paragraph does not consume a blank row.
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]*\n+/g, "\n")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}…`;
}

export function loadDailyRecordsView(): DailyRecordsView {
  try {
    const value = localStorage.getItem("nowen.dailyRecords.view");
    if (value === "moments" || value === "calendar" || value === "journal") return value;
  } catch {
    // Ignore unavailable storage (SSR/private mode).
  }
  return "moments";
}

export function saveDailyRecordsView(view: DailyRecordsView): void {
  try {
    localStorage.setItem("nowen.dailyRecords.view", view);
  } catch {
    // The view still works for the current session when persistence is unavailable.
  }
}
