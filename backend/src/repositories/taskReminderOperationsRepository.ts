import { booleanValue, nowExpression } from "../db/dialect";
import { getDatabaseAdapter, resolveDatabaseRuntimeConfig } from "../db/runtime";
import { getDb } from "../db/schema";
import type { TaskReminderRecord } from "./taskRemindersRepository";

export interface TaskReminderTaskScope {
  id: string;
  userId: string;
  workspaceId: string | null;
}

export interface TaskReminderOverviewRow {
  reminderId: string;
  taskId: string;
  offsetMinutes: number;
  enabled: number | boolean;
  lastNotifiedAt: string | null;
  snoozedUntil: string | null;
  taskTitle: string;
  taskStatus: string | null;
  isCompleted: number | boolean;
  dueDate: string | null;
  dueAt: string | null;
}

export interface TaskReminderDueCandidate {
  reminderId: string;
  taskId: string;
  userId: string;
  offsetMinutes: number;
  lastNotifiedAt: string | null;
  snoozedUntil: string | null;
  taskTitle: string;
  dueAt: string | null;
  dueDate: string | null;
  isCompleted: number;
}

function toIntegerBoolean(value: number | boolean): number {
  return value === true || value === 1 ? 1 : 0;
}

function normalizeReminder(
  row: Omit<TaskReminderRecord, "enabled"> & { enabled: number | boolean },
): TaskReminderRecord {
  return { ...row, enabled: toIntegerBoolean(row.enabled) };
}

export const taskReminderOperationsRepository = {
  async getTaskScopeAsync(taskId: string): Promise<TaskReminderTaskScope | undefined> {
    return getDatabaseAdapter().queryOne<TaskReminderTaskScope>(
      'SELECT id, "userId", "workspaceId" FROM tasks WHERE id = ?',
      [taskId],
    );
  },

  async listByTaskIdAsync(taskId: string, userId: string): Promise<TaskReminderRecord[]> {
    const rows = await getDatabaseAdapter().queryMany<
      Omit<TaskReminderRecord, "enabled"> & { enabled: number | boolean }
    >(
      'SELECT * FROM task_reminders WHERE "taskId" = ? AND "userId" = ? ORDER BY "offsetMinutes" ASC',
      [taskId, userId],
    );
    return rows.map(normalizeReminder);
  },

  async getByIdAsync(reminderId: string): Promise<TaskReminderRecord | undefined> {
    const row = await getDatabaseAdapter().queryOne<
      Omit<TaskReminderRecord, "enabled"> & { enabled: number | boolean }
    >('SELECT * FROM task_reminders WHERE id = ?', [reminderId]);
    return row ? normalizeReminder(row) : undefined;
  },

  async createAsync(input: {
    id: string;
    taskId: string;
    userId: string;
    offsetMinutes: number;
  }): Promise<void> {
    const dialect = resolveDatabaseRuntimeConfig(process.env).driver;
    await getDatabaseAdapter().execute(
      'INSERT INTO task_reminders (id, "taskId", "userId", "offsetMinutes", enabled) VALUES (?, ?, ?, ?, ?)',
      [input.id, input.taskId, input.userId, input.offsetMinutes, booleanValue(true, dialect)],
    );
  },

  async updateAsync(reminderId: string, input: {
    offsetMinutes: number;
    enabled: boolean;
    snoozedUntil: string | null;
  }): Promise<void> {
    const dialect = resolveDatabaseRuntimeConfig(process.env).driver;
    await getDatabaseAdapter().execute(
      `UPDATE task_reminders
       SET "offsetMinutes" = ?, enabled = ?, "snoozedUntil" = ?, "updatedAt" = ${nowExpression(dialect)}
       WHERE id = ?`,
      [input.offsetMinutes, booleanValue(input.enabled, dialect), input.snoozedUntil, reminderId],
    );
  },

  async deleteAsync(reminderId: string): Promise<void> {
    await getDatabaseAdapter().execute("DELETE FROM task_reminders WHERE id = ?", [reminderId]);
  },

  async listOverviewAsync(
    userId: string,
    workspaceId: string | null,
  ): Promise<TaskReminderOverviewRow[]> {
    const adapter = getDatabaseAdapter();
    if (workspaceId) {
      return adapter.queryMany<TaskReminderOverviewRow>(
        `SELECT r.id AS "reminderId", r."taskId", r."offsetMinutes", r.enabled,
                r."lastNotifiedAt", r."snoozedUntil", t.title AS "taskTitle",
                t.status AS "taskStatus", t."isCompleted", t."dueDate", t."dueAt"
         FROM task_reminders r
         JOIN tasks t ON t.id = r."taskId"
         WHERE r."userId" = ? AND t."workspaceId" = ?
         ORDER BY r."createdAt" DESC`,
        [userId, workspaceId],
      );
    }

    return adapter.queryMany<TaskReminderOverviewRow>(
      `SELECT r.id AS "reminderId", r."taskId", r."offsetMinutes", r.enabled,
              r."lastNotifiedAt", r."snoozedUntil", t.title AS "taskTitle",
              t.status AS "taskStatus", t."isCompleted", t."dueDate", t."dueAt"
       FROM task_reminders r
       JOIN tasks t ON t.id = r."taskId"
       WHERE r."userId" = ? AND t."workspaceId" IS NULL
       ORDER BY r."createdAt" DESC`,
      [userId],
    );
  },

  /** SQLite compatibility path used by the existing synchronous notification scanner. */
  listDueCandidates(): TaskReminderDueCandidate[] {
    return getDb().prepare(`
      SELECT
        r.id AS reminderId,
        r.taskId,
        r.userId,
        r.offsetMinutes,
        r.lastNotifiedAt,
        r.snoozedUntil,
        t.title AS taskTitle,
        t.dueAt,
        t.dueDate,
        t.isCompleted
      FROM task_reminders r
      JOIN tasks t ON t.id = r.taskId
      WHERE r.enabled = 1
        AND t.isCompleted = 0
        AND (t.dueAt IS NOT NULL OR t.dueDate IS NOT NULL)
    `).all() as TaskReminderDueCandidate[];
  },
};
