import type { Task } from "@/types";

export type TaskOrderComparator = (left: Task, right: Task) => number;

export function isTaskCompleted(task: Pick<Task, "isCompleted">): boolean {
  return Number(task.isCompleted) === 1;
}

/**
 * Stable presentation ordering for task lists. Completion is the primary key, while the optional
 * comparator controls ordering inside the pending and completed groups. The persisted sortOrder is
 * intentionally left untouched.
 */
export function orderTasksCompletedLast(
  tasks: readonly Task[],
  compareWithinGroup?: TaskOrderComparator,
): Task[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const completionDelta = Number(isTaskCompleted(left.task)) - Number(isTaskCompleted(right.task));
      if (completionDelta !== 0) return completionDelta;
      const compared = compareWithinGroup?.(left.task, right.task) ?? 0;
      return compared !== 0 ? compared : left.index - right.index;
    })
    .map(({ task }) => task);
}

export function haveSameTaskCompletionState(
  left: Pick<Task, "isCompleted">,
  right: Pick<Task, "isCompleted">,
): boolean {
  return isTaskCompleted(left) === isTaskCompleted(right);
}
