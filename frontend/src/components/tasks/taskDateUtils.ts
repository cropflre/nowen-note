import type { Task } from "@/types";

export function getDueTimeValue(dueAt: string | null | undefined): string {
  if (!dueAt) return "";
  const timePart = dueAt.replace(" ", "T").split("T")[1] || "";
  return timePart.slice(0, 5);
}

export function getDateValue(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(" ", "T").split("T")[0];
}

function hasExplicitTaskTime(value: string | null | undefined): boolean {
  if (!value) return false;
  return /(?:T|\s)\d{2}:\d{2}/.test(value);
}

export type TaskScheduleMode = "unscheduled" | "all-day" | "timed";

export function getTaskScheduleMode(
  task: Pick<Task, "startDate" | "dueDate" | "dueAt">,
): TaskScheduleMode {
  const hasDate = Boolean(getDateValue(task.startDate) || getDateValue(task.dueDate) || getDateValue(task.dueAt));
  if (!hasDate) return "unscheduled";
  return hasExplicitTaskTime(task.startDate) || hasExplicitTaskTime(task.dueDate) || hasExplicitTaskTime(task.dueAt)
    ? "timed"
    : "all-day";
}

export function isTaskAllDay(task: Pick<Task, "startDate" | "dueDate" | "dueAt">): boolean {
  return getTaskScheduleMode(task) === "all-day";
}

export function buildStartDateFromDateAndTime(dateValue: string | null | undefined, timeValue: string): string | null {
  if (!dateValue) return null;
  return timeValue ? `${dateValue}T${timeValue.slice(0, 5)}` : dateValue;
}

export function isTaskDateRangeInvalid(
  startDate: string | null | undefined,
  dueDate: string | null | undefined,
  dueAt: string | null | undefined,
): boolean {
  if (!startDate) return false;
  const end = dueAt || dueDate;
  if (!end) return false;

  const normalizedStart = startDate.replace(" ", "T");
  const normalizedEnd = end.replace(" ", "T");
  const startDay = normalizedStart.slice(0, 10);
  const endDay = normalizedEnd.slice(0, 10);
  if (startDay !== endDay) return startDay > endDay;
  if (!normalizedStart.includes("T") || !normalizedEnd.includes("T")) return false;
  return normalizedStart > normalizedEnd;
}

export function buildDueAtFromDateAndTime(dueDate: string | null | undefined, timeValue: string): string | null {
  if (!dueDate || !timeValue) return null;
  return `${dueDate}T${timeValue.slice(0, 5)}`;
}

export function buildDueDatePatch(task: Task, nextDueDate: string): Partial<Task> {
  if (!nextDueDate) {
    const patch: Partial<Task> = { dueDate: null, dueAt: null };
    if (task.repeatRule && task.repeatRule !== "none") {
      patch.repeatRule = "none";
      patch.repeatInterval = 1;
      patch.repeatEndDate = null;
      patch.repeatEndCount = null;
    }
    return patch;
  }

  const patch: Partial<Task> = { dueDate: nextDueDate };
  const timeValue = getDueTimeValue(task.dueAt);
  if (timeValue) patch.dueAt = buildDueAtFromDateAndTime(nextDueDate, timeValue);
  return patch;
}

/** Get the effective date key for a task (dueAt > dueDate) */
export function getTaskDateKey(task: Task): string | null {
  if (task.dueAt) return task.dueAt.split("T")[0];
  if (task.dueDate) return task.dueDate;
  return null;
}

function getComparableDueTime(task: Task): number {
  const dueStr = task.dueAt || (task.dueDate ? `${task.dueDate}T23:59:59` : null);
  if (!dueStr) return Number.POSITIVE_INFINITY;
  const dueMs = new Date(dueStr).getTime();
  return Number.isFinite(dueMs) ? dueMs : Number.POSITIVE_INFINITY;
}

export function compareTasksByDueTime(a: Task, b: Task): number {
  const byDue = getComparableDueTime(a) - getComparableDueTime(b);
  if (byDue !== 0) return byDue;
  const byCompleted = (a.isCompleted ?? 0) - (b.isCompleted ?? 0);
  if (byCompleted !== 0) return byCompleted;
  const bySort = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  if (bySort !== 0) return bySort;
  return (b.createdAt || "").localeCompare(a.createdAt || "");
}

/**
 * Compute the update fields when moving a task to a target date.
 * Returns null if target date is the same as current (no-op).
 *
 * Rules:
 * - dueDate-only: update dueDate
 * - dueAt: preserve time part, replace date part, sync dueDate
 * - no dates: assign dueDate to target date
 */
export function moveTaskToDate(task: Task, targetDateKey: string): Partial<Task> | null {
  const currentKey = getTaskDateKey(task);
  if (currentKey === targetDateKey) return null;

  const patch: Partial<Task> = {};
  if (task.dueAt) {
    const timePart = task.dueAt.split("T")[1] || "00:00:00";
    patch.dueAt = `${targetDateKey}T${timePart}`;
    patch.dueDate = targetDateKey;
  } else {
    patch.dueDate = targetDateKey;
  }
  return patch;
}
