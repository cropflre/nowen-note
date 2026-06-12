import type { Task } from "@/types";

/** Get the effective date key for a task (dueAt > dueDate) */
export function getTaskDateKey(task: Task): string | null {
  if (task.dueAt) return task.dueAt.split("T")[0];
  if (task.dueDate) return task.dueDate;
  return null;
}

/**
 * Compute the update fields when moving a task to a target date.
 * Returns null if target date is the same as current (no-op).
 *
 * Rules:
 * - dueDate-only: update dueDate
 * - dueAt: preserve time part, replace date part, sync dueDate
 * - no dates: return null
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
