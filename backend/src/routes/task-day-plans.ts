import crypto from "crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole } from "../middleware/acl";

const taskDayPlans = new Hono();
const MAX_TASKS_PER_DAY = 200;
const MAX_FOCUS_TASKS = 3;
const PLAN_RETENTION_DAYS = 45;
let initializedDatabase: object | null = null;

interface TaskDayPlanRow {
  id: string;
  userId: string;
  scopeKey: string;
  workspaceId: string | null;
  planDate: string;
  taskIdsJson: string;
  focusTaskIdsJson: string;
  createdAt: string;
  updatedAt: string;
}

interface ResolvedScope {
  scopeKey: string;
  workspaceId: string | null;
  error?: string;
}

function ensureTaskDayPlansTable(): void {
  const db = getDb();
  if (initializedDatabase === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_day_plans (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      scopeKey TEXT NOT NULL,
      workspaceId TEXT,
      planDate TEXT NOT NULL,
      taskIdsJson TEXT NOT NULL,
      focusTaskIdsJson TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_day_plans_user_scope_date
      ON task_day_plans(userId, scopeKey, planDate);
    CREATE INDEX IF NOT EXISTS idx_task_day_plans_user_date
      ON task_day_plans(userId, planDate);
  `);
  initializedDatabase = db;
}

export function isTaskDayPlanDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function normalizeTaskDayPlanIds(value: unknown, limit = MAX_TASKS_PER_DAY): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= limit) break;
  }
  return result;
}

function parseStoredIds(value: string, limit: number): string[] {
  try {
    return normalizeTaskDayPlanIds(JSON.parse(value), limit);
  } catch {
    return [];
  }
}

function resolveScope(c: Context, userId: string, rawWorkspaceId: unknown): ResolvedScope {
  const workspaceId = typeof rawWorkspaceId === "string" ? rawWorkspaceId.trim() : "";
  if (!workspaceId || workspaceId === "personal") {
    return { scopeKey: "personal", workspaceId: null };
  }
  if (!getUserWorkspaceRole(workspaceId, userId)) {
    return { scopeKey: workspaceId, workspaceId, error: "无权访问该工作区" };
  }
  return { scopeKey: workspaceId, workspaceId };
}

function planId(userId: string, scopeKey: string, planDate: string): string {
  return crypto
    .createHash("sha256")
    .update(`${userId}\u0000${scopeKey}\u0000${planDate}`)
    .digest("hex");
}

function getAccessibleTaskIds(
  userId: string,
  workspaceId: string | null,
  taskIds: string[],
): Set<string> {
  if (taskIds.length === 0) return new Set();
  const db = getDb();
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = workspaceId
    ? db.prepare(
        `SELECT id FROM tasks WHERE workspaceId = ? AND id IN (${placeholders})`,
      ).all(workspaceId, ...taskIds) as Array<{ id: string }>
    : db.prepare(
        `SELECT id FROM tasks WHERE userId = ? AND workspaceId IS NULL AND id IN (${placeholders})`,
      ).all(userId, ...taskIds) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function cleanStoredPlan(row: TaskDayPlanRow, userId: string): {
  taskIds: string[];
  focusTaskIds: string[];
} {
  const taskIds = parseStoredIds(row.taskIdsJson, MAX_TASKS_PER_DAY);
  const accessibleIds = getAccessibleTaskIds(userId, row.workspaceId, taskIds);
  const cleanedTaskIds = taskIds.filter((id) => accessibleIds.has(id));
  const taskIdSet = new Set(cleanedTaskIds);
  const focusTaskIds = parseStoredIds(row.focusTaskIdsJson, MAX_FOCUS_TASKS)
    .filter((id) => taskIdSet.has(id))
    .slice(0, MAX_FOCUS_TASKS);
  return { taskIds: cleanedTaskIds, focusTaskIds };
}

function emptyPlan(planDate: string, workspaceId: string | null) {
  return {
    date: planDate,
    workspaceId: workspaceId || "personal",
    taskIds: [] as string[],
    focusTaskIds: [] as string[],
    updatedAt: null as string | null,
  };
}

// GET /api/user-preferences/task-day-plans?date=YYYY-MM-DD&workspaceId=personal|uuid
// Each user owns an independent daily plan, including inside a shared workspace.
taskDayPlans.get("/", (c) => {
  ensureTaskDayPlansTable();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const planDate = c.req.query("date");
  if (!isTaskDayPlanDate(planDate)) {
    return c.json({ error: "date must use YYYY-MM-DD", code: "INVALID_PLAN_DATE" }, 400);
  }
  const scope = resolveScope(c, userId, c.req.query("workspaceId"));
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const row = getDb().prepare(
    "SELECT * FROM task_day_plans WHERE id = ? AND userId = ?",
  ).get(planId(userId, scope.scopeKey, planDate), userId) as TaskDayPlanRow | undefined;
  if (!row) return c.json(emptyPlan(planDate, scope.workspaceId));

  const cleaned = cleanStoredPlan(row, userId);
  if (
    JSON.stringify(cleaned.taskIds) !== row.taskIdsJson ||
    JSON.stringify(cleaned.focusTaskIds) !== row.focusTaskIdsJson
  ) {
    getDb().prepare(
      "UPDATE task_day_plans SET taskIdsJson = ?, focusTaskIdsJson = ?, updatedAt = ? WHERE id = ?",
    ).run(JSON.stringify(cleaned.taskIds), JSON.stringify(cleaned.focusTaskIds), new Date().toISOString(), row.id);
  }

  return c.json({
    date: row.planDate,
    workspaceId: row.workspaceId || "personal",
    taskIds: cleaned.taskIds,
    focusTaskIds: cleaned.focusTaskIds,
    updatedAt: row.updatedAt,
  });
});

// PUT /api/user-preferences/task-day-plans
// Body: { date, workspaceId, taskIds, focusTaskIds }
taskDayPlans.put("/", async (c) => {
  ensureTaskDayPlansTable();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !isTaskDayPlanDate(body.date)) {
    return c.json({ error: "date must use YYYY-MM-DD", code: "INVALID_PLAN_DATE" }, 400);
  }
  if (!Array.isArray(body.taskIds) || !Array.isArray(body.focusTaskIds)) {
    return c.json({ error: "taskIds and focusTaskIds must be arrays", code: "INVALID_PLAN_TASKS" }, 400);
  }

  const scope = resolveScope(c, userId, body.workspaceId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const taskIds = normalizeTaskDayPlanIds(body.taskIds, MAX_TASKS_PER_DAY);
  const taskIdSet = new Set(taskIds);
  const focusTaskIds = normalizeTaskDayPlanIds(body.focusTaskIds, MAX_FOCUS_TASKS)
    .filter((id) => taskIdSet.has(id))
    .slice(0, MAX_FOCUS_TASKS);

  const accessibleIds = getAccessibleTaskIds(userId, scope.workspaceId, taskIds);
  const invalidTaskIds = taskIds.filter((id) => !accessibleIds.has(id));
  if (invalidTaskIds.length > 0) {
    return c.json({
      error: "计划中包含不存在或无权访问的任务",
      code: "INVALID_PLAN_TASK_SCOPE",
      invalidTaskIds,
    }, 400);
  }

  const db = getDb();
  const id = planId(userId, scope.scopeKey, body.date);
  const now = new Date().toISOString();
  const existing = db.prepare(
    "SELECT id, createdAt FROM task_day_plans WHERE id = ? AND userId = ?",
  ).get(id, userId) as { id: string; createdAt: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE task_day_plans
      SET taskIdsJson = ?, focusTaskIdsJson = ?, workspaceId = ?, updatedAt = ?
      WHERE id = ? AND userId = ?
    `).run(
      JSON.stringify(taskIds),
      JSON.stringify(focusTaskIds),
      scope.workspaceId,
      now,
      id,
      userId,
    );
  } else {
    db.prepare(`
      INSERT INTO task_day_plans (
        id, userId, scopeKey, workspaceId, planDate,
        taskIdsJson, focusTaskIdsJson, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      scope.scopeKey,
      scope.workspaceId,
      body.date,
      JSON.stringify(taskIds),
      JSON.stringify(focusTaskIds),
      now,
      now,
    );
  }

  const cutoff = new Date(Date.now() - PLAN_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  db.prepare("DELETE FROM task_day_plans WHERE userId = ? AND planDate < ?").run(userId, cutoff);

  return c.json({
    date: body.date,
    workspaceId: scope.workspaceId || "personal",
    taskIds,
    focusTaskIds,
    updatedAt: now,
  });
});

// DELETE /api/user-preferences/task-day-plans?date=YYYY-MM-DD&workspaceId=personal|uuid
taskDayPlans.delete("/", (c) => {
  ensureTaskDayPlansTable();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const planDate = c.req.query("date");
  if (!isTaskDayPlanDate(planDate)) {
    return c.json({ error: "date must use YYYY-MM-DD", code: "INVALID_PLAN_DATE" }, 400);
  }
  const scope = resolveScope(c, userId, c.req.query("workspaceId"));
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  getDb().prepare("DELETE FROM task_day_plans WHERE id = ? AND userId = ?")
    .run(planId(userId, scope.scopeKey, planDate), userId);
  return c.json(emptyPlan(planDate, scope.workspaceId));
});

export default taskDayPlans;
