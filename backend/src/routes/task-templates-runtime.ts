import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import { createTaskModuleAccessRuntime } from "../services/task-module-access-runtime";

type JsonBody = Record<string, unknown>;

interface TaskTemplateRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  items: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface TemplateScopeRow {
  userId: string;
  workspaceId: string | null;
}

interface NormalizedTemplateItem {
  title: string;
  description: string;
  priority: number;
  relativeDueDays: number | null;
  parentIndex: number | null;
  sortOrder: number;
}

interface TemplateTaskInsert {
  id: string;
  title: string;
  description: string;
  priority: number;
  dueDate: string | null;
  projectId: string | null;
  parentId: string | null;
  sortOrder: number;
}

async function readBody(c: Context): Promise<JsonBody> {
  return c.req.json<JsonBody>().catch((): JsonBody => ({}));
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : String(value);
}

function normalizeTemplateItems(value: unknown): NormalizedTemplateItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const title = typeof item.title === "string" ? item.title.trim().slice(0, 200) : "";
    const priority = typeof item.priority === "number" && [1, 2, 3].includes(item.priority)
      ? item.priority
      : 2;
    const relativeDueDays = typeof item.relativeDueDays === "number" && Number.isFinite(item.relativeDueDays)
      ? item.relativeDueDays
      : null;
    const parentIndex = typeof item.parentIndex === "number" && Number.isInteger(item.parentIndex) && item.parentIndex >= 0
      ? item.parentIndex
      : null;
    const sortOrder = typeof item.sortOrder === "number" && Number.isFinite(item.sortOrder)
      ? item.sortOrder
      : index;
    return {
      title,
      description: typeof item.description === "string" ? item.description : "",
      priority,
      relativeDueDays,
      parentIndex,
      sortOrder,
    };
  }).filter((item) => item.title.length > 0);
}

function parseStoredItems(raw: string): NormalizedTemplateItem[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed as NormalizedTemplateItem[] : [];
  } catch {
    return [];
  }
}

function serializeTemplate(row: TaskTemplateRow) {
  return {
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    items: parseStoredItems(row.items),
  };
}

function parseCalendarDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function addCalendarDays(base: { year: number; month: number; day: number }, relativeDays: number): string {
  const date = new Date(Date.UTC(base.year, base.month - 1, base.day));
  date.setUTCDate(date.getUTCDate() + Math.trunc(relativeDays));
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function createTaskTemplatesRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();
  const access = createTaskModuleAccessRuntime(adapter);

  async function loadTemplate(id: string): Promise<TaskTemplateRow | undefined> {
    return adapter.queryOne<TaskTemplateRow>(`SELECT * FROM task_templates WHERE id = ?`, [id]);
  }

  async function canReadTemplate(row: TaskTemplateRow, actorId: string): Promise<{ ok: true } | { ok: false; status: 403; code: "FORBIDDEN" | "FEATURE_DISABLED" }> {
    if (!row.workspaceId) {
      return row.userId === actorId
        ? { ok: true }
        : { ok: false, status: 403, code: "FORBIDDEN" };
    }
    const workspaceAccess = await access.workspaceAccess(row.workspaceId, actorId);
    if (!workspaceAccess) return { ok: false, status: 403, code: "FORBIDDEN" };
    if (!workspaceAccess.tasksEnabled) return { ok: false, status: 403, code: "FEATURE_DISABLED" };
    return { ok: true };
  }

  function sameScope(resource: TemplateScopeRow, template: TaskTemplateRow, actorId: string): boolean {
    if (template.workspaceId) return resource.workspaceId === template.workspaceId;
    return resource.workspaceId === null && resource.userId === actorId;
  }

  app.get("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const scopeResult = await access.resolveScope(c.req.query("workspaceId"), userId);
    if (!scopeResult.ok) {
      return c.json({ error: scopeResult.error, code: scopeResult.code, feature: scopeResult.code === "FEATURE_DISABLED" ? "tasks" : undefined }, scopeResult.status);
    }
    const rows = scopeResult.scope.workspaceId
      ? await adapter.queryMany<TaskTemplateRow>(
          `SELECT * FROM task_templates WHERE "workspaceId" = ? ORDER BY "createdAt" DESC`,
          [scopeResult.scope.workspaceId],
        )
      : await adapter.queryMany<TaskTemplateRow>(
          `SELECT * FROM task_templates WHERE "userId" = ? AND "workspaceId" IS NULL ORDER BY "createdAt" DESC`,
          [userId],
        );
    return c.json(rows.map(serializeTemplate));
  });

  app.post("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const scopeResult = await access.resolveScope(c.req.query("workspaceId"), userId);
    if (!scopeResult.ok) return c.json({ error: scopeResult.error, code: scopeResult.code }, scopeResult.status);
    const body = await readBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "Name is required", code: "INVALID_NAME" }, 400);

    const id = randomUUID();
    const items = normalizeTemplateItems(body.items);
    await adapter.execute(
      `INSERT INTO task_templates (
         id, "userId", "workspaceId", name, description, icon, color, items, "createdAt", "updatedAt"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        id,
        userId,
        scopeResult.scope.workspaceId,
        name,
        typeof body.description === "string" && body.description ? body.description : null,
        typeof body.icon === "string" && body.icon ? body.icon : null,
        typeof body.color === "string" && body.color ? body.color : null,
        JSON.stringify(items),
      ],
    );
    const created = await loadTemplate(id);
    return c.json(created ? serializeTemplate(created) : null, 201);
  });

  app.put("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const id = c.req.param("id");
    const existing = await loadTemplate(id);
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (!(await access.canManageOwnedResource(existing, userId))) {
      return c.json({ error: "Not allowed", code: "FORBIDDEN" }, 403);
    }

    const body = await readBody(c);
    const updates: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return c.json({ error: "Name is required", code: "INVALID_NAME" }, 400);
      updates.push("name = ?");
      params.push(name);
    }
    if (body.description !== undefined) {
      updates.push("description = ?");
      params.push(typeof body.description === "string" && body.description ? body.description : null);
    }
    if (body.icon !== undefined) {
      updates.push("icon = ?");
      params.push(typeof body.icon === "string" && body.icon ? body.icon : null);
    }
    if (body.color !== undefined) {
      updates.push("color = ?");
      params.push(typeof body.color === "string" && body.color ? body.color : null);
    }
    if (body.items !== undefined) {
      updates.push("items = ?");
      params.push(JSON.stringify(normalizeTemplateItems(body.items)));
    }
    if (updates.length === 0) return c.json(serializeTemplate(existing));

    updates.push('"updatedAt" = CURRENT_TIMESTAMP');
    params.push(id);
    await adapter.execute(`UPDATE task_templates SET ${updates.join(", ")} WHERE id = ?`, params);
    const updated = await loadTemplate(id);
    return c.json(updated ? serializeTemplate(updated) : null);
  });

  app.delete("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const id = c.req.param("id");
    const existing = await loadTemplate(id);
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (!(await access.canManageOwnedResource(existing, userId))) {
      return c.json({ error: "Not allowed", code: "FORBIDDEN" }, 403);
    }
    await adapter.execute(`DELETE FROM task_templates WHERE id = ?`, [id]);
    return c.json({ success: true });
  });

  app.post("/:id/apply", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const template = await loadTemplate(c.req.param("id"));
    if (!template) return c.json({ error: "Not found" }, 404);
    const readable = await canReadTemplate(template, userId);
    if (!readable.ok) {
      return c.json({
        error: readable.code === "FEATURE_DISABLED" ? "该功能在当前工作区已被管理员关闭" : "No access",
        code: readable.code,
        feature: readable.code === "FEATURE_DISABLED" ? "tasks" : undefined,
      }, readable.status);
    }

    const body = await readBody(c);
    const projectId = optionalString(body.projectId);
    const parentId = optionalString(body.parentId);
    const baseDateValue = optionalString(body.baseDate);
    const baseDate = baseDateValue ? parseCalendarDate(baseDateValue) : null;
    if (baseDateValue && !baseDate) {
      return c.json({ error: "baseDate must be YYYY-MM-DD", code: "INVALID_BASE_DATE" }, 400);
    }

    if (projectId) {
      const project = await adapter.queryOne<TemplateScopeRow>(
        `SELECT "userId" AS "userId", "workspaceId" AS "workspaceId" FROM task_projects WHERE id = ?`,
        [projectId],
      );
      if (!project) return c.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, 404);
      if (!sameScope(project, template, userId)) {
        return c.json({ error: "Project belongs to different scope", code: "SCOPE_MISMATCH" }, 403);
      }
    }

    if (parentId) {
      const parentTask = await adapter.queryOne<TemplateScopeRow>(
        `SELECT "userId" AS "userId", "workspaceId" AS "workspaceId" FROM tasks WHERE id = ?`,
        [parentId],
      );
      if (!parentTask) return c.json({ error: "Parent task not found", code: "PARENT_TASK_NOT_FOUND" }, 404);
      if (!sameScope(parentTask, template, userId)) {
        return c.json({ error: "Parent task belongs to different scope", code: "SCOPE_MISMATCH" }, 403);
      }
    }

    const items = parseStoredItems(template.items);
    if (items.length === 0) return c.json({ createdTasks: [], count: 0 });

    const createdIds: string[] = [];
    const inserts: TemplateTaskInsert[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item || typeof item.title !== "string" || !item.title.trim()) continue;
      const id = randomUUID();
      const relativeDueDays = typeof item.relativeDueDays === "number" && Number.isFinite(item.relativeDueDays)
        ? item.relativeDueDays
        : null;
      const dueDate = baseDate && relativeDueDays !== null ? addCalendarDays(baseDate, relativeDueDays) : null;
      const itemParentIndex = typeof item.parentIndex === "number" && Number.isInteger(item.parentIndex)
        ? item.parentIndex
        : null;
      const resolvedParentId = itemParentIndex !== null && itemParentIndex >= 0 && itemParentIndex < createdIds.length
        ? createdIds[itemParentIndex]
        : parentId;
      inserts.push({
        id,
        title: item.title.trim(),
        description: typeof item.description === "string" ? item.description : "",
        priority: typeof item.priority === "number" && [1, 2, 3].includes(item.priority) ? item.priority : 2,
        dueDate,
        projectId,
        parentId: resolvedParentId,
        sortOrder: typeof item.sortOrder === "number" && Number.isFinite(item.sortOrder) ? item.sortOrder : index,
      });
      createdIds.push(id);
    }

    await adapter.executeBatch(
      `INSERT INTO tasks (
         id, "userId", "workspaceId", title, description, priority,
         "isCompleted", "completedAt", status, "sortOrder", "projectId", "parentId", "dueDate",
         "createdAt", "updatedAt"
       ) VALUES (?, ?, ?, ?, ?, ?, false, NULL, 'todo', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      inserts.map((task) => [
        task.id,
        userId,
        template.workspaceId,
        task.title,
        task.description,
        task.priority,
        task.sortOrder,
        task.projectId,
        task.parentId,
        task.dueDate,
      ]),
    );

    return c.json({
      createdTasks: inserts.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        dueDate: task.dueDate,
        projectId: task.projectId,
        parentId: task.parentId,
        status: "todo" as const,
        isCompleted: 0 as const,
      })),
      count: inserts.length,
    });
  });

  return app;
}

export default createTaskTemplatesRuntimeRouter;
