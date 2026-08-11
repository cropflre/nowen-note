import type { Task } from "../../types";
import { getDateValue, getDueTimeValue } from "./taskDateUtils";

function preserveStartTime(dateValue: string, originalStartDate: string | null | undefined): string {
  const timeValue = getDueTimeValue(originalStartDate);
  return timeValue ? `${dateValue}T${timeValue}` : dateValue;
}

export function getTaskStartDate(task: Task): string | null {
  return getDateValue(task.startDate || task.dueDate) || null;
}

export function getTaskEndDate(task: Task): string | null {
  return getDateValue(task.dueDate || task.startDate) || null;
}

export function getTaskDurationDays(task: Task): number {
  const start = getTaskStartDate(task);
  const end = getTaskEndDate(task);
  if (!start || !end) return 1;
  const ms = new Date(end + 'T00:00:00').getTime() - new Date(start + 'T00:00:00').getTime();
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

export function moveTaskDateRange(task: Task, targetStartDate: string): { startDate: string; dueDate: string | null } | null {
  const currentStart = getTaskStartDate(task);
  const currentEnd = getTaskEndDate(task);
  if (!currentStart || !currentEnd) return null;
  if (currentStart === targetStartDate) return null;
  const startMs = new Date(currentStart + 'T00:00:00').getTime();
  const endMs = new Date(currentEnd + 'T00:00:00').getTime();
  const duration = endMs - startMs;
  const newStartMs = new Date(targetStartDate + 'T00:00:00').getTime();
  const newEndDate = new Date(newStartMs + duration);
  const ny = newEndDate.getFullYear();
  const nm = String(newEndDate.getMonth() + 1).padStart(2, '0');
  const nd = String(newEndDate.getDate()).padStart(2, '0');
  const newEnd = ny + '-' + nm + '-' + nd;
  return { startDate: preserveStartTime(targetStartDate, task.startDate), dueDate: newEnd };
}

export function isTaskScheduled(task: Task): boolean {
  return !!(task.startDate || task.dueDate);
}

export function buildTimelineDays(startDate: Date, count: number): Date[] {
  const days: Date[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

export function resizeTaskDateRange(
  task: Task,
  side: "start" | "end",
  targetDate: string
): { startDate: string; dueDate: string } | null {
  const start = getTaskStartDate(task);
  const end = getTaskEndDate(task);
  if (!start && !end) return null;

  if (side === "start") {
    const effectiveEnd = end || targetDate;
    if (targetDate > effectiveEnd) return null;
    return { startDate: preserveStartTime(targetDate, task.startDate), dueDate: effectiveEnd };
  } else {
    const effectiveStart = start || targetDate;
    if (effectiveStart > targetDate) return null;
    return { startDate: preserveStartTime(effectiveStart, task.startDate), dueDate: targetDate };
  }
}

export function getVisibleTaskBar(
  task: Task,
  days: Date[]
): { left: number; width: number; clippedStart: boolean; clippedEnd: boolean } | null {
  const start = getTaskStartDate(task);
  const end = getTaskEndDate(task);
  if (!start || !end || days.length === 0) return null;

  const taskStart = new Date(start + "T00:00:00");
  const taskEnd = new Date(end + "T00:00:00");
  const viewStart = days[0];
  const viewEnd = days[days.length - 1];

  // Task completely outside view
  if (taskEnd < viewStart || taskStart > viewEnd) return null;

  const clippedStart = taskStart < viewStart;
  const clippedEnd = taskEnd > viewEnd;

  const effectiveStart = clippedStart ? viewStart : taskStart;
  const effectiveEnd = clippedEnd ? viewEnd : taskEnd;

  // Find indices
  let left = 0;
  for (let i = 0; i < days.length; i++) {
    if (days[i] >= effectiveStart) { left = i; break; }
    if (i === days.length - 1) left = i;
  }

  let right = days.length - 1;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i] <= effectiveEnd) { right = i; break; }
    if (i === 0) right = 0;
  }

  const width = Math.max(1, right - left + 1);
  return { left, width, clippedStart, clippedEnd };
}
