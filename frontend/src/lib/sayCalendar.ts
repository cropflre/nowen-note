import { formatLocalDateKey } from "./dailyRecords";
import { parseServerTime } from "./dateTime";

export interface MonthCell {
  date: number;
  dateKey: string;
  isCurrentMonth: boolean;
}

export function formatDateKey(year: number, month: number, day: number): string {
  const mm = String(Math.max(1, Math.min(12, month))).padStart(2, "0");
  const dd = String(Math.max(1, Math.min(31, day))).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export function getMonthGrid(year: number, month: number): MonthCell[] {
  const firstDay = new Date(year, month - 1, 1);
  let startIndex = firstDay.getDay();
  if (startIndex === 0) startIndex = 7;

  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: MonthCell[] = [];

  for (let i = 1; i < startIndex; i++) {
    const d = new Date(year, month - 1, 1 - (startIndex - i));
    cells.push({ date: d.getDate(), dateKey: formatDateKey(d.getFullYear(), d.getMonth() + 1, d.getDate()), isCurrentMonth: false });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ date: day, dateKey: formatDateKey(year, month, day), isCurrentMonth: true });
  }

  let nextDay = 1;
  while (cells.length < 42) {
    const d = new Date(year, month, nextDay);
    cells.push({ date: d.getDate(), dateKey: formatDateKey(d.getFullYear(), d.getMonth() + 1, d.getDate()), isCurrentMonth: false });
    nextDay++;
  }

  return cells;
}

export function groupDiariesByDate(items: { createdAt?: string | null }[]): Map<string, typeof items> {
  const map = new Map<string, typeof items>();
  for (const item of items) {
    const date = parseServerTime(item.createdAt);
    if (!date) continue;
    const dateKey = formatLocalDateKey(date);
    const arr = map.get(dateKey) || [];
    arr.push(item);
    map.set(dateKey, arr);
  }
  return map;
}
