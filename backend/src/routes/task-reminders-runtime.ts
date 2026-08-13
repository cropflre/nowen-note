import { randomUUID } from "node:crypto";
import { Hono } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import { createTaskModuleAccessRuntime } from "../services/task-module-access-runtime";

const MAX_REMINDER_OFFSET_MINUTES = 60 * 24 * 365;
const MIN_TIMEZONE_OFFSET_MINUTES = -14 * 60;
const MAX_TIMEZONE_OFFSET_MINUTES = 14 * 60;

interface ReminderTaskScope {
  id: string;
  userId: string;
  workspaceId: string | null;
}

interface ReminderRow {
  id: string;
  taskId: string;
  userId: string;
  offsetMinutes: number;
  timezoneOffsetMinutes: number | null;
  enabled: boolean | number;
  lastNotifiedAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  snoozedUntil: string | Date | null;
}

interface ReminderScheduleRow extends ReminderRow {
  taskTitle: string;
  taskStatus: string | null;
  isCompleted: boolean | number;
  dueDate: string | null;
  dueAt: string | Date | null;
  workspaceId: string | null;
}

function enabledValue(value: boolean | number): boolean {
  return value === true || value === 1;
}

function normalizeTimezoneOffsetMinutes(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < MIN_TIMEZONE_OFFSET_MINUTES || parsed > MAX_TIMEZONE_OFFSET_MINUTES) return null;
  return parsed;
}

function normalizeOffsetMinutes(value: unknown, fallback: number): number | null {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_REMINDER_OFFSET_MINUTES) return null;
  return parsed;
}

function dateValue(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseFloatingLocalDateTime(value: string, timezoneOffsetMinutes: number | null): number {
  if (timezoneOffsetMinutes === null) return new Date(value).getTime();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second = "0"] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) + timezoneOffsetMinutes * 60_000;
}

function resolveDueAnchorMs(row: {
  dueAt: string | Date | null;
  dueDate: string | null;
  timezoneOffsetMinutes: number | null;
}): number | null {
  const timezoneOffsetMinutes = normalizeTimezoneOffsetMinutes(row.timezoneOffsetMinutes);
  if (row.dueAt instanceof Date) {
    const value = row.dueAt.getTime();
    return Number.isFinite(value) ? value : null;
  }
  if (row.dueAt) {
    const dueAt = String(row.dueAt);
    const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dueAt);
    const dueMs = hasExplicitZone
      ? new Date(dueAt).getTime()
      : parseFloatingLocalDateTime(dueAt, timezoneOffsetMinutes);
    return Number.isFinite(dueMs) ? dueMs : null;
  }
  if (!row.dueDate) return null;
  if (timezoneOffsetMinutes === null) {
    const dueMs = new Date(`${row.dueDate}T23:59:59`).getTime();
    return Number.isFinite(dueMs) ? dueMs : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.dueDate);
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day) + 1, 0, 0, 0)
    + timezoneOffsetMinutes * 60_000;
}

function resolveReminderAtMs(row: {
  dueAt: string | Date | null;
  dueDate: string | null;
  snoozedUntil: string | Date | null;
  offsetMinutes: number;
  timezoneOffsetMinutes: number | null;
}): number | null {
  if (row.snoozedUntil) {
    const snoozeMs = new Date(row.snoozedUntil).getTime();
    return Number.isFinite(snoozeMs) ? snoozeMs : null;
  }
  const dueMs = resolveDueAnchorMs(row);
  if (dueMs === null) return null;
  return dueMs - Number(row.offsetMinutes || 0) * 60_000;
}

function serializeReminder(row: ReminderRow) {
  return {
    ...row,
    enabled: enabledValue(row.enabled) ? 1 : 0,
    lastNotifiedAt: dateValue(row.lastNotifiedAt),
    createdAt: dateValue(row.createdAt as any),
    updatedAt: dateValue(row.updatedAt as any),
    snoozedUntil: dateValue(row.snoozedUntil),
  };
}

export function createTaskRemindersRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();
  const access = createTaskModuleAccessRuntime(adapter);

  async function taskScope(taskId: string): Promise<ReminderTaskScope | undefined> {
    return adapter.queryOne<ReminderTaskScope>(
      `SELECT id, "userId" AS "userId", "workspaceId" AS "workspaceId" FROM tasks WHERE id = ?`,
      [taskId],
    );
  }

  app.get("/overview", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const scopeResult = await access.resolveScope(c.req.query("workspaceId"), userId);
    if (!scopeResult.ok) return c.json({ error: scopeResult.error, code: scopeResult.code }, scopeResult.status);
    const rawDays = Number(c.req.query("days") || "7");
    const days = Math.min(Math.max(1, Number.isFinite(rawDays) ? rawDays : 7), 30);
    const workspaceId = scopeResult.scope.workspaceId;
    const rows = workspaceId
      ? await adapter.queryMany<ReminderScheduleRow>(
          `SELECT r.*, t.title AS "taskTitle", t.status AS "taskStatus", t."isCompleted",
                  t."dueDate", t."dueAt", t."workspaceId"
             FROM task_reminders r
             JOIN tasks t ON t.id = r."taskId"
            WHERE r."userId" = ? AND t."workspaceId" = ?
            ORDER BY r."createdAt" DESC`,
          [userId, workspaceId],
        )
      : await adapter.queryMany<ReminderScheduleRow>(
          `SELECT r.*, t.title AS "taskTitle", t.status AS "taskStatus", t."isCompleted",
                  t."dueDate", t."dueAt", t."workspaceId"
             FROM task_reminders r
             JOIN tasks t ON t.id = r."taskId"
            WHERE r."userId" = ? AND t."workspaceId" IS NULL
            ORDER BY r."createdAt" DESC`,
          [userId],
        );

    const now = Date.now();
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const todayEndMs = todayEnd.getTime();
    const horizonMs = todayEndMs + days * 86_400_000;
    const result: Record<"missed" | "today" | "upcoming" | "disabled", any[]> = {
      missed: [],
      today: [],
      upcoming: [],
      disabled: [],
    };
    for (const row of rows) {
      const reminderAtMs = resolveReminderAtMs(row);
      const item = {
        reminderId: row.id,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        taskStatus: row.taskStatus,
        isCompleted: enabledValue(row.isCompleted) ? 1 : 0,
        dueDate: row.dueDate,
        dueAt: dateValue(row.dueAt),
        offsetMinutes: row.offsetMinutes,
        timezoneOffsetMinutes: row.timezoneOffsetMinutes,
        enabled: enabledValue(row.enabled) ? 1 : 0,
        lastNotifiedAt: dateValue(row.lastNotifiedAt),
        snoozedUntil: dateValue(row.snoozedUntil),
        reminderAt: reminderAtMs === null ? null : new Date(reminderAtMs).toISOString(),
        group: "",
      };
      if (!enabledValue(row.enabled) || enabledValue(row.isCompleted) || reminderAtMs === null) {
        item.group = "disabled";
        result.disabled.push(item);
      } else if (reminderAtMs < now) {
        item.group = "missed";
        result.missed.push(item);
      } else if (reminderAtMs <= todayEndMs) {
        item.group = "today";
        result.today.push(item);
      } else if (reminderAtMs <= horizonMs) {
        item.group = "upcoming";
        result.upcoming.push(item);
      }
    }
    return c.json(result);
  });

  app.get("/schedule", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const rows = await adapter.queryMany<ReminderScheduleRow>(
      `SELECT r.*, t.title AS "taskTitle", t.status AS "taskStatus", t."isCompleted",
              t."dueDate", t."dueAt", t."workspaceId"
         FROM task_reminders r
         JOIN tasks t ON t.id = r."taskId"
        WHERE r."userId" = ?
        ORDER BY r."createdAt" DESC`,
      [userId],
    );
    const now = Date.now();
    const reminders: any[] = [];
    for (const row of rows) {
      if (!enabledValue(row.enabled) || enabledValue(row.isCompleted)) continue;
      if (row.workspaceId && !(await access.canRead({ userId, workspaceId: row.workspaceId }, userId))) continue;
      const reminderAtMs = resolveReminderAtMs(row);
      if (reminderAtMs === null || reminderAtMs <= now) continue;
      reminders.push({
        reminderId: row.id,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        reminderAt: new Date(reminderAtMs).toISOString(),
        dueAt: dateValue(row.dueAt),
        dueDate: row.dueDate,
        snoozedUntil: dateValue(row.snoozedUntil),
        offsetMinutes: Number(row.offsetMinutes || 0),
        timezoneOffsetMinutes: row.timezoneOffsetMinutes,
      });
    }
    reminders.sort((a, b) => Date.parse(a.reminderAt) - Date.parse(b.reminderAt));
    return c.json({ reminders: reminders.slice(0, 1000) });
  });

  app.get("/:taskId", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const task = await taskScope(c.req.param("taskId"));
    if (!task || !(await access.canRead(task, userId))) return c.json({ error: "Task not found" }, 404);
    const rows = await adapter.queryMany<ReminderRow>(
      `SELECT * FROM task_reminders
        WHERE "taskId" = ? AND "userId" = ?
        ORDER BY "offsetMinutes" ASC`,
      [task.id, userId],
    );
    return c.json(rows.map(serializeReminder));
  });

  app.post("/:taskId", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const task = await taskScope(c.req.param("taskId"));
    if (!task || !(await access.canRead(task, userId))) return c.json({ error: "Task not found" }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const offsetMinutes = normalizeOffsetMinutes(body.offsetMinutes, 30);
    if (offsetMinutes === null) {
      return c.json({ error: `offsetMinutes must be an integer between 0 and ${MAX_REMINDER_OFFSET_MINUTES}`, code: "INVALID_REMINDER_OFFSET" }, 400);
    }
    const timezoneOffsetMinutes = body.timezoneOffsetMinutes === undefined
      ? null
      : normalizeTimezoneOffsetMinutes(body.timezoneOffsetMinutes);
    if (body.timezoneOffsetMinutes !== undefined && timezoneOffsetMinutes === null) {
      return c.json({ error: "timezoneOffsetMinutes must be an integer between -840 and 840", code: "INVALID_TIMEZONE_OFFSET" }, 400);
    }
    const id = randomUUID();
    await adapter.execute(
      `INSERT INTO task_reminders (
         id, "taskId", "userId", "offsetMinutes", "timezoneOffsetMinutes", enabled, "updatedAt"
       ) VALUES (?, ?, ?, ?, ?, true, CURRENT_TIMESTAMP)`,
      [id, task.id, userId, offsetMinutes, timezoneOffsetMinutes],
    );
    const created = await adapter.queryOne<ReminderRow>(`SELECT * FROM task_reminders WHERE id = ?`, [id]);
    return c.json(created ? serializeReminder(created) : null, 201);
  });

  app.put("/:reminderId", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const id = c.req.param("reminderId");
    const existing = await adapter.queryOne<ReminderRow>(`SELECT * FROM task_reminders WHERE id = ?`, [id]);
    if (!existing) return c.json({ error: "Reminder not found" }, 404);
    if (existing.userId !== userId) return c.json({ error: "无权修改", code: "FORBIDDEN" }, 403);
    const task = await taskScope(existing.taskId);
    if (!task || !(await access.canRead(task, userId))) return c.json({ error: "Task not found" }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const offsetMinutes = normalizeOffsetMinutes(body.offsetMinutes, existing.offsetMinutes);
    if (offsetMinutes === null) {
      return c.json({ error: `offsetMinutes must be an integer between 0 and ${MAX_REMINDER_OFFSET_MINUTES}`, code: "INVALID_REMINDER_OFFSET" }, 400);
    }
    let timezoneOffsetMinutes = existing.timezoneOffsetMinutes;
    if (body.timezoneOffsetMinutes !== undefined) {
      timezoneOffsetMinutes = body.timezoneOffsetMinutes === null ? null : normalizeTimezoneOffsetMinutes(body.timezoneOffsetMinutes);
      if (body.timezoneOffsetMinutes !== null && timezoneOffsetMinutes === null) {
        return c.json({ error: "timezoneOffsetMinutes must be an integer between -840 and 840", code: "INVALID_TIMEZONE_OFFSET" }, 400);
      }
    }
    const enabled = body.enabled === undefined ? enabledValue(existing.enabled) : Boolean(body.enabled);
    let snoozedUntil = dateValue(existing.snoozedUntil);
    if (Object.prototype.hasOwnProperty.call(body, "snoozedUntil")) {
      if (body.snoozedUntil === null || body.snoozedUntil === "") {
        snoozedUntil = null;
      } else {
        const parsed = new Date(String(body.snoozedUntil));
        if (!Number.isFinite(parsed.getTime())) return c.json({ error: "Invalid snoozedUntil", code: "BAD_REQUEST" }, 400);
        snoozedUntil = parsed.toISOString();
      }
    }
    await adapter.execute(
      `UPDATE task_reminders
          SET "offsetMinutes" = ?, "timezoneOffsetMinutes" = ?, enabled = ?, "snoozedUntil" = ?, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [offsetMinutes, timezoneOffsetMinutes, enabled, snoozedUntil, id],
    );
    const updated = await adapter.queryOne<ReminderRow>(`SELECT * FROM task_reminders WHERE id = ?`, [id]);
    return c.json(updated ? serializeReminder(updated) : null);
  });

  app.delete("/:reminderId", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const id = c.req.param("reminderId");
    const existing = await adapter.queryOne<ReminderRow>(`SELECT * FROM task_reminders WHERE id = ?`, [id]);
    if (!existing) return c.json({ error: "Reminder not found" }, 404);
    if (existing.userId !== userId) return c.json({ error: "无权删除", code: "FORBIDDEN" }, 403);
    await adapter.execute(`DELETE FROM task_reminders WHERE id = ?`, [id]);
    return c.json({ success: true });
  });

  return app;
}

export default createTaskRemindersRuntimeRouter;
