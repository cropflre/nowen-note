import { automationScannerRepository } from "../repositories";

/**
 * Lightweight automation scanners for Phase 6.4.
 *
 * These produce system reminders that enter the same recent ring buffer as
 * normal task reminders. They do not modify tasks, dates or statuses.
 */
export interface SystemReminder {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  userId: string;
  type: "task_reminder" | "dependency_ready" | "overdue_daily";
}

// In-memory dedup sets (reset on process restart — acceptable).
const dependencyReadySent = new Set<string>();
const overdueDailySent = new Set<string>();

/** Notify successors only when every finish-to-start predecessor is complete. */
export async function scanDependencyReadyNotifications(): Promise<SystemReminder[]> {
  const rows = await automationScannerRepository.listDependencyReadyTasksAsync();
  const results: SystemReminder[] = [];

  for (const row of rows) {
    const key = `dep-ready:${row.userId}:${row.successorTaskId}`;
    if (dependencyReadySent.has(key)) continue;
    dependencyReadySent.add(key);

    results.push({
      reminderId: `dep-ready:${row.successorTaskId}`,
      taskId: row.successorTaskId,
      taskTitle: row.succTitle,
      userId: row.userId,
      type: "dependency_ready",
    });
  }

  return results;
}

/** Produce at most one overdue reminder per task and local calendar day. */
export async function scanOverdueDailyNotifications(): Promise<SystemReminder[]> {
  const now = new Date();
  const nowMs = now.getTime();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const rows = await automationScannerRepository.listOverdueCandidatesAsync();
  const results: SystemReminder[] = [];

  for (const row of rows) {
    const dueString = row.dueAt || (row.dueDate ? `${row.dueDate}T23:59:59` : null);
    if (!dueString) continue;

    const dueMs = new Date(dueString).getTime();
    if (!Number.isFinite(dueMs) || dueMs >= nowMs) continue;

    const key = `${row.userId}:${row.id}:${todayLocal}`;
    if (overdueDailySent.has(key)) continue;
    overdueDailySent.add(key);

    results.push({
      reminderId: `overdue-daily:${row.id}:${todayLocal}`,
      taskId: row.id,
      taskTitle: row.title,
      userId: row.userId,
      type: "overdue_daily",
    });
  }

  return results;
}

/** Reset dedup sets for tests. */
export function resetAutomationDedup(): void {
  dependencyReadySent.clear();
  overdueDailySent.clear();
}
