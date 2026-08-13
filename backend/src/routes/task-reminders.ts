import { Hono } from "hono";
import type { Context } from "hono";
import crypto from "crypto";
import { getUserWorkspaceRole } from "../middleware/acl";
import {
  taskReminderOperationsRepository,
  taskRemindersRepository,
} from "../repositories";
import type {
  TaskReminderDueCandidate,
  TaskReminderOverviewRow,
  TaskReminderScheduleRow,
} from "../repositories/taskReminderOperationsRepository";

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

function toIntegerBoolean(value: number | boolean): number {
  return value === true || value === 1 ? 1 : 0;
}

function resolveReminderAt(row: TaskReminderOverviewRow): string | null {
  if (row.snoozedUntil) return row.snoozedUntil;

  if (row.dueAt) {
    const dueMs = new Date(row.dueAt).getTime();
    return new Date(dueMs - row.offsetMinutes * 60_000).toISOString();
  }

  if (row.dueDate) {
    const dueMs = new Date(`${row.dueDate}T23:59:59`).getTime();
    return new Date(dueMs - row.offsetMinutes * 60_000).toISOString();
  }

  return null;
}

// GET /overview -- reminder overview grouped by missed/today/upcoming/disabled
taskReminders.get("/overview", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const scope = resolveScope(c, userId);
  if (scope.error) return c.json({ error: scope.error }, 403);

  const rawDays = Number(c.req.query("days") || "7");
  const days = Math.min(Math.max(1, Number.isNaN(rawDays) ? 7 : rawDays), 30);
  const rows = await taskReminderOperationsRepository.listOverviewAsync(
    userId,
    scope.workspaceId,
  );

  const now = Date.now();
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const todayEndMs = todayEnd.getTime();
  const horizonMs = todayEndMs + days * 86_400_000;

  const missed: any[] = [];
  const today: any[] = [];
  const upcoming: any[] = [];
  const disabled: any[] = [];

  for (const row of rows) {
    const enabled = toIntegerBoolean(row.enabled);
    const isCompleted = toIntegerBoolean(row.isCompleted);
    const reminderAt = resolveReminderAt(row);
    const item: any = {
      reminderId: row.reminderId,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      taskStatus: row.taskStatus,
      isCompleted,
      dueDate: row.dueDate,
      dueAt: row.dueAt,
      offsetMinutes: row.offsetMinutes,
      enabled,
      lastNotifiedAt: row.lastNotifiedAt,
      snoozedUntil: row.snoozedUntil,
      reminderAt,
      group: "",
    };

    if (enabled !== 1 || isCompleted === 1 || !reminderAt) {
      item.group = "disabled";
      disabled.push(item);
      continue;
    }

    const reminderMs = new Date(reminderAt).getTime();
    if (reminderMs < now) {
      item.group = "missed";
      missed.push(item);
    } else if (reminderMs <= todayEndMs) {
      item.group = "today";
      today.push(item);
    } else if (reminderMs <= horizonMs) {
      item.group = "upcoming";
      upcoming.push(item);
    }
  }

  return c.json({ missed, today, upcoming, disabled });
});

// 立即提醒（测试用）— 返回应该提醒的任务列表
taskReminders.post("/test-now", (c) => {
  const result = scanDueReminders();
  return c.json({ count: result.length, reminders: result });
});

// GET /schedule -- all future reminders for native client scheduling.
taskReminders.get("/schedule", async (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const rows = await taskReminderOperationsRepository.listScheduleAsync(userId);
  const now = Date.now();
  const reminders = rows.flatMap((row: TaskReminderScheduleRow) => {
    if (toIntegerBoolean(row.enabled) !== 1 || toIntegerBoolean(row.isCompleted) === 1) return [];
    if (row.workspaceId && !getUserWorkspaceRole(row.workspaceId, userId)) return [];
    const reminderAt = resolveReminderAt(row);
    if (!reminderAt) return [];
    const reminderMs = new Date(reminderAt).getTime();
    if (!Number.isFinite(reminderMs) || reminderMs <= now) return [];
    return [{
      reminderId: row.reminderId,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      reminderAt,
      dueAt: row.dueAt,
      dueDate: row.dueDate,
      snoozedUntil: row.snoozedUntil,
      offsetMinutes: Number(row.offsetMinutes || 0),
    }];
  }).sort((a, b) => new Date(a.reminderAt).getTime() - new Date(b.reminderAt).getTime())
    .slice(0, 1000);
  return c.json({ reminders });
});

// 获取某任务的所有提醒配置
taskReminders.get("/:taskId", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const taskId = c.req.param("taskId");

  const task = await taskReminderOperationsRepository.getTaskScopeAsync(taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  const rows = await taskReminderOperationsRepository.listByTaskIdAsync(taskId, userId);
  return c.json(rows);
});

// 创建提醒
taskReminders.post("/:taskId", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const taskId = c.req.param("taskId");
  const body = await c.req.json();

  const task = await taskReminderOperationsRepository.getTaskScopeAsync(taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  const offsetMinutes = body.offsetMinutes ?? 30;
  const id = crypto.randomUUID();

  await taskReminderOperationsRepository.createAsync({
    id,
    taskId,
    userId,
    offsetMinutes,
  });
  const reminder = await taskReminderOperationsRepository.getByIdAsync(id);
  return c.json(reminder, 201);
});

// 更新提醒（启用/禁用、修改 offset）
taskReminders.put("/:reminderId", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const reminderId = c.req.param("reminderId");

  const existing = await taskReminderOperationsRepository.getByIdAsync(reminderId);
  if (!existing) return c.json({ error: "Reminder not found" }, 404);
  if (existing.userId !== userId) {
    return c.json({ error: "无权修改", code: "FORBIDDEN" }, 403);
  }

  const body = await c.req.json();
  const offsetMinutes = body.offsetMinutes ?? existing.offsetMinutes;
  const enabled = body.enabled ?? existing.enabled;
  const hasSnoozedUntil = Object.prototype.hasOwnProperty.call(body, "snoozedUntil");
  const snoozedUntil = hasSnoozedUntil ? body.snoozedUntil : existing.snoozedUntil;

  await taskReminderOperationsRepository.updateAsync(reminderId, {
    offsetMinutes,
    enabled: !!enabled,
    snoozedUntil,
  });
  const updated = await taskReminderOperationsRepository.getByIdAsync(reminderId);
  return c.json(updated);
});

// 删除提醒
taskReminders.delete("/:reminderId", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const reminderId = c.req.param("reminderId");

  const existing = await taskReminderOperationsRepository.getByIdAsync(reminderId);
  if (!existing) return c.json({ error: "Reminder not found" }, 404);
  if (existing.userId !== userId) {
    return c.json({ error: "无权删除", code: "FORBIDDEN" }, 403);
  }

  await taskReminderOperationsRepository.deleteAsync(reminderId);
  return c.json({ success: true });
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

function collectPendingReminders(
  rows: TaskReminderDueCandidate[],
  now = Date.now(),
): PendingReminder[] {
  const pending: PendingReminder[] = [];

  for (const row of rows) {
    const dueStr = row.dueAt || (row.dueDate ? `${row.dueDate}T23:59:59` : null);
    if (!dueStr) continue;

    const dueMs = new Date(dueStr).getTime();
    const reminderMs = dueMs - row.offsetMinutes * 60_000;

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

/** SQLite compatibility path used by the existing synchronous notification loop. */
export function scanDueReminders(): PendingReminder[] {
  return collectPendingReminders(taskReminderOperationsRepository.listDueCandidates());
}

export function markReminderNotified(reminderId: string): void {
  taskRemindersRepository.markNotified(reminderId);
}

export default taskReminders;
