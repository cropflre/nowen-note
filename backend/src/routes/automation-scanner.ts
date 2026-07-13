import { getDb } from "../db/schema";

/**
 * Lightweight automation scanners for Phase 6.4.
 *
 * These produce "system reminders" that enter the same recent ring buffer
 * as normal task reminders. They do NOT modify tasks, dates, or statuses.
 */

export interface SystemReminder {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  userId: string;
  type: "task_reminder" | "dependency_ready" | "overdue_daily";
}

// In-memory dedup sets (reset on process restart — acceptable)
const dependencyReadySent = new Set<string>();
const overdueDailySent = new Set<string>();

/**
 * Scan for dependencies where ALL predecessors of a successor are completed.
 * Only then notify that the successor can start.
 *
 * Dedup: per userId+successorId, in-memory. Restart re-notifies (acceptable).
 */
export function scanDependencyReadyNotifications(): SystemReminder[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT DISTINCT
      succ.id AS successorTaskId,
      succ.title AS succTitle,
      succ.userId AS userId
    FROM task_dependencies d
    JOIN tasks succ ON succ.id = d.successorTaskId
    WHERE d.type = 'finish_to_start'
      AND succ.isCompleted = 0
      AND NOT EXISTS (
        SELECT 1
        FROM task_dependencies d2
        JOIN tasks pred2 ON pred2.id = d2.predecessorTaskId
        WHERE d2.successorTaskId = d.successorTaskId
          AND d2.type = 'finish_to_start'
          AND pred2.isCompleted != 1
      )
  `).all() as any[];

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

/**
 * Scan for overdue tasks and produce a daily reminder.
 *
 * Uses JS-side time comparison for dueAt. Each task gets at most one overdue
 * reminder per local calendar day.
 */
export function scanOverdueDailyNotifications(): SystemReminder[] {
  const db = getDb();
  const now = new Date();
  const nowMs = now.getTime();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const rows = db.prepare(`
    SELECT id, title, userId, dueAt, dueDate
    FROM tasks
    WHERE isCompleted = 0
      AND (dueAt IS NOT NULL OR dueDate IS NOT NULL)
  `).all() as any[];

  const results: SystemReminder[] = [];
  for (const row of rows) {
    const dueStr = row.dueAt || (row.dueDate ? row.dueDate + "T23:59:59" : null);
    if (!dueStr) continue;

    const dueMs = new Date(dueStr).getTime();
    if (!Number.isFinite(dueMs)) continue;
    if (dueMs >= nowMs) continue;

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

/** Reset dedup sets (for testing). */
export function resetAutomationDedup() {
  dependencyReadySent.clear();
  overdueDailySent.clear();
}
