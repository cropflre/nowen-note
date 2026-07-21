import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import crypto from "crypto";
import {
  getUserWorkspaceRole,
  canManageResource,
} from "../middleware/acl";
import { taskRemindersRepository } from "../repositories";
import { getClientMutationAt, getIdempotentMutation, getNewerFields, getTombstone, hasNewerFieldClock, saveIdempotentMutation, writeFieldClocks, writeTombstone } from "../lib/offlineResourceSync";

const taskReminders = new Hono();

// 解析任务 scope（与 tasks.ts 一致）
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

function canAccessReminderTombstone(
  tombstone: { userId: string; workspaceId: string | null } | undefined,
  userId: string,
): boolean {
  if (!tombstone) return false;
  if (!tombstone.workspaceId) return tombstone.userId === userId;
  const role = getUserWorkspaceRole(tombstone.workspaceId, userId);
  return role === "editor" || role === "admin" || role === "owner";
}

function canReadTask(
  task: { userId: string; workspaceId: string | null },
  userId: string,
): boolean {
  if (!task.workspaceId) return task.userId === userId;
  return getUserWorkspaceRole(task.workspaceId, userId) !== null;
}

// 获取某任务的所有提醒配置
// ---------------------------------------------------------------------------
// GET /overview  -- reminder overview grouped by missed/today/upcoming/disabled
// ---------------------------------------------------------------------------
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
      SELECT r.id AS reminderId, r.taskId, r.offsetMinutes, r.enabled, r.lastNotifiedAt, r.snoozedUntil,
             t.title AS taskTitle, t.status AS taskStatus, t.isCompleted,
             t.dueDate, t.dueAt
      FROM task_reminders r
      JOIN tasks t ON t.id = r.taskId
      WHERE r.userId = ? AND t.workspaceId = ?
      ORDER BY r.createdAt DESC
    `).all(userId, scope.workspaceId) as any[];
  } else {
    rows = db.prepare(`
      SELECT r.id AS reminderId, r.taskId, r.offsetMinutes, r.enabled, r.lastNotifiedAt, r.snoozedUntil,
             t.title AS taskTitle, t.status AS taskStatus, t.isCompleted,
             t.dueDate, t.dueAt
      FROM task_reminders r
      JOIN tasks t ON t.id = r.taskId
      WHERE r.userId = ? AND t.userId = ? AND t.workspaceId IS NULL
      ORDER BY r.createdAt DESC
    `).all(userId, userId) as any[];
  }

  const missed: any[] = [];
  const today: any[] = [];
  const upcoming: any[] = [];
  const disabled: any[] = [];

  for (const row of rows) {
    let reminderAt: string | null = null;
    if (row.snoozedUntil) {
      reminderAt = row.snoozedUntil;
    } else if (row.dueAt) {
      const dueMs = new Date(row.dueAt).getTime();
      const rMs = dueMs - row.offsetMinutes * 60000;
      reminderAt = new Date(rMs).toISOString();
    } else if (row.dueDate) {
      const dueMs = new Date(row.dueDate + "T23:59:59").getTime();
      const rMs = dueMs - row.offsetMinutes * 60000;
      reminderAt = new Date(rMs).toISOString();
    }

    const item: any = {
      reminderId: row.reminderId,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      taskStatus: row.taskStatus,
      isCompleted: row.isCompleted,
      dueDate: row.dueDate,
      dueAt: row.dueAt,
      offsetMinutes: row.offsetMinutes,
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

    if (!reminderAt) {
      item.group = "disabled";
      disabled.push(item);
      continue;
    }

    const reminderMs = new Date(reminderAt).getTime();

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

taskReminders.get("/snapshot", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const scope = resolveScope(c, userId);
  if (scope.error) return c.json({ error: scope.error }, 403);

  const reminders = scope.workspaceId
    ? db.prepare(`
        SELECT r.*
        FROM task_reminders r
        INNER JOIN tasks t ON t.id = r.taskId
        WHERE r.userId = ? AND t.workspaceId = ?
        ORDER BY r.createdAt DESC
      `).all(userId, scope.workspaceId)
    : db.prepare(`
        SELECT r.*
        FROM task_reminders r
        INNER JOIN tasks t ON t.id = r.taskId
        WHERE r.userId = ? AND t.userId = ? AND t.workspaceId IS NULL
        ORDER BY r.createdAt DESC
      `).all(userId, userId);
  const deletedIds = scope.workspaceId
    ? db.prepare(`
        SELECT resourceId
        FROM offline_resource_tombstones
        WHERE resourceType = 'taskReminder' AND userId = ? AND workspaceId = ?
      `).all(userId, scope.workspaceId).map((row: any) => row.resourceId)
    : db.prepare(`
        SELECT resourceId
        FROM offline_resource_tombstones
        WHERE resourceType = 'taskReminder' AND userId = ? AND workspaceId IS NULL
      `).all(userId).map((row: any) => row.resourceId);

  return c.json({ reminders, deletedIds });
});

taskReminders.get("/:taskId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const taskId = c.req.param("taskId");

  const task = db.prepare("SELECT id, userId, workspaceId FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return c.json({ error: "Task not found" }, 404);
  if (!canReadTask(task, userId)) return c.json({ error: "Task not found" }, 404);

  const rows = taskRemindersRepository.listByTaskId(taskId, userId);
  return c.json(rows);
});

// 创建提醒
taskReminders.post("/:taskId", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const taskId = c.req.param("taskId");
  const operationId = c.req.header("Idempotency-Key");
  const replay = getIdempotentMutation(db, userId, operationId);
  if (replay) return c.json(replay, 200);
  const clientUpdatedAt = getClientMutationAt(c.req.header("X-Client-Mutation-At"));
  const body = await c.req.json();
  const requestedId = typeof body.id === "string" ? body.id : "";
  if (requestedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId)) {
    return c.json({ error: "Invalid reminder id", code: "INVALID_REMINDER_ID" }, 400);
  }

  const task = db.prepare("SELECT id, userId, workspaceId FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) {
    const tombstone = getTombstone(db, "task", taskId);
    const canManageTombstone = canAccessReminderTombstone(tombstone, userId);
    if (canManageTombstone) return c.json({ success: true, syncIgnored: true }, 200);
    return c.json({ error: "Task not found" }, 404);
  }
  if (!canManageResource(task.userId, task.workspaceId, userId)) {
    return c.json({ error: "无权创建提醒", code: "FORBIDDEN" }, 403);
  }

  const offsetMinutes = body.offsetMinutes ?? 30;
  const id = requestedId || crypto.randomUUID();
  const ownTombstone = getTombstone(db, "taskReminder", id);
  if (ownTombstone && canAccessReminderTombstone(ownTombstone, userId) && clientUpdatedAt <= ownTombstone.deletedAt) {
    const response = { success: true, syncIgnored: true };
    saveIdempotentMutation(db, userId, operationId, response);
    return c.json(response);
  }
  const existing = taskRemindersRepository.getById(id);
  if (existing) {
    if (existing.userId !== userId || existing.taskId !== taskId) {
      return c.json({ error: "Reminder id already exists", code: "REMINDER_ID_CONFLICT" }, 409);
    }
    saveIdempotentMutation(db, userId, operationId, existing);
    return c.json(existing, 200);
  }

  const reminder = db.transaction(() => {
    taskRemindersRepository.create({ id, taskId, userId, offsetMinutes });
    const created = taskRemindersRepository.getById(id);
    saveIdempotentMutation(db, userId, operationId, created);
    return created;
  })();
  return c.json(reminder, 201);
});

// 更新提醒（启用/禁用、修改 offset）
taskReminders.put("/:reminderId", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const reminderId = c.req.param("reminderId");
  const operationId = c.req.header("Idempotency-Key");
  const replay = getIdempotentMutation(db, userId, operationId);
  if (replay) return c.json(replay, 200);
  const clientUpdatedAt = getClientMutationAt(c.req.header("X-Client-Mutation-At"));

  const existing = taskRemindersRepository.getById(reminderId);
  if (!existing) return c.json({ error: "Reminder not found" }, 404);
  if (existing.userId !== userId) return c.json({ error: "无权修改", code: "FORBIDDEN" }, 403);

  const body = await c.req.json();
  const requestedFields = ["offsetMinutes", "enabled", "snoozedUntil"].filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  const accepted = getNewerFields(db, "taskReminder", reminderId, requestedFields, clientUpdatedAt, operationId);
  const offsetMinutes = accepted.has("offsetMinutes") ? body.offsetMinutes : existing.offsetMinutes;
  const enabled = accepted.has("enabled") ? (body.enabled ? 1 : 0) : existing.enabled;
  const hasSnoozedUntil = Object.prototype.hasOwnProperty.call(body, "snoozedUntil");
  const snoozedUntil = hasSnoozedUntil && accepted.has("snoozedUntil") ? body.snoozedUntil : existing.snoozedUntil;

  const updated = db.transaction(() => {
    if (accepted.size > 0) {
      taskRemindersRepository.update(reminderId, { offsetMinutes, enabled: !!enabled, snoozedUntil });
      writeFieldClocks(db, "taskReminder", reminderId, accepted, clientUpdatedAt, operationId);
    }
    const current = taskRemindersRepository.getById(reminderId);
    saveIdempotentMutation(db, userId, operationId, current);
    return current;
  })();
  return c.json(updated);
});

// 删除提醒
taskReminders.delete("/:reminderId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const reminderId = c.req.param("reminderId");
  const operationId = c.req.header("Idempotency-Key");
  const replay = getIdempotentMutation(db, userId, operationId);
  if (replay) return c.json(replay, 200);
  const clientUpdatedAt = getClientMutationAt(c.req.header("X-Client-Mutation-At"));

  const existing = taskRemindersRepository.getById(reminderId);
  if (!existing) {
    const tombstone = getTombstone(db, "taskReminder", reminderId);
    const canManageTombstone = canAccessReminderTombstone(tombstone, userId);
    if (canManageTombstone) {
      const response = { success: true, syncIgnored: true };
      saveIdempotentMutation(db, userId, operationId, response);
      return c.json(response);
    }
    return c.json({ error: "Reminder not found" }, 404);
  }
  if (existing.userId !== userId) return c.json({ error: "无权删除", code: "FORBIDDEN" }, 403);
  if (hasNewerFieldClock(db, "taskReminder", reminderId, clientUpdatedAt)) {
    const response = { success: true, syncIgnored: true };
    saveIdempotentMutation(db, userId, operationId, response);
    return c.json(response);
  }

  const task = db.prepare("SELECT workspaceId FROM tasks WHERE id = ?").get(existing.taskId) as { workspaceId: string | null } | undefined;
  const response = { success: true };
  db.transaction(() => {
    taskRemindersRepository.delete(reminderId);
    writeTombstone(db, "taskReminder", reminderId, existing.userId, task?.workspaceId ?? null, clientUpdatedAt);
    saveIdempotentMutation(db, userId, operationId, response);
  })();
  return c.json(response);
});

// 立即提醒（测试用）— 返回应该提醒的任务列表
taskReminders.post("/test-now", (c) => {
  const result = scanDueReminders();
  return c.json({ count: result.length, reminders: result });
});

// ---------------------------------------------------------------------------
// 提醒扫描器：后端定时运行，查找所有到期的提醒
// ---------------------------------------------------------------------------
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

/**
 * 扫描所有到期的提醒。
 * 规则：
 *   - 任务未完成
 *   - 提醒启用
 *   - 任务有 dueAt 或 dueDate
 *   - 提醒时间 = 截止时间 - offsetMinutes
 *   - 提醒时间 <= 当前时间
 *   - 本轮未通知过（lastNotifiedAt 为空 或 < 本次提醒时间）
 */
export function scanDueReminders(): PendingReminder[] {
  const db = getDb();

  // 查找所有启用的提醒，关联未完成的任务
  const rows = db.prepare(`
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
  `).all() as any[];

  const now = Date.now();
  const pending: PendingReminder[] = [];

  for (const row of rows) {
    const dueStr = row.dueAt || (row.dueDate ? row.dueDate + "T23:59:59" : null);
    if (!dueStr) continue;

    const dueMs = new Date(dueStr).getTime();
    const reminderMs = dueMs - row.offsetMinutes * 60 * 1000;

    // snooze override
    if (row.snoozedUntil) {
      const snoozeMs = new Date(row.snoozedUntil).getTime();
      if (snoozeMs > now) continue;
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

    // Normal path
    if (reminderMs > now) continue;

    if (row.lastNotifiedAt) {
      const lastNotifiedMs = new Date(row.lastNotifiedAt).getTime();
      if (lastNotifiedMs >= reminderMs) continue;
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

/**
 * 标记提醒已通知。
 */
export function markReminderNotified(reminderId: string) {
  taskRemindersRepository.markNotified(reminderId);
}

export default taskReminders;
