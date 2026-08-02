import crypto from "crypto";
import { Hono } from "hono";
import { getDb } from "../db/schema";
import { ensureTaskTimePlanningSchema } from "../db/taskTimePlanningMigration";
import { canManageResource, getUserWorkspaceRole } from "../middleware/acl";

const taskTimeBlocks = new Hono();
const MIN_BLOCK_MINUTES = 5;
const MAX_BLOCK_MINUTES = 24 * 60;
const MAX_RANGE_DAYS = 93;
const MAX_ESTIMATE_MINUTES = 7 * 24 * 60;
let initializedDatabase: object | null = null;

interface TaskRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  estimatedMinutes: number | null;
}

interface TimeBlockRow {
  id: string;
  taskId: string;
  userId: string;
  workspaceId: string | null;
  startAt: string;
  endAt: string;
  timeZone: string;
  createdAt: string;
  updatedAt: string;
}

interface ResolvedScope {
  workspaceId: string | null;
  error?: string;
}

function ensureSchema(): void {
  const db = getDb();
  if (initializedDatabase === db) return;
  ensureTaskTimePlanningSchema(db);
  initializedDatabase = db;
}

function resolveScope(userId: string, rawWorkspaceId: unknown): ResolvedScope {
  const workspaceId = typeof rawWorkspaceId === "string" ? rawWorkspaceId.trim() : "";
  if (!workspaceId || workspaceId === "personal") return { workspaceId: null };
  if (!getUserWorkspaceRole(workspaceId, userId)) {
    return { workspaceId, error: "无权访问该工作区" };
  }
  return { workspaceId };
}

function canReadTask(task: TaskRow, userId: string): boolean {
  if (task.workspaceId) return getUserWorkspaceRole(task.workspaceId, userId) !== null;
  return task.userId === userId;
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function normalizeTimeZone(value: unknown): string {
  if (typeof value !== "string") return "UTC";
  const normalized = value.trim();
  if (!normalized || normalized.length > 100 || !/^[A-Za-z0-9_+\-/]+$/.test(normalized)) {
    return "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    return "UTC";
  }
}

function normalizeEstimate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ESTIMATE_MINUTES) {
    throw new Error("INVALID_ESTIMATE");
  }
  return minutes;
}

function validateBlockRange(startAt: unknown, endAt: unknown):
  | { startAt: string; endAt: string }
  | { error: string; code: string } {
  const normalizedStart = normalizeIso(startAt);
  const normalizedEnd = normalizeIso(endAt);
  if (!normalizedStart || !normalizedEnd) {
    return { error: "startAt and endAt must be valid ISO date-times", code: "INVALID_TIME_BLOCK_RANGE" };
  }
  const durationMinutes = (Date.parse(normalizedEnd) - Date.parse(normalizedStart)) / 60_000;
  if (durationMinutes < MIN_BLOCK_MINUTES || durationMinutes > MAX_BLOCK_MINUTES) {
    return {
      error: `Time block duration must be between ${MIN_BLOCK_MINUTES} and ${MAX_BLOCK_MINUTES} minutes`,
      code: "INVALID_TIME_BLOCK_DURATION",
    };
  }
  return { startAt: normalizedStart, endAt: normalizedEnd };
}

function getTask(taskId: string): TaskRow | undefined {
  return getDb().prepare(
    "SELECT id, userId, workspaceId, title, estimatedMinutes FROM tasks WHERE id = ?",
  ).get(taskId) as TaskRow | undefined;
}

function serializeBlock(row: TimeBlockRow & Record<string, unknown>) {
  return {
    ...row,
    workspaceId: row.workspaceId || "personal",
  };
}

// GET /api/user-preferences/task-time-blocks?workspaceId=...&from=...&to=...
taskTimeBlocks.get("/", (c) => {
  ensureSchema();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const scope = resolveScope(userId, c.req.query("workspaceId"));
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const defaultTo = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 8).toISOString();
  const from = normalizeIso(c.req.query("from")) || defaultFrom;
  const to = normalizeIso(c.req.query("to")) || defaultTo;
  if (Date.parse(to) <= Date.parse(from)) {
    return c.json({ error: "to must be after from", code: "INVALID_TIME_BLOCK_RANGE" }, 400);
  }
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) {
    return c.json({ error: `Range cannot exceed ${MAX_RANGE_DAYS} days`, code: "TIME_BLOCK_RANGE_TOO_LARGE" }, 400);
  }

  const taskId = (c.req.query("taskId") || "").trim();
  const params: unknown[] = [userId];
  let sql = `
    SELECT b.*, t.title AS taskTitle, t.priority, t.projectId, t.isCompleted,
           t.estimatedMinutes
    FROM task_time_blocks b
    INNER JOIN tasks t ON t.id = b.taskId
    WHERE b.userId = ?
  `;
  if (scope.workspaceId) {
    sql += " AND b.workspaceId = ?";
    params.push(scope.workspaceId);
  } else {
    sql += " AND b.workspaceId IS NULL";
  }
  sql += " AND b.endAt > ? AND b.startAt < ?";
  params.push(from, to);
  if (taskId) {
    sql += " AND b.taskId = ?";
    params.push(taskId);
  }
  sql += " ORDER BY b.startAt ASC, b.createdAt ASC";

  const rows = getDb().prepare(sql).all(...params) as Array<TimeBlockRow & Record<string, unknown>>;
  return c.json({
    workspaceId: scope.workspaceId || "personal",
    from,
    to,
    blocks: rows.map(serializeBlock),
  });
});

// PUT /api/user-preferences/task-time-blocks/tasks/:taskId/estimate
taskTimeBlocks.put("/tasks/:taskId/estimate", async (c) => {
  ensureSchema();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const taskId = c.req.param("taskId");
  const task = getTask(taskId);
  if (!task) return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
  if (!canManageResource(task.userId, task.workspaceId, userId)) {
    return c.json({ error: "无权修改该任务", code: "FORBIDDEN" }, 403);
  }

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  let estimatedMinutes: number | null;
  try {
    estimatedMinutes = normalizeEstimate(body?.estimatedMinutes);
  } catch {
    return c.json({
      error: `estimatedMinutes must be an integer between 1 and ${MAX_ESTIMATE_MINUTES}`,
      code: "INVALID_ESTIMATE",
    }, 400);
  }

  getDb().prepare(
    "UPDATE tasks SET estimatedMinutes = ?, updatedAt = datetime('now') WHERE id = ?",
  ).run(estimatedMinutes, taskId);
  return c.json({ taskId, estimatedMinutes });
});

// POST /api/user-preferences/task-time-blocks
taskTimeBlocks.post("/", async (c) => {
  ensureSchema();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const taskId = typeof body?.taskId === "string" ? body.taskId.trim() : "";
  if (!taskId) return c.json({ error: "taskId is required", code: "TASK_ID_REQUIRED" }, 400);

  const task = getTask(taskId);
  if (!task || !canReadTask(task, userId)) {
    return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
  }

  const range = validateBlockRange(body?.startAt, body?.endAt);
  if ("error" in range) return c.json({ error: range.error, code: range.code }, 400);

  const id = crypto.randomUUID();
  const timeZone = normalizeTimeZone(body?.timeZone);
  getDb().prepare(`
    INSERT INTO task_time_blocks (
      id, taskId, userId, workspaceId, startAt, endAt, timeZone, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    task.id,
    userId,
    task.workspaceId,
    range.startAt,
    range.endAt,
    timeZone,
    new Date().toISOString(),
    new Date().toISOString(),
  );

  const row = getDb().prepare(`
    SELECT b.*, t.title AS taskTitle, t.priority, t.projectId, t.isCompleted,
           t.estimatedMinutes
    FROM task_time_blocks b
    INNER JOIN tasks t ON t.id = b.taskId
    WHERE b.id = ?
  `).get(id) as TimeBlockRow & Record<string, unknown>;
  return c.json({ block: serializeBlock(row) }, 201);
});

// PUT /api/user-preferences/task-time-blocks/:id
taskTimeBlocks.put("/:id", async (c) => {
  ensureSchema();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const existing = getDb().prepare(
    "SELECT * FROM task_time_blocks WHERE id = ? AND userId = ?",
  ).get(id, userId) as TimeBlockRow | undefined;
  if (!existing) return c.json({ error: "Time block not found", code: "TIME_BLOCK_NOT_FOUND" }, 404);

  const task = getTask(existing.taskId);
  if (!task || !canReadTask(task, userId)) {
    return c.json({ error: "Time block not found", code: "TIME_BLOCK_NOT_FOUND" }, 404);
  }

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const range = validateBlockRange(
    body?.startAt ?? existing.startAt,
    body?.endAt ?? existing.endAt,
  );
  if ("error" in range) return c.json({ error: range.error, code: range.code }, 400);
  const timeZone = body && Object.prototype.hasOwnProperty.call(body, "timeZone")
    ? normalizeTimeZone(body.timeZone)
    : existing.timeZone;

  getDb().prepare(`
    UPDATE task_time_blocks
    SET startAt = ?, endAt = ?, timeZone = ?, updatedAt = ?
    WHERE id = ? AND userId = ?
  `).run(range.startAt, range.endAt, timeZone, new Date().toISOString(), id, userId);

  const row = getDb().prepare(`
    SELECT b.*, t.title AS taskTitle, t.priority, t.projectId, t.isCompleted,
           t.estimatedMinutes
    FROM task_time_blocks b
    INNER JOIN tasks t ON t.id = b.taskId
    WHERE b.id = ? AND b.userId = ?
  `).get(id, userId) as TimeBlockRow & Record<string, unknown>;
  return c.json({ block: serializeBlock(row) });
});

taskTimeBlocks.delete("/:id", (c) => {
  ensureSchema();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const result = getDb().prepare(
    "DELETE FROM task_time_blocks WHERE id = ? AND userId = ?",
  ).run(c.req.param("id"), userId);
  if (result.changes === 0) {
    return c.json({ error: "Time block not found", code: "TIME_BLOCK_NOT_FOUND" }, 404);
  }
  return c.json({ success: true });
});

export default taskTimeBlocks;