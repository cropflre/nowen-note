import type { Task } from "@/types";
import { formatDateKeyInTimeZone, parseServerTime } from "@/lib/dateTime";

export function isTaskCompletedToday(task: Task, now = new Date()): boolean {
  if (!task.isCompleted || !task.completedAt) return false;
  const date = parseServerTime(task.completedAt);
  return !!date && Number.isFinite(date.getTime())
    && formatDateKeyInTimeZone(date) === formatDateKeyInTimeZone(now);
}

