import type { Task } from "@/types";
import type { TaskSavedViewFilters } from "@/lib/taskMetadataApi";

function dateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  return dateKey(new Date(year, month - 1, day + days));
}

function dueKey(task: Task): string | null {
  const match = (task.dueAt || task.dueDate || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function statusOf(task: Task): "todo" | "doing" | "blocked" | "done" {
  if (task.isCompleted === 1) return "done";
  return task.status || "todo";
}

function matchesDue(task: Task, due: TaskSavedViewFilters["due"], today: string): boolean {
  if (due === "all") return true;
  if (due === "completed") return task.isCompleted === 1;
  if (due === "pending") return task.isCompleted !== 1;
  if (task.isCompleted === 1) return false;
  const value = dueKey(task);
  if (!value) return false;
  if (due === "today") return value === today;
  if (due === "overdue") return value < today;
  if (due === "week") return value >= today && value <= addDays(today, 6);
  return true;
}

export function hasTaskSavedViewFilters(filters: TaskSavedViewFilters): boolean {
  return filters.labelIds.length > 0
    || filters.priorities.length > 0
    || filters.statuses.length > 0
    || filters.due !== "all"
    || !!filters.keyword.trim()
    || filters.projectId !== undefined;
}

export function filterTasksBySavedView(
  tasks: Task[],
  filters: TaskSavedViewFilters,
  assignments: Record<string, string[]>,
  today = dateKey(),
): Task[] {
  const keyword = filters.keyword.trim().toLocaleLowerCase();
  const priorities = new Set(filters.priorities);
  const statuses = new Set(filters.statuses);

  return tasks.filter((task) => {
    if (!matchesDue(task, filters.due, today)) return false;
    if (priorities.size > 0 && !priorities.has(task.priority)) return false;
    if (statuses.size > 0 && !statuses.has(statusOf(task))) return false;

    if (filters.projectId !== undefined) {
      if (filters.projectId === null && task.projectId !== null) return false;
      if (typeof filters.projectId === "string" && task.projectId !== filters.projectId) return false;
    }

    if (filters.labelIds.length > 0) {
      const taskLabels = new Set(assignments[task.id] || []);
      const matches = filters.labelMode === "all"
        ? filters.labelIds.every((id) => taskLabels.has(id))
        : filters.labelIds.some((id) => taskLabels.has(id));
      if (!matches) return false;
    }

    if (keyword) {
      const haystack = `${task.title}\n${task.description || ""}`.toLocaleLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

export function countTaskSavedViewFilters(filters: TaskSavedViewFilters): number {
  return Number(filters.labelIds.length > 0)
    + Number(filters.priorities.length > 0)
    + Number(filters.statuses.length > 0)
    + Number(filters.due !== "all")
    + Number(!!filters.keyword.trim())
    + Number(filters.projectId !== undefined);
}
