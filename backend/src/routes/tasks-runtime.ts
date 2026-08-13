import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createTaskCoreRepository,
  type TaskCoreRow,
  type TaskListFilter,
} from "../repositories/taskCoreRepository";
import {
  createTaskRecurrenceRuntime,
  isInvalidTaskDateRange,
  normalizeRepeatEndCount,
  normalizeTaskCustomRepeatRule,
  VALID_TASK_REPEAT_RULES,
  VALID_TASK_STATUSES,
  validateTaskCustomRepeatRule,
} from "../services/task-recurrence-runtime";

type WorkspaceRole = "owner" | "admin" | "editor" | "commenter" | "viewer";

type JsonBody = Record<string, unknown>;

function asNullableString(value: unknown, fallback: string | null = null): string | null {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  return typeof value === "string" ? value : String(value);
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function completedValue(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

async function readBody(c: Context): Promise<JsonBody> {
  return c.req.json<JsonBody>().catch(() => ({}));
}

function parseEnabledFeatures(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function createTasksRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();
  const repository = createTaskCoreRepository(adapter, "postgres");
  const recurrence = createTaskRecurrenceRuntime(adapter);

  async function workspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const row = await adapter.queryOne<{ role: string }>(
      `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
      [workspaceId, userId],
    );
    const role = row?.role;
    return role === "owner" || role === "admin" || role === "editor" || role === "commenter" || role === "viewer"
      ? role
      : null;
  }

  async function resolveCollectionScope(c: Context, userId: string): Promise<
    | { ok: true; scope: { kind: "personal"; userId: string; workspaceId: null } | { kind: "workspace"; userId: string; workspaceId: string } }
    | { ok: false; response: Response }
  > {
    const rawWorkspaceId = c.req.query("workspaceId");
    if (!rawWorkspaceId || rawWorkspaceId === "personal") {
      return { ok: true, scope: { kind: "personal", userId, workspaceId: null } };
    }

    const row = await adapter.queryOne<{ role: string; enabledFeatures: string | null }>(
      `SELECT wm.role,
              w."enabledFeatures" AS "enabledFeatures"
         FROM workspace_members wm
         JOIN workspaces w ON w.id = wm."workspaceId"
        WHERE wm."workspaceId" = ? AND wm."userId" = ?`,
      [rawWorkspaceId, userId],
    );
    if (!row) {
      return {
        ok: false,
        response: c.json({ error: "无权访问该工作区", code: "FORBIDDEN" }, 403),
      };
    }
    const features = parseEnabledFeatures(row.enabledFeatures);
    if (features.tasks === false) {
      return {
        ok: false,
        response: c.json({
          error: "该功能在当前工作区已被管理员关闭",
          code: "FEATURE_DISABLED",
          feature: "tasks",
        }, 403),
      };
    }
    return {
      ok: true,
      scope: { kind: "workspace", userId, workspaceId: rawWorkspaceId },
    };
  }

  async function canReadTask(task: Pick<TaskCoreRow, "userId" | "workspaceId">, actorId: string): Promise<boolean> {
    if (!actorId) return false;
    if (!task.workspaceId) return task.userId === actorId;
    return (await workspaceRole(task.workspaceId, actorId)) !== null;
  }

  async function canManageTask(task: Pick<TaskCoreRow, "userId" | "workspaceId">, actorId: string): Promise<boolean> {
    if (!actorId) return false;
    if (task.userId === actorId) return true;
    if (!task.workspaceId) return false;
    const role = await workspaceRole(task.workspaceId, actorId);
    return role === "owner" || role === "admin";
  }

  async function validateProjectScope(
    projectId: string | null,
    ownerId: string,
    workspaceId: string | null,
  ): Promise<"PROJECT_NOT_FOUND" | "PROJECT_SCOPE_MISMATCH" | null> {
    if (!projectId) return null;
    const project = await adapter.queryOne<{ userId: string; workspaceId: string | null }>(
      `SELECT "userId" AS "userId", "workspaceId" AS "workspaceId"
         FROM task_projects WHERE id = ?`,
      [projectId],
    );
    if (!project) return "PROJECT_NOT_FOUND";
    if (workspaceId) return project.workspaceId === workspaceId ? null : "PROJECT_SCOPE_MISMATCH";
    return project.userId === ownerId && project.workspaceId === null ? null : "PROJECT_SCOPE_MISMATCH";
  }

  function validateRepeatInput(input: {
    repeatRule: string;
    repeatInterval: number;
    repeatEndCount: number | null;
    repeatRuleJson: unknown;
    dueDate: string | null;
    dueAt: string | null;
  }): { ok: true; repeatRuleJson: string | null } | { ok: false; error: string; code: string } {
    if (!(VALID_TASK_REPEAT_RULES as readonly string[]).includes(input.repeatRule)) {
      return { ok: false, error: "Invalid repeatRule", code: "INVALID_REPEAT_RULE" };
    }
    if (input.repeatRule !== "none" && input.repeatRule !== "custom" && input.repeatInterval < 1) {
      return { ok: false, error: "repeatInterval must be >= 1", code: "INVALID_REPEAT_INTERVAL" };
    }
    if (input.repeatRule !== "none" && !input.dueDate && !input.dueAt) {
      return { ok: false, error: "Repeating task requires dueDate or dueAt", code: "REPEAT_REQUIRES_DATE" };
    }
    if (input.repeatRule !== "custom") return { ok: true, repeatRuleJson: null };
    const customError = validateTaskCustomRepeatRule(input.repeatRuleJson);
    if (customError) return { ok: false, error: customError, code: "INVALID_REPEAT_RULE" };
    return {
      ok: true,
      repeatRuleJson: JSON.stringify(normalizeTaskCustomRepeatRule(input.repeatRuleJson)),
    };
  }

  app.get("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const scopeResult = await resolveCollectionScope(c, userId);
    if (!scopeResult.ok) return scopeResult.response;
    const filterRaw = c.req.query("filter") || "all";
    const filter = (["all", "today", "week", "overdue", "completed"] as string[]).includes(filterRaw)
      ? filterRaw as TaskListFilter
      : "all";
    const projectQuery = c.req.query("projectId");
    const rows = await repository.list({
      scope: scopeResult.scope,
      filter,
      noteId: c.req.query("noteId") || null,
      projectId: projectQuery === undefined ? undefined : projectQuery,
    });
    return c.json(rows);
  });

  app.get("/stats/summary", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const scopeResult = await resolveCollectionScope(c, userId);
    if (!scopeResult.ok) return scopeResult.response;
    return c.json(await repository.stats(scopeResult.scope));
  });

  app.put("/reorder/batch", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const body = await readBody(c);
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0 || rawItems.length > 200) {
      return c.json({ error: "items must contain 1-200 tasks", code: "BAD_REQUEST" }, 400);
    }
    const items = rawItems.map((item, index) => {
      const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        id: String(value.id || ""),
        sortOrder: Number.isFinite(Number(value.sortOrder)) ? Number(value.sortOrder) : index,
      };
    });
    if (items.some((item) => !item.id)) return c.json({ error: "Invalid task id", code: "BAD_REQUEST" }, 400);
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      return c.json({ error: "Duplicate task id", code: "DUPLICATE_TASK" }, 400);
    }
    const rows = await repository.getRowsForReorder(ids);
    if (rows.length !== ids.length) return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
    for (const row of rows) {
      if (!(await canManageTask(row as TaskCoreRow, userId))) {
        return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
      }
    }
    const parentKey = rows[0].parentId ?? "";
    const workspaceKey = rows[0].workspaceId ?? "";
    if (rows.some((row) => (row.parentId ?? "") !== parentKey || (row.workspaceId ?? "") !== workspaceKey)) {
      return c.json({ error: "Tasks must share the same parent", code: "MIXED_PARENT_TASKS" }, 400);
    }
    await repository.reorder(items);
    return c.json({ success: true, affected: items.length });
  });

  app.post("/batch", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const body = await readBody(c);
    const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 100) : [];
    const action = body.action;
    if (ids.length === 0) return c.json({ error: "ids cannot be empty", code: "BAD_REQUEST" }, 400);
    if (action !== "complete" && action !== "delete") {
      return c.json({ error: "action must be complete or delete", code: "BAD_REQUEST" }, 400);
    }

    const found = (await Promise.all(ids.map((id) => repository.getById(id)))).filter(Boolean) as TaskCoreRow[];
    const allowed: TaskCoreRow[] = [];
    for (const task of found) {
      if (await canManageTask(task, userId)) allowed.push(task);
    }
    if (allowed.length === 0) return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);

    if (action === "complete") {
      let affected = 0;
      let generatedCount = 0;
      for (const task of allowed) {
        if (completedValue(task.isCompleted)) continue;
        const completedAt = new Date().toISOString();
        const result = await adapter.execute(
          `UPDATE tasks
              SET "isCompleted" = true, status = 'done', "completedAt" = ?, "updatedAt" = CURRENT_TIMESTAMP
            WHERE id = ? AND "isCompleted" = false`,
          [completedAt, task.id],
        );
        if (result.changes !== 1) continue;
        affected += 1;
        const completedTask = (await repository.getById(task.id)) ?? task;
        if (await recurrence.generateNext(completedTask)) generatedCount += 1;
      }
      return c.json({ success: true, affected, generatedCount });
    }

    const rootIds = [...new Set(allowed.map((task) => task.id))];
    const descendantSets = await Promise.all(rootIds.map((id) => repository.collectDescendantIds(id)));
    const allIds = [...new Set(descendantSets.flat())];
    const dependencyPlaceholders = allIds.map(() => "?").join(", ");
    const rootPlaceholders = rootIds.map(() => "?").join(", ");
    await adapter.executeStatements([
      {
        sql: `DELETE FROM task_dependencies
               WHERE "predecessorTaskId" IN (${dependencyPlaceholders})
                  OR "successorTaskId" IN (${dependencyPlaceholders})`,
        params: [...allIds, ...allIds],
      },
      {
        sql: `DELETE FROM tasks WHERE id IN (${rootPlaceholders})`,
        params: rootIds,
      },
    ]);
    return c.json({ success: true, affected: rootIds.length });
  });

  app.get("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const task = await repository.getById(c.req.param("id"));
    if (!task || !(await canReadTask(task, userId))) return c.json({ error: "Task not found" }, 404);
    const children = await repository.listChildren(task.id);
    return c.json({ ...task, children });
  });

  app.post("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const scopeResult = await resolveCollectionScope(c, userId);
    if (!scopeResult.ok) return scopeResult.response;
    const body = await readBody(c);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return c.json({ error: "Title is required" }, 400);

    const dueDate = asNullableString(body.dueDate);
    const dueAt = asNullableString(body.dueAt);
    const startDate = asNullableString(body.startDate);
    if (isInvalidTaskDateRange(startDate, dueDate, dueAt)) {
      return c.json({ error: "startDate cannot be after dueDate", code: "INVALID_DATE_RANGE" }, 400);
    }

    const repeatRule = typeof body.repeatRule === "string" ? body.repeatRule : "none";
    const repeatInterval = asNumber(body.repeatInterval, 1);
    let repeatEndCount: number | null;
    try {
      repeatEndCount = normalizeRepeatEndCount(body.repeatEndCount);
    } catch {
      return c.json({ error: "repeatEndCount must be an integer between 1 and 999", code: "INVALID_REPEAT_END_COUNT" }, 400);
    }
    if (repeatRule === "none") repeatEndCount = null;
    const repeatValidation = validateRepeatInput({
      repeatRule,
      repeatInterval,
      repeatEndCount,
      repeatRuleJson: body.repeatRuleJson,
      dueDate,
      dueAt,
    });
    if (!repeatValidation.ok) return c.json({ error: repeatValidation.error, code: repeatValidation.code }, 400);

    const status = typeof body.status === "string" ? body.status : "todo";
    if (!(VALID_TASK_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: "Invalid status, must be one of: todo, doing, blocked, done", code: "INVALID_STATUS" }, 400);
    }

    const parentId = asNullableString(body.parentId);
    const workspaceId = scopeResult.scope.workspaceId;
    if (parentId) {
      const parent = await repository.getById(parentId);
      if (!parent) return c.json({ error: "父任务不存在" }, 404);
      if (!(await canReadTask(parent, userId))) {
        return c.json({ error: "无权在该父任务下创建子任务", code: "FORBIDDEN" }, 403);
      }
      if (parent.workspaceId !== workspaceId) {
        return c.json({ error: "子任务必须与父任务在同一工作区", code: "SCOPE_MISMATCH" }, 400);
      }
    }

    const projectId = asNullableString(body.projectId);
    const projectError = await validateProjectScope(projectId, userId, workspaceId);
    if (projectError === "PROJECT_NOT_FOUND") return c.json({ error: "Project not found", code: projectError }, 400);
    if (projectError) return c.json({ error: "Project scope mismatch", code: projectError }, 400);

    const isCompleted = status === "done";
    const id = randomUUID();
    await adapter.execute(
      `INSERT INTO tasks (
         id, "userId", "workspaceId", title, description,
         "isCompleted", "completedAt", priority, "dueDate", "dueAt", "startDate",
         "noteId", "parentId", "projectId", status, "sortOrder",
         "repeatRule", "repeatInterval", "repeatEndDate", "repeatGroupId",
         "repeatGeneratedFromId", "repeatEndCount", "repeatSequenceIndex", "repeatRuleJson"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        userId,
        workspaceId,
        title,
        typeof body.description === "string" ? body.description : "",
        isCompleted,
        isCompleted ? new Date().toISOString() : null,
        asNumber(body.priority, 2),
        dueDate,
        dueAt,
        startDate,
        asNullableString(body.noteId),
        parentId,
        projectId,
        status,
        asNumber(body.sortOrder, 0),
        repeatRule,
        repeatInterval,
        repeatRule === "none" ? null : asNullableString(body.repeatEndDate),
        asNullableString(body.repeatGroupId),
        asNullableString(body.repeatGeneratedFromId),
        repeatEndCount,
        repeatRule === "none" ? null : 1,
        repeatValidation.repeatRuleJson,
      ],
    );
    const task = await repository.getById(id);
    return c.json(task, 201);
  });

  app.put("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const id = c.req.param("id");
    const existing = await repository.getById(id);
    if (!existing) return c.json({ error: "Task not found" }, 404);
    if (!(await canManageTask(existing, userId))) {
      return c.json({ error: "无权修改该任务", code: "FORBIDDEN" }, 403);
    }
    const body = await readBody(c);
    const title = body.title === undefined ? existing.title : String(body.title).trim();
    if (!title) return c.json({ error: "Title is required" }, 400);
    const dueDate = body.dueDate === undefined ? existing.dueDate : asNullableString(body.dueDate);
    const dueAt = body.dueAt === undefined ? dueAtToString(existing.dueAt) : asNullableString(body.dueAt);
    const startDate = body.startDate === undefined ? existing.startDate : asNullableString(body.startDate);
    if (isInvalidTaskDateRange(startDate, dueDate, dueAt)) {
      return c.json({ error: "startDate cannot be after dueDate", code: "INVALID_DATE_RANGE" }, 400);
    }

    const repeatRule = body.repeatRule === undefined ? (existing.repeatRule || "none") : String(body.repeatRule);
    const repeatInterval = body.repeatInterval === undefined ? Number(existing.repeatInterval || 1) : asNumber(body.repeatInterval, 1);
    let repeatEndCount: number | null;
    try {
      repeatEndCount = body.repeatEndCount === undefined
        ? (existing.repeatEndCount == null ? null : Number(existing.repeatEndCount))
        : normalizeRepeatEndCount(body.repeatEndCount);
    } catch {
      return c.json({ error: "repeatEndCount must be an integer between 1 and 999", code: "INVALID_REPEAT_END_COUNT" }, 400);
    }
    if (repeatRule === "none") repeatEndCount = null;
    let repeatRuleInput: unknown = body.repeatRuleJson;
    if (body.repeatRuleJson === undefined && existing.repeatRuleJson) {
      try { repeatRuleInput = JSON.parse(existing.repeatRuleJson); } catch { repeatRuleInput = null; }
    }
    const repeatValidation = validateRepeatInput({
      repeatRule,
      repeatInterval,
      repeatEndCount,
      repeatRuleJson: repeatRuleInput,
      dueDate,
      dueAt,
    });
    if (!repeatValidation.ok) return c.json({ error: repeatValidation.error, code: repeatValidation.code }, 400);

    let status = body.status === undefined ? existing.status : String(body.status);
    let isCompleted = completedValue(existing.isCompleted);
    if (body.status !== undefined) {
      if (!(VALID_TASK_STATUSES as readonly string[]).includes(status)) {
        return c.json({ error: "Invalid status", code: "INVALID_STATUS" }, 400);
      }
      isCompleted = status === "done";
    } else if (body.isCompleted !== undefined) {
      isCompleted = Boolean(body.isCompleted);
      status = isCompleted ? "done" : (existing.status === "done" ? "todo" : existing.status);
    }

    const parentId = body.parentId === undefined ? existing.parentId : asNullableString(body.parentId);
    if (parentId === id) {
      return c.json({ error: "不能将任务设为自己的子任务", code: "INVALID_PARENT_TASK" }, 400);
    }
    if (body.parentId !== undefined && parentId && parentId !== existing.parentId) {
      const descendants = await repository.collectDescendantIds(id);
      if (descendants.includes(parentId)) {
        return c.json({ error: "不能将任务移动到其子孙节点下面", code: "INVALID_PARENT_TASK" }, 400);
      }
      const parent = await repository.getById(parentId);
      if (!parent) return c.json({ error: "父任务不存在" }, 404);
      if (parent.workspaceId !== existing.workspaceId) {
        return c.json({ error: "子任务必须与父任务在同一工作区", code: "SCOPE_MISMATCH" }, 400);
      }
    }

    const projectId = body.projectId === undefined ? existing.projectId : asNullableString(body.projectId);
    if (body.projectId !== undefined && projectId !== existing.projectId) {
      const projectError = await validateProjectScope(projectId, existing.userId, existing.workspaceId);
      if (projectError === "PROJECT_NOT_FOUND") return c.json({ error: "Project not found", code: projectError }, 400);
      if (projectError) return c.json({ error: "Project scope mismatch", code: projectError }, 400);
    }

    const wasCompleted = completedValue(existing.isCompleted);
    const completedAt = isCompleted
      ? (wasCompleted ? (existing.completedAt ?? new Date().toISOString()) : new Date().toISOString())
      : null;
    const repeatSequenceIndex = repeatRule === "none"
      ? null
      : (existing.repeatSequenceIndex == null ? 1 : Number(existing.repeatSequenceIndex));

    await adapter.execute(
      `UPDATE tasks
          SET title = ?, "isCompleted" = ?, priority = ?, "dueDate" = ?, "dueAt" = ?, "startDate" = ?,
              description = ?, "noteId" = ?, "parentId" = ?, "sortOrder" = ?, "projectId" = ?,
              status = ?, "completedAt" = ?, "repeatRule" = ?, "repeatInterval" = ?, "repeatEndDate" = ?,
              "repeatEndCount" = ?, "repeatSequenceIndex" = ?, "repeatRuleJson" = ?, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [
        title,
        isCompleted,
        body.priority === undefined ? existing.priority : asNumber(body.priority, existing.priority),
        dueDate,
        dueAt,
        startDate,
        body.description === undefined ? (existing.description || "") : (typeof body.description === "string" ? body.description : ""),
        body.noteId === undefined ? existing.noteId : asNullableString(body.noteId),
        parentId,
        body.sortOrder === undefined ? existing.sortOrder : asNumber(body.sortOrder, existing.sortOrder),
        projectId,
        status,
        completedAt,
        repeatRule,
        repeatInterval,
        repeatRule === "none" ? null : (body.repeatEndDate === undefined ? existing.repeatEndDate : asNullableString(body.repeatEndDate)),
        repeatEndCount,
        repeatSequenceIndex,
        repeatValidation.repeatRuleJson,
        id,
      ],
    );
    const updated = await repository.getById(id);
    if (!updated) return c.json({ error: "Task not found" }, 404);
    const generatedTask = !wasCompleted && isCompleted ? await recurrence.generateNext(updated) : null;
    return c.json({ task: updated, generatedTask });
  });

  app.patch("/:id/toggle", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const id = c.req.param("id");
    const existing = await repository.getById(id);
    if (!existing) return c.json({ error: "Task not found" }, 404);
    if (!(await canManageTask(existing, userId))) {
      return c.json({ error: "无权修改该任务", code: "FORBIDDEN" }, 403);
    }
    const nextCompleted = !completedValue(existing.isCompleted);
    await adapter.execute(
      `UPDATE tasks
          SET "isCompleted" = ?, status = ?, "completedAt" = ?, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [nextCompleted, nextCompleted ? "done" : "todo", nextCompleted ? new Date().toISOString() : null, id],
    );
    const updated = await repository.getById(id);
    if (!updated) return c.json({ error: "Task not found" }, 404);
    const generatedTask = nextCompleted ? await recurrence.generateNext(updated) : null;
    return c.json({ task: updated, generatedTask });
  });

  app.delete("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const id = c.req.param("id");
    const task = await repository.getById(id);
    if (!task) return c.json({ error: "Task not found" }, 404);
    if (!(await canManageTask(task, userId))) {
      return c.json({ error: "无权删除该任务", code: "FORBIDDEN" }, 403);
    }
    const descendants = await repository.collectDescendantIds(id);
    const placeholders = descendants.map(() => "?").join(", ");
    await adapter.executeStatements([
      {
        sql: `DELETE FROM task_dependencies
               WHERE "predecessorTaskId" IN (${placeholders})
                  OR "successorTaskId" IN (${placeholders})`,
        params: [...descendants, ...descendants],
      },
      {
        sql: `DELETE FROM tasks WHERE id = ?`,
        params: [id],
        requireChanges: 1,
      },
    ]);
    return c.json({ success: true });
  });

  return app;
}

function dueAtToString(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export default createTasksRuntimeRouter;
