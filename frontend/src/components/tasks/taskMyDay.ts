import type { Task } from "@/types";

export interface MyDayPlanState {
  taskIds: string[];
  focusTaskIds: string[];
}

export function formatMyDayDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function taskDateKey(task: Task): string | null {
  if (task.dueAt) return task.dueAt.slice(0, 10);
  return task.dueDate || null;
}

export function isTaskDueToday(task: Task, today: string): boolean {
  return !task.isCompleted && taskDateKey(task) === today;
}

export function isTaskOverdue(task: Task, today: string): boolean {
  const date = taskDateKey(task);
  return !task.isCompleted && !!date && date < today;
}

export function isTaskStartingToday(task: Task, today: string): boolean {
  return !task.isCompleted && task.startDate?.slice(0, 10) === today;
}

export function normalizeMyDayPlan(
  taskIds: string[],
  focusTaskIds: string[],
  existingTaskIds?: Set<string>,
): MyDayPlanState {
  const uniqueTaskIds = Array.from(new Set(taskIds.filter(Boolean)))
    .filter((id) => !existingTaskIds || existingTaskIds.has(id))
    .slice(0, 200);
  const taskIdSet = new Set(uniqueTaskIds);
  const uniqueFocusIds = Array.from(new Set(focusTaskIds.filter(Boolean)))
    .filter((id) => taskIdSet.has(id))
    .slice(0, 3);
  return { taskIds: uniqueTaskIds, focusTaskIds: uniqueFocusIds };
}

export function getMyDaySuggestions(
  tasks: Task[],
  today: string,
  plannedTaskIds: string[],
): Task[] {
  const planned = new Set(plannedTaskIds);
  return tasks
    .filter((task) => {
      if (task.isCompleted || planned.has(task.id)) return false;
      return isTaskOverdue(task, today) || isTaskDueToday(task, today) || isTaskStartingToday(task, today);
    })
    .sort((a, b) => {
      const aOverdue = isTaskOverdue(a, today) ? 1 : 0;
      const bOverdue = isTaskOverdue(b, today) ? 1 : 0;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return (taskDateKey(a) || "9999-12-31").localeCompare(taskDateKey(b) || "9999-12-31");
    });
}

export function orderMyDayTasks(
  tasks: Task[],
  plan: MyDayPlanState,
): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const focus = new Set(plan.focusTaskIds);
  return plan.taskIds
    .map((id) => byId.get(id))
    .filter((task): task is Task => !!task)
    .sort((a, b) => {
      const aFocus = focus.has(a.id) ? 1 : 0;
      const bFocus = focus.has(b.id) ? 1 : 0;
      if (aFocus !== bFocus) return bFocus - aFocus;
      if (a.isCompleted !== b.isCompleted) return a.isCompleted - b.isCompleted;
      return plan.taskIds.indexOf(a.id) - plan.taskIds.indexOf(b.id);
    });
}
