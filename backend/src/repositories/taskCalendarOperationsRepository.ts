import { booleanValue, type DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, resolveDatabaseRuntimeConfig } from "../db/runtime";
import { getDb } from "../db/schema";
import type { TaskCalendarFeedRecord } from "./taskCalendarFeedsRepository";

export interface TaskCalendarTaskRecord {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  dueAt: string | null;
  updatedAt: string | null;
  isCompleted: number | boolean;
}

export interface TaskCalendarReminderRecord {
  taskId: string;
  offsetMinutes: number;
  enabled: number | boolean;
}

export interface TaskCalendarFeedData {
  tasks: TaskCalendarTaskRecord[];
  remindersByTask: Map<string, TaskCalendarReminderRecord[]>;
}

function buildTaskQuery(
  feed: TaskCalendarFeedRecord,
  dialect: DatabaseDialect,
): { sql: string; params: unknown[] } {
  let sql = `
    SELECT t.id, t.title, t.description, t."dueDate", t."dueAt", t."updatedAt", t."isCompleted"
    FROM tasks t
    WHERE t."userId" = ?
      AND (t."dueAt" IS NOT NULL OR t."dueDate" IS NOT NULL)
  `;
  const params: unknown[] = [feed.userId];

  if (!feed.includeCompleted) {
    sql += ' AND t."isCompleted" = ?';
    params.push(booleanValue(false, dialect));
  }
  if (feed.workspaceId) {
    sql += ' AND t."workspaceId" = ?';
    params.push(feed.workspaceId);
  }
  sql += ' ORDER BY COALESCE(t."dueAt", t."dueDate") ASC';

  return { sql, params };
}

function buildReminderQuery(
  taskIds: string[],
  dialect: DatabaseDialect,
): { sql: string; params: unknown[] } | null {
  if (taskIds.length === 0) return null;
  const placeholders = taskIds.map(() => "?").join(",");
  return {
    sql: `SELECT "taskId", "offsetMinutes", enabled
          FROM task_reminders
          WHERE "taskId" IN (${placeholders}) AND enabled = ?`,
    params: [...taskIds, booleanValue(true, dialect)],
  };
}

function groupReminders(
  reminders: TaskCalendarReminderRecord[],
): Map<string, TaskCalendarReminderRecord[]> {
  const remindersByTask = new Map<string, TaskCalendarReminderRecord[]>();
  for (const reminder of reminders) {
    const current = remindersByTask.get(reminder.taskId) || [];
    current.push(reminder);
    remindersByTask.set(reminder.taskId, current);
  }
  return remindersByTask;
}

export const taskCalendarOperationsRepository = {
  /** Compatibility path for existing synchronous ICS export callers. */
  loadFeedData(feed: TaskCalendarFeedRecord): TaskCalendarFeedData {
    const db = getDb();
    const taskQuery = buildTaskQuery(feed, "sqlite");
    const tasks = db.prepare(taskQuery.sql).all(...taskQuery.params) as TaskCalendarTaskRecord[];
    const reminderQuery = buildReminderQuery(tasks.map((task) => task.id), "sqlite");
    const reminders = reminderQuery
      ? db.prepare(reminderQuery.sql).all(...reminderQuery.params) as TaskCalendarReminderRecord[]
      : [];
    return { tasks, remindersByTask: groupReminders(reminders) };
  },

  /** Runtime Adapter path used by HTTP handlers. */
  async loadFeedDataAsync(feed: TaskCalendarFeedRecord): Promise<TaskCalendarFeedData> {
    const adapter = getDatabaseAdapter();
    const dialect = resolveDatabaseRuntimeConfig(process.env).driver;
    const taskQuery = buildTaskQuery(feed, dialect);
    const tasks = await adapter.queryMany<TaskCalendarTaskRecord>(taskQuery.sql, taskQuery.params);
    const reminderQuery = buildReminderQuery(tasks.map((task) => task.id), dialect);
    const reminders = reminderQuery
      ? await adapter.queryMany<TaskCalendarReminderRecord>(reminderQuery.sql, reminderQuery.params)
      : [];
    return { tasks, remindersByTask: groupReminders(reminders) };
  },
};
