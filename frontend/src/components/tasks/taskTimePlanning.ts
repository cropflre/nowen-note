import type { TaskTimeBlock } from "@/lib/taskTimePlanningApi";

export function formatLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localDayRange(dateKey: string): { from: string; to: string } {
  const [year, month, day] = dateKey.split("-").map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function combineLocalDateAndTime(dateKey: string, time: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour || 0, minute || 0, 0, 0).toISOString();
}

export function addMinutesIso(startAt: string, minutes: number): string {
  return new Date(Date.parse(startAt) + minutes * 60_000).toISOString();
}

export function minutesBetween(startAt: string, endAt: string): number {
  return Math.max(0, Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000));
}

export function formatMinutes(minutes: number, chinese = true): string {
  const normalized = Math.max(0, Math.round(minutes));
  const hours = Math.floor(normalized / 60);
  const remainder = normalized % 60;
  if (hours === 0) return chinese ? `${remainder} 分钟` : `${remainder}m`;
  if (remainder === 0) return chinese ? `${hours} 小时` : `${hours}h`;
  return chinese ? `${hours} 小时 ${remainder} 分钟` : `${hours}h ${remainder}m`;
}

export function findConflictingBlockIds(blocks: TaskTimeBlock[]): Set<string> {
  const conflicts = new Set<string>();
  const ordered = [...blocks].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  for (let i = 0; i < ordered.length; i += 1) {
    const current = ordered[i];
    const currentEnd = Date.parse(current.endAt);
    for (let j = i + 1; j < ordered.length; j += 1) {
      const next = ordered[j];
      if (Date.parse(next.startAt) >= currentEnd) break;
      if (Date.parse(current.startAt) < Date.parse(next.endAt)) {
        conflicts.add(current.id);
        conflicts.add(next.id);
      }
    }
  }
  return conflicts;
}

export function occupiedMinutes(blocks: TaskTimeBlock[]): number {
  const intervals = blocks
    .map((block) => [Date.parse(block.startAt), Date.parse(block.endAt)] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  if (intervals.length === 0) return 0;

  let total = 0;
  let [rangeStart, rangeEnd] = intervals[0];
  for (let i = 1; i < intervals.length; i += 1) {
    const [start, end] = intervals[i];
    if (start <= rangeEnd) {
      rangeEnd = Math.max(rangeEnd, end);
    } else {
      total += rangeEnd - rangeStart;
      rangeStart = start;
      rangeEnd = end;
    }
  }
  total += rangeEnd - rangeStart;
  return Math.round(total / 60_000);
}

export function nextHalfHour(date = new Date()): string {
  const next = new Date(date);
  next.setSeconds(0, 0);
  const minutes = next.getMinutes();
  if (minutes === 0 || minutes === 30) {
    next.setMinutes(minutes + 30);
  } else if (minutes < 30) {
    next.setMinutes(30);
  } else {
    next.setHours(next.getHours() + 1, 0, 0, 0);
  }
  return `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
}
