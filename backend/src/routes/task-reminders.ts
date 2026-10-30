import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import crypto from "crypto";
import { getUserWorkspaceRole } from "../middleware/acl";
import { taskRemindersRepository } from "../repositories";

const taskReminders = new Hono();
const MAX_REMINDER_OFFSET_MINUTES = 60 * 24 * 365;
const MIN_TIMEZONE_OFFSET_MINUTES = -14 * 60;
const MAX_TIMEZONE_OFFSET_MINUTES = 14 * 60;

function normalizeTimezoneOffsetMinutes(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < MIN_TIMEZONE_OFFSET_MINUTES || parsed > MAX_TIMEZONE_OFFSET_MINUTES) return null;
  return parsed;
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
  dueAt?: string | null;
  dueDate?: string | null;
  timezoneOffsetMinutes?: number | null;
}): number | null {
  const timezoneOffsetMinutes = normalizeTimezoneOffsetMinutes(row.timezoneOffsetMinutes);
  if (row.dueAt) {
    const dueMs = parseFloatingLocalDateTime(row.dueAt, timezoneOffsetMinutes);
    return Number.isFinite(dueMs) ? dueMs : null;
  }
  if (!row.dueDate) return null;

  // Legacy reminders had no creator timezone and historically used 23:59:59 in
  // the server timezone. Preserve that behavior so upgrades do not move them.
  if (timezoneOffsetMinutes === null) {
    const dueMs = new Date(`${row.dueDate}T23:59:59`).getTime();
    return Number.isFinite(dueMs) ? dueMs : null;
  }

  // New all-day reminders anchor at the next local midnight. This keeps dueDate
  // as an all-day deadline while allowing an integer offset (930 => 08:30).
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.dueDate);
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day) + 1, 0, 0, 0)
    + timezoneOffsetMinutes * 60_000;
}

function resolveReminderAtMs(row: {
  dueAt?: string | null;
  dueDate?: string | null;
  snoozedUntil?: string | null;
  offsetMinutes?: number | null;
  timezoneOffsetMinutes?: number | null;
}): number | null {
  if (row.snoozedUntil) {
    const snoozeMs = new Date(row.snoozedUntil).getTime();
    return Number.isFinite(snoozeMs) ? snoozeMs : null;
  }
  const dueMs = resolveDueAnchorMs(row);
  if (dueMs === null) return null;
  const offsetMinutes = Number(row.offsetMinutes || 0);
  if (!Number.isFinite(offsetMinutes)) return null;
  return dueMs - offsetMinutes * 60_000;
}

function canReadReminderTask(task: { userId: string; workspaceId: string | null }, userId: string): boolean {
  if (task.workspaceId) return getUserWorkspaceRole(task.workspaceId, userId) !== null;
  return task.userId === userId;
}

function resolveScope(
  c: Context,
  userId: string,
): { workspaceId: string | null; error?: string } {
  const raw = c.req.query("workspaceId");
  if (!raw || raw === "personal") {
    return { workspaceId: null };
  }
  const role = getUserWorkspaceRole(raw, userId);
  if (!role) {
    return { workspaceId: raw, error: "无权访问该工作区" };
  }
  return { workspaceId: raw };
}

taskReminders.get("/overview", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const scope = resolveScope(c, userId);
  if (scope.error) return c.json({ error: scope.error }, 403);

  const rawDays = Number(c.req.query("days") || "7");
  const days = Math.min(Math.max(1, isNaN(rawDays) ? 7 : rawDays), 30);

  const now = Date.now();
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const todayEndMs = todayEnd.getTime();
  const horizonMs = todayEndMs + days * 86400000;

  let rows: any[];
  if (scope.workspaceId) {
    rows = db.prepare(`
      SELECT r.id AS reminderId, r.taskId, r.offsetMinutes, r.timezoneOffsetMinutes,
             r.enabled, r.lastNotifiedAt, r.snoozedUntil,
             t.title AS taskTitle, t.status AS taskStatus, t.isCompleted,
             t.dueDate, t.dueAt
      FROM task_reminders r
      JOIN tasks t ON t.id = r.taskId
      WHERE r.userId = ? AND t.workspaceId = ?
      ORDER BY r.createdAt DESC
    `).all(userId, scope.workspaceId) as any[];
  } else {
    rows = db.prepare(`
      SELECT r.id AS reminderId, r.taskId, r.offsetMinutes, r.timezoneOffsetMinutes,
             r.enabled, r.lastNotifiedAt, r.snoozedUntil,
             t.title AS taskTitle, t.status AS taskStatus, t.isCompleted,
             t.dueDate, t.dueAt
      FROM task_reminders r
      JOIN tasks t ON t.id = r.taskId
      WHERE r.userId = ? AND t.workspaceId IS NULL
      ORDER BY r.createdAt DESC
    `).all(userId) as any[];
  }

  const missed: any[] = [];
  const today: any[] = [];
  const upcoming: any[] = [];
  const disabled: any[] = [];

  for (const row of rows) {
    const reminderMs = resolveReminderAtMs(row);
    const reminderAt = reminderMs === null ? null : new Date(reminderMs).toISOString();

    const item: any = {
      reminderId: row.reminderId,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      taskStatus: row.taskStatus,
      isCompleted: row.isCompleted,
      dueDate: row.dueDate,
      dueAt: row.dueAt,
      offsetMinutes: row.offsetMinutes,
      timezoneOffsetMinutes: row.timezoneOffsetMinutes ?? null,
      enabled: row.enabled,
      lastNotifiedAt: row.lastNotifiedAt,
      snoozedUntil: row.snoozedUntil,
      reminderAt,
      group: "",
    };

    if (row.enabled !== 1 || row.isCompleted === 1) {
      item.group = "disabled";
      disabled.push(item);
      continue;
    }

    if (reminderMs === null) {
      item.group = "disabled";
      disabled.push(item);
      continue;
    }

    if (reminderMs < now) {
      item.group = "missed";
      missed.push(item);
      continue;
    }

    if (reminderMs <= todayEndMs) {
      item.group = "today";
      today.push(item);
      continue;
    }

    if (reminderMs <= horizonMs) {
      item.group = "upcoming";
      upcoming.push(item);
      continue;
    }
  }

  return c.json({ missed, today, upcoming, disabled });
});

taskReminders.get("/schedule", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const rows = db.prepare(`
    SELECT r.id AS reminderId, r.taskId, r.offsetMinutes, r.timezoneOffsetMinutes, r.snoozedUntil,
           t.title AS taskTitle, t.dueAt, t.dueDate, t.workspaceId
    FROM task_reminders r
    JOIN tasks t ON t.id = r.taskId
    WHERE r.userId = ?
      AND r.enabled = 1
      AND t.isCompleted = 0
      AND (r.snoozedUntil IS NOT NULL OR t.dueAt IS NOT NULL OR t.dueDate IS NOT NULL)
  `).all(userId) as any[];

  const now = Date.now();
  const reminders = rows.flatMap((row) => {
    if (row.workspaceId && !getUserWorkspaceRole(row.workspaceId, userId)) return [];
    const reminderMs = resolveReminderAtMs(row);
    if (reminderMs === null || reminderMs <= now) return [];
    return [{
      reminderId: row.reminderId,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      reminderAt: new Date(reminderMs).toISOString(),
      dueAt: row.dueAt || null,
      dueDate: row.dueDate || null,
      snoozedUntil: row.snoozedUntil || null,
      offsetMinutes: Number(row.offsetMinutes || 0),
      timezoneOffsetMinutes: row.timezoneOffsetMinutes ?? null,
    }];
  }).sort((a, b) => new Date(a.reminderAt).getTime() - new Date(b.reminderAt).getTime())
    .slice(0, 1000);

  return c.json({ reminders });
});

taskReminders.get("/:taskId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const taskId = c.req.param("taskId");

  const task = db.prepare("SELECT id, userId, workspaceId FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return c.json({ error: "Task not found" }, 404);
  if (!canReadReminderTask(task, userId)) return c.json({ error: "Task not found" }, 404);

  const rows = taskRemindersRepository.listByTaskId(taskId, userId);
  return c.json(rows);
});

taskReminders.post("/:taskId", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const taskId = c.req.param("taskId");
  const body = await c.req.json();

  const task = db.prepare("SELECT id, userId, workspaceId, archivedAt FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return c.json({ error: "Task not found" }, 404);
  if (!canReadReminderTask(task, userId)) {
    return c.json({ error: "无权为该任务创建提醒", code: "FORBIDDEN" }, 403);
  }
  if (task.archivedAt) return c.json({ error: "请先恢复已归档任务", code: "TASK_ARCHIVED" }, 409);

  const offsetMinutes = Number(body.offsetMinutes ?? 30);
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < 0 || offsetMinutes > MAX_REMINDER_OFFSET_MINUTES) {
    return c.json({ error: "Invalid reminder offset", code: "INVALID_REMINDER_OFFSET" }, 400);
  }
  const timezoneOffsetMinutes = normalizeTimezoneOffsetMinutes(body.timezoneOffsetMinutes);
  const id = crypto.randomUUID();

  taskRemindersRepository.create({ id, taskId, userId, offsetMinutes, timezoneOffsetMinutes });
  const reminder = taskRemindersRepository.getById(id);
  return c.json(reminder, 201);
});

taskReminders.put("/:reminderId", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const reminderId = c.req.param("reminderId");

  const existing = taskRemindersRepository.getById(reminderId);
  if (!existing) return c.json({ error: "Reminder not found" }, 404);
  if (existing.userId !== userId) return c.json({ error: "无权修改", code: "FORBIDDEN" }, 403);
  const task = getDb().prepare("SELECT archivedAt FROM tasks WHERE id = ?").get(existing.taskId) as { archivedAt: string | null } | undefined;
  if (task?.archivedAt) return c.json({ error: "请先恢复已归档任务", code: "TASK_ARCHIVED" }, 409);

  const body = await c.req.json();
  const offsetMinutes = Number(body.offsetMinutes ?? existing.offsetMinutes);
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < 0 || offsetMinutes > MAX_REMINDER_OFFSET_MINUTES) {
    return c.json({ error: "Invalid reminder offset", code: "INVALID_REMINDER_OFFSET" }, 400);
  }
  const enabled = body.enabled ?? existing.enabled;
  const hasSnoozedUntil = Object.prototype.hasOwnProperty.call(body, "snoozedUntil");
  const snoozedUntil = hasSnoozedUntil ? body.snoozedUntil : existing.snoozedUntil;

  taskRemindersRepository.update(reminderId, { offsetMinutes, enabled: !!enabled, snoozedUntil });
  const updated = taskRemindersRepository.getById(reminderId);
  return c.json(updated);
});

taskReminders.delete("/:reminderId", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const reminderId = c.req.param("reminderId");

  const existing = taskRemindersRepository.getById(reminderId);
  if (!existing) return c.json({ error: "Reminder not found" }, 404);
  if (existing.userId !== userId) return c.json({ error: "无权删除", code: "FORBIDDEN" }, 403);
  const task = getDb().prepare("SELECT archivedAt FROM tasks WHERE id = ?").get(existing.taskId) as { archivedAt: string | null } | undefined;
  if (task?.archivedAt) return c.json({ error: "请先恢复已归档任务", code: "TASK_ARCHIVED" }, 409);

  taskRemindersRepository.delete(reminderId);
  return c.json({ success: true });
});

taskReminders.post("/test-now", (c) => {
  const result = scanDueReminders();
  return c.json({ count: result.length, reminders: result });
});

export interface PendingReminder {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  dueAt: string | null;
  dueDate: string | null;
  userId: string;
  offsetMinutes: number;
  snoozedUntil: string | null;
}

export function scanDueReminders(): PendingReminder[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.id AS reminderId,
      r.taskId,
      r.userId,
      r.offsetMinutes,
      r.timezoneOffsetMinutes,
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
  `).all() as any[];

  const now = Date.now();
  const pending: PendingReminder[] = [];

  for (const row of rows) {
    const reminderMs = resolveReminderAtMs(row);
    if (reminderMs === null) continue;

    if (row.snoozedUntil) {
      if (reminderMs > now) continue;
      pending.push({
        reminderId: row.reminderId,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        dueAt: row.dueAt,
        dueDate: row.dueDate,
        userId: row.userId,
        offsetMinutes: row.offsetMinutes,
        snoozedUntil: row.snoozedUntil,
      });
      continue;
    }

    if (reminderMs > now) continue;

    if (row.lastNotifiedAt) {
      const lastNotifiedMs = new Date(row.lastNotifiedAt).getTime();
      if (Number.isFinite(lastNotifiedMs) && lastNotifiedMs >= reminderMs) continue;
    }

    pending.push({
      reminderId: row.reminderId,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      dueAt: row.dueAt,
      dueDate: row.dueDate,
      userId: row.userId,
      offsetMinutes: row.offsetMinutes,
      snoozedUntil: null,
    });
  }

  return pending;
}

export function markReminderNotified(reminderId: string) {
  taskRemindersRepository.markNotified(reminderId);
}

export default taskReminders;
