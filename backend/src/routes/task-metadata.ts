import crypto from "crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import { taskMetadataMigration } from "../db/taskMetadataMigration";
import {
  canManageResource,
  getUserWorkspaceRole,
  hasPermission,
  roleToPermission,
  type WorkspaceRole,
} from "../middleware/acl";

const taskMetadata = new Hono();
const MAX_LABELS_PER_SCOPE = 100;
const MAX_LABELS_PER_TASK = 20;
const MAX_VIEWS_PER_SCOPE = 30;
const LABEL_COLORS: readonly string[] = [
  "#6366f1",
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#6b7280",
];
let initializedDatabase: object | null = null;

type TaskStatus = "todo" | "doing" | "blocked" | "done";
type TaskViewDue = "all" | "pending" | "today" | "week" | "overdue" | "completed";
type LabelMode = "any" | "all";

export interface TaskSavedViewFilters {
  labelIds: string[];
  labelMode: LabelMode;
  priorities: number[];
  statuses: TaskStatus[];
  due: TaskViewDue;
  keyword: string;
  projectId?: string | null;
}

interface ResolvedScope {
  workspaceId: string | null;
  scopeKey: string;
  role: WorkspaceRole | null;
  error?: string;
}

interface TaskLabelRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  name: string;
  normalizedName: string;
  color: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  taskCount?: number;
}

interface TaskSavedViewRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  name: string;
  normalizedName: string;
  filtersJson: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

function ensureTaskMetadataTables(): void {
  const db = getDb();
  if (initializedDatabase === db) return;
  taskMetadataMigration.up(db);
  initializedDatabase = db;
}

function normalizeName(value: unknown, max = 40): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, max)
    : "";
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function normalizeColor(value: unknown, fallback: string = LABEL_COLORS[0]): string {
  if (typeof value !== "string") return fallback;
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
}

export function normalizeTaskMetadataIds(
  value: unknown,
  limit = MAX_LABELS_PER_TASK,
): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= limit) break;
  }
  return result;
}

export function normalizeTaskSavedViewFilters(input: unknown): TaskSavedViewFilters {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const validStatuses = new Set<TaskStatus>(["todo", "doing", "blocked", "done"]);
  const validDue = new Set<TaskViewDue>([
    "all",
    "pending",
    "today",
    "week",
    "overdue",
    "completed",
  ]);
  const priorities = Array.isArray(raw.priorities)
    ? Array.from(new Set(
        raw.priorities
          .map(Number)
          .filter((value) => value === 1 || value === 2 || value === 3),
      ))
    : [];
  const statuses = Array.isArray(raw.statuses)
    ? Array.from(new Set(
        raw.statuses.filter(
          (value): value is TaskStatus =>
            typeof value === "string" && validStatuses.has(value as TaskStatus),
        ),
      ))
    : [];
  const projectId = typeof raw.projectId === "string"
    ? raw.projectId.trim().slice(0, 128)
    : raw.projectId === null
      ? null
      : undefined;

  return {
    labelIds: normalizeTaskMetadataIds(raw.labelIds),
    labelMode: raw.labelMode === "all" ? "all" : "any",
    priorities,
    statuses,
    due: typeof raw.due === "string" && validDue.has(raw.due as TaskViewDue)
      ? raw.due as TaskViewDue
      : "all",
    keyword: typeof raw.keyword === "string" ? raw.keyword.trim().slice(0, 80) : "",
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

function resolveScope(userId: string, rawWorkspaceId: unknown): ResolvedScope {
  const workspaceId = typeof rawWorkspaceId === "string" ? rawWorkspaceId.trim() : "";
  if (!workspaceId || workspaceId === "personal") {
    return {
      workspaceId: null,
      scopeKey: `personal:${userId}`,
      role: null,
    };
  }
  const role = getUserWorkspaceRole(workspaceId, userId);
  if (!role) {
    return {
      workspaceId,
      scopeKey: `workspace:${workspaceId}`,
      role: null,
      error: "无权访问该工作区",
    };
  }
  return {
    workspaceId,
    scopeKey: `workspace:${workspaceId}`,
    role,
  };
}

function resolveRequestScope(
  c: Context,
  userId: string,
  body?: Record<string, unknown>,
): ResolvedScope {
  return resolveScope(userId, body?.workspaceId ?? c.req.query("workspaceId"));
}

function canWriteScope(scope: ResolvedScope): boolean {
  if (!scope.workspaceId) return true;
  return !!scope.role && hasPermission(roleToPermission(scope.role), "write");
}

function getScopeLabelIds(userId: string, scope: ResolvedScope): Set<string> {
  const rows = scope.workspaceId
    ? getDb()
        .prepare("SELECT id FROM task_labels WHERE workspaceId = ?")
        .all(scope.workspaceId)
    : getDb()
        .prepare("SELECT id FROM task_labels WHERE userId = ? AND workspaceId IS NULL")
        .all(userId);
  return new Set((rows as Array<{ id: string }>).map((row) => row.id));
}

function validateProjectScope(
  userId: string,
  scope: ResolvedScope,
  projectId: string | null | undefined,
): boolean {
  if (projectId === undefined || projectId === null || projectId === "") return true;
  const row = getDb()
    .prepare("SELECT userId, workspaceId FROM task_projects WHERE id = ?")
    .get(projectId) as { userId: string; workspaceId: string | null } | undefined;
  if (!row) return false;
  if (scope.workspaceId) return row.workspaceId === scope.workspaceId;
  return row.userId === userId && row.workspaceId === null;
}

function cleanFiltersForScope(
  userId: string,
  scope: ResolvedScope,
  input: unknown,
): TaskSavedViewFilters {
  const filters = normalizeTaskSavedViewFilters(input);
  const allowedLabels = getScopeLabelIds(userId, scope);
  const projectIsValid = validateProjectScope(userId, scope, filters.projectId);
  return {
    ...filters,
    labelIds: filters.labelIds.filter((id) => allowedLabels.has(id)),
    ...(!projectIsValid ? { projectId: undefined } : {}),
  };
}

function parseFilters(
  row: TaskSavedViewRow,
  userId: string,
  scope: ResolvedScope,
): TaskSavedViewFilters {
  try {
    return cleanFiltersForScope(userId, scope, JSON.parse(row.filtersJson));
  } catch {
    return normalizeTaskSavedViewFilters({});
  }
}

function publicLabel(row: TaskLabelRow) {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    name: row.name,
    color: row.color,
    sortOrder: row.sortOrder,
    taskCount: Number(row.taskCount || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicView(
  row: TaskSavedViewRow,
  userId: string,
  scope: ResolvedScope,
) {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    name: row.name,
    filters: parseFilters(row, userId, scope),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint") || message.includes("SQLITE_CONSTRAINT");
}

function readBody(c: Context): Promise<Record<string, unknown>> {
  return c.req.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

taskMetadata.get("/", (c) => {
  ensureTaskMetadataTables();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const scope = resolveRequestScope(c, userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const labels = (scope.workspaceId
    ? getDb().prepare(`
        SELECT l.*,
          (SELECT COUNT(*) FROM task_label_links link WHERE link.labelId = l.id) AS taskCount
        FROM task_labels l
        WHERE l.workspaceId = ?
        ORDER BY l.sortOrder ASC, l.createdAt ASC
      `).all(scope.workspaceId)
    : getDb().prepare(`
        SELECT l.*,
          (SELECT COUNT(*) FROM task_label_links link WHERE link.labelId = l.id) AS taskCount
        FROM task_labels l
        WHERE l.userId = ? AND l.workspaceId IS NULL
        ORDER BY l.sortOrder ASC, l.createdAt ASC
      `).all(userId)) as TaskLabelRow[];

  const links = (scope.workspaceId
    ? getDb().prepare(`
        SELECT link.taskId, link.labelId
        FROM task_label_links link
        JOIN tasks task ON task.id = link.taskId
        JOIN task_labels label ON label.id = link.labelId
        WHERE task.workspaceId = ? AND label.workspaceId = ?
      `).all(scope.workspaceId, scope.workspaceId)
    : getDb().prepare(`
        SELECT link.taskId, link.labelId
        FROM task_label_links link
        JOIN tasks task ON task.id = link.taskId
        JOIN task_labels label ON label.id = link.labelId
        WHERE task.userId = ? AND task.workspaceId IS NULL
          AND label.userId = ? AND label.workspaceId IS NULL
      `).all(userId, userId)) as Array<{ taskId: string; labelId: string }>;

  const assignments: Record<string, string[]> = {};
  for (const link of links) (assignments[link.taskId] ||= []).push(link.labelId);

  const views = (scope.workspaceId
    ? getDb().prepare(`
        SELECT * FROM task_saved_views
        WHERE userId = ? AND workspaceId = ?
        ORDER BY sortOrder ASC, createdAt ASC
      `).all(userId, scope.workspaceId)
    : getDb().prepare(`
        SELECT * FROM task_saved_views
        WHERE userId = ? AND workspaceId IS NULL
        ORDER BY sortOrder ASC, createdAt ASC
      `).all(userId)) as TaskSavedViewRow[];

  return c.json({
    workspaceId: scope.workspaceId || "personal",
    labels: labels.map(publicLabel),
    assignments,
    views: views.map((view) => publicView(view, userId, scope)),
  });
});

taskMetadata.post("/labels", async (c) => {
  ensureTaskMetadataTables();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = await readBody(c);
  const scope = resolveRequestScope(c, userId, body);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);
  if (!canWriteScope(scope)) {
    return c.json({ error: "当前角色不能创建任务标签", code: "FORBIDDEN" }, 403);
  }

  const name = normalizeName(body.name);
  if (!name) {
    return c.json({ error: "标签名称不能为空", code: "INVALID_LABEL_NAME" }, 400);
  }
  const countRow = (scope.workspaceId
    ? getDb().prepare("SELECT COUNT(*) AS count FROM task_labels WHERE workspaceId = ?").get(scope.workspaceId)
    : getDb().prepare("SELECT COUNT(*) AS count FROM task_labels WHERE userId = ? AND workspaceId IS NULL").get(userId)) as { count: number };
  if (Number(countRow.count) >= MAX_LABELS_PER_SCOPE) {
    return c.json({
      error: `每个空间最多创建 ${MAX_LABELS_PER_SCOPE} 个任务标签`,
      code: "LABEL_LIMIT",
    }, 400);
  }

  const now = new Date().toISOString();
  const row: TaskLabelRow = {
    id: crypto.randomUUID(),
    userId,
    workspaceId: scope.workspaceId,
    scopeKey: scope.scopeKey,
    name,
    normalizedName: normalizedName(name),
    color: normalizeColor(body.color),
    sortOrder: Number.isInteger(body.sortOrder) ? Number(body.sortOrder) : 0,
    createdAt: now,
    updatedAt: now,
    taskCount: 0,
  };
  try {
    getDb().prepare(`
      INSERT INTO task_labels (
        id, userId, workspaceId, scopeKey, name, normalizedName,
        color, sortOrder, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.userId, row.workspaceId, row.scopeKey, row.name,
      row.normalizedName, row.color, row.sortOrder, row.createdAt, row.updatedAt,
    );
  } catch (error) {
    if (isConstraintError(error)) {
      return c.json({ error: "当前空间已存在同名标签", code: "LABEL_NAME_CONFLICT" }, 409);
    }
    throw error;
  }
  return c.json({ label: publicLabel(row) }, 201);
});

taskMetadata.put("/labels/:id", async (c) => {
  ensureTaskMetadataTables();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const existing = getDb().prepare("SELECT * FROM task_labels WHERE id = ?").get(id) as TaskLabelRow | undefined;
  if (!existing) return c.json({ error: "任务标签不存在", code: "LABEL_NOT_FOUND" }, 404);
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权修改该任务标签", code: "FORBIDDEN" }, 403);
  }

  const body = await readBody(c);
  const name = body.name === undefined ? existing.name : normalizeName(body.name);
  if (!name) return c.json({ error: "标签名称不能为空", code: "INVALID_LABEL_NAME" }, 400);
  const color = body.color === undefined ? existing.color : normalizeColor(body.color, existing.color);
  const sortOrder = Number.isInteger(body.sortOrder) ? Number(body.sortOrder) : existing.sortOrder;
  const now = new Date().toISOString();
  try {
    getDb().prepare(`
      UPDATE task_labels
      SET name = ?, normalizedName = ?, color = ?, sortOrder = ?, updatedAt = ?
      WHERE id = ?
    `).run(name, normalizedName(name), color, sortOrder, now, id);
  } catch (error) {
    if (isConstraintError(error)) {
      return c.json({ error: "当前空间已存在同名标签", code: "LABEL_NAME_CONFLICT" }, 409);
    }
    throw error;
  }
  const updated = getDb().prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM task_label_links link WHERE link.labelId = l.id) AS taskCount
    FROM task_labels l WHERE l.id = ?
  `).get(id) as TaskLabelRow;
  return c.json({ label: publicLabel(updated) });
});

taskMetadata.delete("/labels/:id", (c) => {
  ensureTaskMetadataTables();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const existing = getDb().prepare("SELECT userId, workspaceId FROM task_labels WHERE id = ?").get(id) as
    | { userId: string; workspaceId: string | null }
    | undefined;
  if (!existing) return c.json({ success: true });
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权删除该任务标签", code: "FORBIDDEN" }, 403);
  }
  getDb().prepare("DELETE FROM task_labels WHERE id = ?").run(id);
  return c.json({ success: true });
});

taskMetadata.put("/tasks/:taskId/labels", async (c) => {
  ensureTaskMetadataTables();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const taskId = c.req.param("taskId");
  const task = getDb().prepare("SELECT userId, workspaceId FROM tasks WHERE id = ?").get(taskId) as
    | { userId: string; workspaceId: string | null }
    | undefined;
  if (!task) return c.json({ error: "任务不存在", code: "TASK_NOT_FOUND" }, 404);
  if (!canManageResource(task.userId, task.workspaceId, userId)) {
    return c.json({ error: "无权修改该任务的标签", code: "FORBIDDEN" }, 403);
  }

  const body = await readBody(c);
  if (!Array.isArray(body.labelIds)) {
    return c.json({ error: "labelIds 必须是数组", code: "INVALID_LABEL_IDS" }, 400);
  }
  const labelIds = normalizeTaskMetadataIds(body.labelIds);
  const taskScope = resolveScope(userId, task.workspaceId || "personal");
  if (taskScope.error) return c.json({ error: taskScope.error, code: "FORBIDDEN" }, 403);
  const allowed = getScopeLabelIds(task.workspaceId ? userId : task.userId, taskScope);
  const invalid = labelIds.filter((id) => !allowed.has(id));
  if (invalid.length > 0) {
    return c.json({
      error: "包含不存在或跨空间的任务标签",
      code: "INVALID_LABEL_SCOPE",
      invalidLabelIds: invalid,
    }, 400);
  }

  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM task_label_links WHERE taskId = ?").run(taskId);
    const insert = db.prepare("INSERT INTO task_label_links (taskId, labelId, createdAt) VALUES (?, ?, ?)");
    const now = new Date().toISOString();
    for (const labelId of labelIds) insert.run(taskId, labelId, now);
  })();
  return c.json({ taskId, labelIds });
});

taskMetadata.post("/views", async (c) => {
  ensureTaskMetadataTables();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = await readBody(c);
  const scope = resolveRequestScope(c, userId, body);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);
  const name = normalizeName(body.name, 60);
  if (!name) return c.json({ error: "视图名称不能为空", code: "INVALID_VIEW_NAME" }, 400);

  const countRow = (scope.workspaceId
    ? getDb().prepare("SELECT COUNT(*) AS count FROM task_saved_views WHERE userId = ? AND workspaceId = ?").get(userId, scope.workspaceId)
    : getDb().prepare("SELECT COUNT(*) AS count FROM task_saved_views WHERE userId = ? AND workspaceId IS NULL").get(userId)) as { count: number };
  if (Number(countRow.count) >= MAX_VIEWS_PER_SCOPE) {
    return c.json({
      error: `每个空间最多保存 ${MAX_VIEWS_PER_SCOPE} 个视图`,
      code: "VIEW_LIMIT",
    }, 400);
  }

  const rawFilters = normalizeTaskSavedViewFilters(body.filters);
  if (!validateProjectScope(userId, scope, rawFilters.projectId)) {
    return c.json({ error: "项目不属于当前空间", code: "INVALID_PROJECT_SCOPE" }, 400);
  }
  const filters = cleanFiltersForScope(userId, scope, rawFilters);
  const now = new Date().toISOString();
  const row: TaskSavedViewRow = {
    id: crypto.randomUUID(),
    userId,
    workspaceId: scope.workspaceId,
    scopeKey: scope.scopeKey,
    name,
    normalizedName: normalizedName(name),
    filtersJson: JSON.stringify(filters),
    sortOrder: Number.isInteger(body.sortOrder) ? Number(body.sortOrder) : 0,
    createdAt: now,
    updatedAt: now,
  };
  try {
    getDb().prepare(`
      INSERT INTO task_saved_views (
        id, userId, workspaceId, scopeKey, name, normalizedName,
        filtersJson, sortOrder, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.userId, row.workspaceId, row.scopeKey, row.name,
      row.normalizedName, row.filtersJson, row.sortOrder, row.createdAt, row.updatedAt,
    );
  } catch (error) {
    if (isConstraintError(error)) {
      return c.json({ error: "当前空间已存在同名视图", code: "VIEW_NAME_CONFLICT" }, 409);
    }
    throw error;
  }
  return c.json({ view: publicView(row, userId, scope) }, 201);
});

taskMetadata.put("/views/:id", async (c) => {
  ensureTaskMetadataTables();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const existing = getDb().prepare("SELECT * FROM task_saved_views WHERE id = ? AND userId = ?").get(id, userId) as TaskSavedViewRow | undefined;
  if (!existing) return c.json({ error: "保存视图不存在", code: "VIEW_NOT_FOUND" }, 404);
  const scope = resolveScope(userId, existing.workspaceId || "personal");
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const body = await readBody(c);
  const name = body.name === undefined ? existing.name : normalizeName(body.name, 60);
  if (!name) return c.json({ error: "视图名称不能为空", code: "INVALID_VIEW_NAME" }, 400);
  const rawFilters = body.filters === undefined
    ? parseFilters(existing, userId, scope)
    : normalizeTaskSavedViewFilters(body.filters);
  if (!validateProjectScope(userId, scope, rawFilters.projectId)) {
    return c.json({ error: "项目不属于当前空间", code: "INVALID_PROJECT_SCOPE" }, 400);
  }
  const filters = cleanFiltersForScope(userId, scope, rawFilters);
  const sortOrder = Number.isInteger(body.sortOrder) ? Number(body.sortOrder) : existing.sortOrder;
  const now = new Date().toISOString();
  try {
    getDb().prepare(`
      UPDATE task_saved_views
      SET name = ?, normalizedName = ?, filtersJson = ?, sortOrder = ?, updatedAt = ?
      WHERE id = ? AND userId = ?
    `).run(name, normalizedName(name), JSON.stringify(filters), sortOrder, now, id, userId);
  } catch (error) {
    if (isConstraintError(error)) {
      return c.json({ error: "当前空间已存在同名视图", code: "VIEW_NAME_CONFLICT" }, 409);
    }
    throw error;
  }
  const updated = getDb().prepare("SELECT * FROM task_saved_views WHERE id = ?").get(id) as TaskSavedViewRow;
  return c.json({ view: publicView(updated, userId, scope) });
});

taskMetadata.delete("/views/:id", (c) => {
  ensureTaskMetadataTables();
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  getDb().prepare("DELETE FROM task_saved_views WHERE id = ? AND userId = ?").run(id, userId);
  return c.json({ success: true });
});

export default taskMetadata;
