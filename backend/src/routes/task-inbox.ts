import crypto from "node:crypto";
import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import {
  ensureTaskInboxSchema,
  TASK_INBOX_SOURCE_TYPES,
} from "../db/taskInboxMigration.js";
import { getUserWorkspaceRole } from "../middleware/acl.js";

const taskInbox = new Hono();
const SOURCE_TYPES = new Set<string>(TASK_INBOX_SOURCE_TYPES);
const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_EXCERPT_LENGTH = 8_000;
const MAX_SOURCE_ID_LENGTH = 1_000;
const MAX_SOURCE_TITLE_LENGTH = 300;
let initializedDatabase: object | null = null;

interface TaskAccessRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  isCompleted: number;
}

function ensureSchema(): void {
  const db = getDb();
  if (initializedDatabase === db) return;
  ensureTaskInboxSchema(db);
  initializedDatabase = db;
}

function resolveScope(userId: string, rawWorkspaceId: unknown):
  | { workspaceId: string | null }
  | { workspaceId: string; error: string } {
  const workspaceId = typeof rawWorkspaceId === "string" ? rawWorkspaceId.trim() : "";
  if (!workspaceId || workspaceId === "personal") return { workspaceId: null };
  if (!getUserWorkspaceRole(workspaceId, userId)) {
    return { workspaceId, error: "无权访问该工作区" };
  }
  return { workspaceId };
}

function canReadTask(task: TaskAccessRow, userId: string): boolean {
  if (task.workspaceId) return getUserWorkspaceRole(task.workspaceId, userId) !== null;
  return task.userId === userId;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function nullableText(value: unknown, maxLength: number): string | null {
  const normalized = cleanText(value, maxLength);
  return normalized || null;
}

function normalizeSourceType(value: unknown): string {
  const normalized = cleanText(value, 40).toLowerCase();
  return SOURCE_TYPES.has(normalized) ? normalized : "other";
}

function normalizePriority(value: unknown): number {
  const priority = Number(value);
  return Number.isInteger(priority) && priority >= 1 && priority <= 3 ? priority : 2;
}

function normalizeDateKey(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return value;
}

function normalizeDueAt(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length > 80 || Number.isNaN(new Date(normalized).getTime())) return null;
  return normalized;
}

function taskRow(taskId: string): TaskAccessRow | undefined {
  return getDb().prepare(
    "SELECT id, userId, workspaceId, isCompleted FROM tasks WHERE id = ?",
  ).get(taskId) as TaskAccessRow | undefined;
}

function listInbox(userId: string, workspaceId: string | null) {
  const scopeSql = workspaceId ? "i.workspaceId = ?" : "i.workspaceId IS NULL";
  const params = workspaceId ? [userId, workspaceId] : [userId];
  return getDb().prepare(`
    SELECT
      t.*,
      users.username AS creatorName,
      i.capturedAt AS inboxAt,
      i.sourceType AS captureSourceType,
      i.sourceId AS captureSourceId,
      i.sourceTitle AS captureSourceTitle,
      i.excerpt AS captureExcerpt
    FROM task_inbox_items i
    INNER JOIN tasks t ON t.id = i.taskId
    LEFT JOIN users ON users.id = t.userId
    WHERE i.userId = ?
      AND ${scopeSql}
      AND t.isCompleted = 0
    ORDER BY i.capturedAt DESC, t.createdAt DESC
  `).all(...params);
}

function inboxCount(userId: string, workspaceId: string | null): number {
  const scopeSql = workspaceId ? "i.workspaceId = ?" : "i.workspaceId IS NULL";
  const params = workspaceId ? [userId, workspaceId] : [userId];
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM task_inbox_items i
    INNER JOIN tasks t ON t.id = i.taskId
    WHERE i.userId = ?
      AND ${scopeSql}
      AND t.isCompleted = 0
  `).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

// GET /api/user-preferences/task-inbox?workspaceId=personal|uuid
taskInbox.get("/", (c) => {
  ensureSchema();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const scope = resolveScope(userId, c.req.query("workspaceId"));
  if ("error" in scope) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const items = listInbox(userId, scope.workspaceId);
  return c.json({
    workspaceId: scope.workspaceId || "personal",
    count: items.length,
    items,
  });
});

// GET /api/user-preferences/task-inbox/count?workspaceId=personal|uuid
taskInbox.get("/count", (c) => {
  ensureSchema();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const scope = resolveScope(userId, c.req.query("workspaceId"));
  if ("error" in scope) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);
  return c.json({
    workspaceId: scope.workspaceId || "personal",
    count: inboxCount(userId, scope.workspaceId),
  });
});

// POST /api/user-preferences/task-inbox/capture
// Creates the task and its personal Inbox membership in one SQLite transaction.
taskInbox.post("/capture", async (c) => {
  ensureSchema();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const title = cleanText(body?.title, MAX_TITLE_LENGTH);
  if (!title) return c.json({ error: "title is required", code: "TITLE_REQUIRED" }, 400);

  const scope = resolveScope(userId, body?.workspaceId);
  if ("error" in scope) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const description = cleanText(body?.description, MAX_DESCRIPTION_LENGTH);
  const priority = normalizePriority(body?.priority);
  const dueDate = normalizeDateKey(body?.dueDate);
  const dueAt = normalizeDueAt(body?.dueAt);
  const startDate = normalizeDateKey(body?.startDate);
  if (body?.dueDate && !dueDate) {
    return c.json({ error: "dueDate must use YYYY-MM-DD", code: "INVALID_DUE_DATE" }, 400);
  }
  if (body?.dueAt && !dueAt) {
    return c.json({ error: "dueAt must be a valid date-time", code: "INVALID_DUE_AT" }, 400);
  }
  if (body?.startDate && !startDate) {
    return c.json({ error: "startDate must use YYYY-MM-DD", code: "INVALID_START_DATE" }, 400);
  }
  if (startDate && dueDate && startDate > dueDate) {
    return c.json({ error: "startDate cannot be after dueDate", code: "INVALID_DATE_RANGE" }, 400);
  }

  const noteId = nullableText(body?.noteId, 128);
  const sourceType = normalizeSourceType(body?.sourceType);
  const sourceId = nullableText(body?.sourceId, MAX_SOURCE_ID_LENGTH);
  const sourceTitle = nullableText(body?.sourceTitle, MAX_SOURCE_TITLE_LENGTH);
  const excerpt = cleanText(body?.excerpt, MAX_EXCERPT_LENGTH);
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  const transaction = getDb().transaction(() => {
    getDb().prepare(`
      INSERT INTO tasks (
        id, userId, workspaceId, title, description, isCompleted, completedAt,
        priority, dueDate, dueAt, startDate, noteId, parentId, projectId,
        status, repeatRule, repeatInterval, repeatEndDate, repeatGroupId,
        repeatGeneratedFromId, repeatEndCount, repeatSequenceIndex, repeatRuleJson
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, NULL, NULL,
                'todo', 'none', 1, NULL, NULL, NULL, NULL, NULL, NULL)
    `).run(
      taskId,
      userId,
      scope.workspaceId,
      title,
      description,
      priority,
      dueDate,
      dueAt,
      startDate,
      noteId,
    );

    getDb().prepare(`
      INSERT INTO task_inbox_items (
        taskId, userId, workspaceId, capturedAt, sourceType,
        sourceId, sourceTitle, excerpt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      userId,
      scope.workspaceId,
      now,
      sourceType,
      sourceId,
      sourceTitle,
      excerpt,
      now,
      now,
    );
  });
  transaction();

  const task = getDb().prepare(`
    SELECT
      t.*,
      users.username AS creatorName,
      i.capturedAt AS inboxAt,
      i.sourceType AS captureSourceType,
      i.sourceId AS captureSourceId,
      i.sourceTitle AS captureSourceTitle,
      i.excerpt AS captureExcerpt
    FROM tasks t
    INNER JOIN task_inbox_items i ON i.taskId = t.id AND i.userId = ?
    LEFT JOIN users ON users.id = t.userId
    WHERE t.id = ?
  `).get(userId, taskId);

  return c.json({
    task,
    count: inboxCount(userId, scope.workspaceId),
  }, 201);
});

// POST /api/user-preferences/task-inbox/:taskId
// Adds an existing readable task to the current user's personal Inbox.
taskInbox.post("/:taskId", async (c) => {
  ensureSchema();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const task = taskRow(c.req.param("taskId"));
  if (!task || !canReadTask(task, userId)) {
    return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
  }
  if (task.isCompleted) {
    return c.json({ error: "Completed task cannot be added to Inbox", code: "TASK_COMPLETED" }, 409);
  }

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const sourceType = normalizeSourceType(body.sourceType || "manual");
  const sourceId = nullableText(body.sourceId, MAX_SOURCE_ID_LENGTH);
  const sourceTitle = nullableText(body.sourceTitle, MAX_SOURCE_TITLE_LENGTH);
  const excerpt = cleanText(body.excerpt, MAX_EXCERPT_LENGTH);
  const now = new Date().toISOString();

  getDb().prepare(`
    INSERT INTO task_inbox_items (
      taskId, userId, workspaceId, capturedAt, sourceType,
      sourceId, sourceTitle, excerpt, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(taskId, userId) DO UPDATE SET
      workspaceId = excluded.workspaceId,
      capturedAt = excluded.capturedAt,
      sourceType = excluded.sourceType,
      sourceId = excluded.sourceId,
      sourceTitle = excluded.sourceTitle,
      excerpt = excluded.excerpt,
      updatedAt = excluded.updatedAt
  `).run(
    task.id,
    userId,
    task.workspaceId,
    now,
    sourceType,
    sourceId,
    sourceTitle,
    excerpt,
    now,
    now,
  );

  return c.json({
    success: true,
    taskId: task.id,
    count: inboxCount(userId, task.workspaceId),
  });
});

// DELETE /api/user-preferences/task-inbox/:taskId
// Organizes the task out of Inbox without completing or deleting the task itself.
taskInbox.delete("/:taskId", (c) => {
  ensureSchema();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const existing = getDb().prepare(
    "SELECT workspaceId FROM task_inbox_items WHERE taskId = ? AND userId = ?",
  ).get(c.req.param("taskId"), userId) as { workspaceId: string | null } | undefined;
  if (!existing) {
    return c.json({ error: "Inbox item not found", code: "INBOX_ITEM_NOT_FOUND" }, 404);
  }

  getDb().prepare(
    "DELETE FROM task_inbox_items WHERE taskId = ? AND userId = ?",
  ).run(c.req.param("taskId"), userId);

  return c.json({
    success: true,
    taskId: c.req.param("taskId"),
    count: inboxCount(userId, existing.workspaceId),
  });
});

export default taskInbox;
