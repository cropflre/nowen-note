import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import crypto from "crypto";
import {
  getUserWorkspaceRole,
  canManageResource,
} from "../middleware/acl";

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

// 获取某任务的所有提醒配置
taskReminders.get("/:taskId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const taskId = c.req.param("taskId");

  const task = db.prepare("SELECT id, userId, workspaceId FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return c.json({ error: "Task not found" }, 404);

  const rows = db.prepare(
    "SELECT * FROM task_reminders WHERE taskId = ? AND userId = ? ORDER BY offsetMinutes ASC"
  ).all(taskId, userId);

  return c.json(rows);
});

// 创建提醒
taskReminders.post("/:taskId", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const taskId = c.req.param("taskId");
  const body = await c.req.json();

  const task = db.prepare("SELECT id, userId, workspaceId FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return c.json({ error: "Task not found" }, 404);

  const offsetMinutes = body.offsetMinutes ?? 30;
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled)
    VALUES (?, ?, ?, ?, 1)
  `).run(id, taskId, userId, offsetMinutes);

  const reminder = db.prepare("SELECT * FROM task_reminders WHERE id = ?").get(id);
  return c.json(reminder, 201);
});

// 更新提醒（启用/禁用、修改 offset）
taskReminders.put("/:reminderId", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const reminderId = c.req.param("reminderId");

  const existing = db.prepare("SELECT * FROM task_reminders WHERE id = ?").get(reminderId) as any;
  if (!existing) return c.json({ error: "Reminder not found" }, 404);
  if (existing.userId !== userId) return c.json({ error: "无权修改", code: "FORBIDDEN" }, 403);

  const body = await c.req.json();
  const offsetMinutes = body.offsetMinutes ?? existing.offsetMinutes;
  const enabled = body.enabled ?? existing.enabled;

  db.prepare(`
    UPDATE task_reminders SET offsetMinutes = ?, enabled = ?, updatedAt = datetime('now')
    WHERE id = ?
  `).run(offsetMinutes, enabled ? 1 : 0, reminderId);

  const updated = db.prepare("SELECT * FROM task_reminders WHERE id = ?").get(reminderId);
  return c.json(updated);
});

// 删除提醒
taskReminders.delete("/:reminderId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const reminderId = c.req.param("reminderId");

  const existing = db.prepare("SELECT * FROM task_reminders WHERE id = ?").get(reminderId) as any;
  if (!existing) return c.json({ error: "Reminder not found" }, 404);
  if (existing.userId !== userId) return c.json({ error: "无权删除", code: "FORBIDDEN" }, 403);

  db.prepare("DELETE FROM task_reminders WHERE id = ?").run(reminderId);
  return c.json({ success: true });
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

    // 到提醒时间了
    if (reminderMs > now) continue;

    // 已经通知过
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
    });
  }

  return pending;
}

/**
 * 标记提醒已通知。
 */
export function markReminderNotified(reminderId: string) {
  const db = getDb();
  db.prepare(
    "UPDATE task_reminders SET lastNotifiedAt = datetime('now') WHERE id = ?"
  ).run(reminderId);
}

export default taskReminders;
