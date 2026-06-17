import type { Task } from "@/types";

export function getDueTimeValue(dueAt: string | null | undefined): string {
  if (!dueAt) return "";
  const timePart = dueAt.split("T")[1] || "";
  return timePart.slice(0, 5);
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
