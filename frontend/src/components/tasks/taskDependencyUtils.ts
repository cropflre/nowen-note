import type { Task, TaskDependency } from "../../types";

/**
 * Build a map from task id to its row index in the visible task list.
 */
export function buildTaskRowIndex(tasks: Task[]): Map<string, number> {
  const map = new Map<string, number>();
  tasks.forEach((t, i) => map.set(t.id, i));
  return map;
}

/**
 * Compute SVG polyline points for a finish_to_start dependency line.
 * Returns an array of {x, y} points forming an elbow connector,
 * or null if either task is not in the visible rows.
 */
export function getDependencyLinePoints(
  predecessorBar: { left: number; width: number; row: number },
  successorBar: { left: number; width: number; row: number }
): { x: number; y: number }[] {
  // Start: right edge center of predecessor
  const startX = predecessorBar.left + predecessorBar.width;
  const startY = predecessorBar.row * 32 + 16; // 32px row height, center

  // End: left edge center of successor
  const endX = successorBar.left;
  const endY = successorBar.row * 32 + 16;

  const midX = startX + 8;

  // Elbow connector: right, then vertical, then horizontal to target
  if (Math.abs(startY - endY) < 1) {
    // Same row - just horizontal line
    return [
      { x: startX, y: startY },
      { x: endX, y: endY },
    ];
  }

  return [
    { x: startX, y: startY },
    { x: midX, y: startY },
    { x: midX, y: endY },
    { x: endX, y: endY },
  ];
}

/**
 * Check if adding predecessorId -> successorId would create a cycle.
 * Uses BFS from successorId following predecessor edges.
 */
export function wouldCreateCycle(
  dependencies: TaskDependency[],
  predecessorId: string,
  successorId: string
): boolean {
  if (predecessorId === successorId) return true;

  // Build forward adjacency: from each task, what tasks does it lead to (successors)?
  const successorMap = new Map<string, string[]>();
  for (const dep of dependencies) {
    const list = successorMap.get(dep.predecessorTaskId) || [];
    list.push(dep.successorTaskId);
    successorMap.set(dep.predecessorTaskId, list);
  }

  // BFS from successorId following forward edges.
  // If we can reach predecessorId, then adding predecessorId->successorId creates a cycle.
  const visited = new Set<string>();
  const queue = [successorId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === predecessorId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const nexts = successorMap.get(current) || [];
    for (const n of nexts) {
      if (!visited.has(n)) queue.push(n);
    }
  }
  return false;
}

/**
 * Get all dependencies where the given task is blocked by incomplete predecessors.
 * Returns the list of predecessor tasks that are not yet completed.
 */
export function getBlockingDependencies(
  taskId: string,
  dependencies: TaskDependency[],
  tasks: Task[]
): Task[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const blockers: Task[] = [];
  for (const dep of dependencies) {
    if (dep.successorTaskId !== taskId) continue;
    const pred = taskMap.get(dep.predecessorTaskId);
    if (pred && pred.isCompleted !== 1) {
      blockers.push(pred);
    }
  }
  return blockers;
}

/**
 * Check if a task is blocked by any incomplete dependency.
 */
export function isTaskBlockedByDependency(
  taskId: string,
  dependencies: TaskDependency[],
  tasks: Task[]
): boolean {
  return getBlockingDependencies(taskId, dependencies, tasks).length > 0;
}

export interface ScheduleWarning {
  blockingTasks: Task[];
  suggestedStartDate: string | null;
  suggestedDueDate: string | null;
  reason: "predecessor_incomplete" | "predecessor_overdue" | "date_overlap";
}

/**
 * Compute schedule warnings for a task based on its dependencies.
 * Returns a warning with suggested new dates if the task's current dates
 * conflict with incomplete predecessors, or null if no issue.
 */
export function getDependencyScheduleWarnings(
  taskId: string,
  dependencies: TaskDependency[],
  tasks: Task[]
): ScheduleWarning | null {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const task = taskMap.get(taskId);
  if (!task) return null;

  // Find incomplete predecessors
  const blockers = dependencies
    .filter((d) => d.successorTaskId === taskId)
    .map((d) => taskMap.get(d.predecessorTaskId))
    .filter((t): t is Task => !!t && t.isCompleted !== 1);

  if (blockers.length === 0) return null;

  // Find the latest dueDate among blockers
  const blockerDueDates = blockers
    .filter((t) => t.dueDate)
    .map((t) => t.dueDate!);
  if (blockerDueDates.length === 0) return null;

  const latestBlockerDue = blockerDueDates.sort().pop()!;
  const suggestedStart = addDays(latestBlockerDue, 1);

  // Check if current task dates need adjustment
  const currentStart = task.startDate?.slice(0, 10) || null;
  const currentDue = task.dueDate || null;
  const now = new Date();
  const todayStr = format(now);
  const isOverdue = blockers.some(
    (t) => t.dueDate && t.dueDate < todayStr
  );

  let needsReschedule = false;
  let reason: ScheduleWarning["reason"] = "predecessor_incomplete";

  if (currentStart && currentStart <= latestBlockerDue) {
    needsReschedule = true;
    reason = "date_overlap";
  } else if (currentDue && currentDue <= latestBlockerDue) {
    needsReschedule = true;
    reason = "date_overlap";
  } else if (!currentStart && !currentDue) {
    // No dates assigned yet - not a conflict
    return null;
  }

  if (isOverdue && !needsReschedule) {
    reason = "predecessor_overdue";
    needsReschedule = true;
  }

  if (!needsReschedule) return null;

  // Calculate suggested dates, preserving duration
  let suggestedStartDate: string | null = suggestedStart;
  let suggestedDueDate: string | null = null;

  if (currentStart && currentDue) {
    // Has both dates: preserve duration
    const duration = daysBetween(currentStart, currentDue);
    suggestedDueDate = addDays(suggestedStart, Math.max(0, duration));
  } else if (currentDue) {
    // Only dueDate: treat as single-day task
    suggestedDueDate = suggestedStart;
  } else if (currentStart) {
    // Only startDate: move start
    suggestedDueDate = null;
  }

  return {
    blockingTasks: blockers,
    suggestedStartDate,
    suggestedDueDate,
    reason,
  };
}

// Internal helpers
function format(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return format(d);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00");
  const db = new Date(b + "T00:00:00");
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

