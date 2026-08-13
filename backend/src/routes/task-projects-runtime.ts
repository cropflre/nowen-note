import { randomUUID } from "node:crypto";
import { Hono } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import { createTaskModuleAccessRuntime } from "../services/task-module-access-runtime";

interface TaskProjectRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface TaskProjectWithStats extends TaskProjectRow {
  taskCount: number | string;
  completedCount: number | string;
  progress: number | string;
}

function normalizeProject<T extends TaskProjectRow>(row: T): T {
  return row;
}

function normalizeProjectStats(row: TaskProjectWithStats) {
  return {
    ...row,
    taskCount: Number(row.taskCount ?? 0),
    completedCount: Number(row.completedCount ?? 0),
    progress: Number(row.progress ?? 0),
  };
}

const projectStatsSql = `
  SELECT p.*,
         (SELECT COUNT(*) FROM tasks t WHERE t."projectId" = p.id) AS "taskCount",
         (SELECT COUNT(*) FROM tasks t WHERE t."projectId" = p.id AND t."isCompleted" = true) AS "completedCount",
         CASE
           WHEN (SELECT COUNT(*) FROM tasks t WHERE t."projectId" = p.id) = 0 THEN 0
           ELSE ROUND(
             100.0 * (SELECT COUNT(*) FROM tasks t WHERE t."projectId" = p.id AND t."isCompleted" = true)
             / (SELECT COUNT(*) FROM tasks t WHERE t."projectId" = p.id)
           )
         END AS progress
    FROM task_projects p`;

export function createTaskProjectsRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();
  const access = createTaskModuleAccessRuntime(adapter);

  app.get("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const scopeResult = await access.resolveScope(c.req.query("workspaceId"), userId);
    if (!scopeResult.ok) {
      return c.json({ error: scopeResult.error, code: scopeResult.code, feature: scopeResult.code === "FEATURE_DISABLED" ? "tasks" : undefined }, scopeResult.status);
    }
    const rows = scopeResult.scope.workspaceId
      ? await adapter.queryMany<TaskProjectWithStats>(
          `${projectStatsSql} WHERE p."workspaceId" = ? ORDER BY p."sortOrder" ASC, p."createdAt" ASC`,
          [scopeResult.scope.workspaceId],
        )
      : await adapter.queryMany<TaskProjectWithStats>(
          `${projectStatsSql} WHERE p."userId" = ? AND p."workspaceId" IS NULL ORDER BY p."sortOrder" ASC, p."createdAt" ASC`,
          [userId],
        );
    return c.json(rows.map(normalizeProjectStats));
  });

  app.post("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const scopeResult = await access.resolveScope(c.req.query("workspaceId"), userId);
    if (!scopeResult.ok) return c.json({ error: scopeResult.error, code: scopeResult.code }, scopeResult.status);
    if (scopeResult.scope.workspaceId && scopeResult.scope.role && !["owner", "admin", "editor"].includes(scopeResult.scope.role)) {
      return c.json({ error: "Insufficient permissions to create project", code: "FORBIDDEN" }, 403);
    }

    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : "Untitled";
    const icon = typeof body.icon === "string" ? body.icon.slice(0, 100) : "folder";
    const color = typeof body.color === "string" ? body.color.slice(0, 64) : "#6366f1";
    const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0;
    const id = randomUUID();
    await adapter.execute(
      `INSERT INTO task_projects (id, "userId", "workspaceId", name, icon, color, "sortOrder")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, scopeResult.scope.workspaceId, name, icon, color, sortOrder],
    );
    const created = await adapter.queryOne<TaskProjectWithStats>(`${projectStatsSql} WHERE p.id = ?`, [id]);
    return c.json(created ? normalizeProjectStats(created) : null, 201);
  });

  app.put("/reorder/batch", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const rawItems = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
    if (rawItems.length === 0) return c.json({ error: "items required", code: "BAD_REQUEST" }, 400);
    const items = rawItems.map((raw, index) => {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return {
        id: typeof item.id === "string" ? item.id : "",
        sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : index,
      };
    });
    if (items.some((item) => !item.id) || new Set(items.map((item) => item.id)).size !== items.length) {
      return c.json({ error: "Invalid project items", code: "BAD_REQUEST" }, 400);
    }

    const projects = await Promise.all(items.map((item) => adapter.queryOne<TaskProjectRow>(`SELECT * FROM task_projects WHERE id = ?`, [item.id])));
    if (projects.some((project) => !project)) return c.json({ error: "Project not found", code: "NOT_FOUND" }, 404);
    const existing = projects as TaskProjectRow[];
    const workspaceKey = existing[0].workspaceId ?? "";
    if (existing.some((project) => (project.workspaceId ?? "") !== workspaceKey)) {
      return c.json({ error: "Projects must share the same scope", code: "SCOPE_MISMATCH" }, 400);
    }
    for (const project of existing) {
      if (!(await access.canManageOwnedResource(project, userId))) {
        return c.json({ error: "No permission to reorder project", code: "FORBIDDEN" }, 403);
      }
    }
    await adapter.executeBatch(
      `UPDATE task_projects SET "sortOrder" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ?`,
      items.map((item) => [item.sortOrder, item.id]),
    );
    return c.json({ success: true, affected: items.length });
  });

  app.put("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const id = c.req.param("id");
    const existing = await adapter.queryOne<TaskProjectRow>(`SELECT * FROM task_projects WHERE id = ?`, [id]);
    if (!existing) return c.json({ error: "Project not found" }, 404);
    if (!(await access.canManageOwnedResource(existing, userId))) {
      return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const name = body.name === undefined ? existing.name : String(body.name).trim().slice(0, 200);
    if (!name) return c.json({ error: "Project name is required", code: "BAD_REQUEST" }, 400);
    const icon = body.icon === undefined ? existing.icon : (body.icon === null ? null : String(body.icon).slice(0, 100));
    const color = body.color === undefined ? existing.color : (body.color === null ? null : String(body.color).slice(0, 64));
    const sortOrder = body.sortOrder === undefined || !Number.isFinite(Number(body.sortOrder)) ? existing.sortOrder : Number(body.sortOrder);
    await adapter.execute(
      `UPDATE task_projects
          SET name = ?, icon = ?, color = ?, "sortOrder" = ?, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [name, icon, color, sortOrder, id],
    );
    const updated = await adapter.queryOne<TaskProjectWithStats>(`${projectStatsSql} WHERE p.id = ?`, [id]);
    return c.json(updated ? normalizeProjectStats(updated) : null);
  });

  app.delete("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const id = c.req.param("id");
    const existing = await adapter.queryOne<TaskProjectRow>(`SELECT * FROM task_projects WHERE id = ?`, [id]);
    if (!existing) return c.json({ error: "Project not found" }, 404);
    if (!(await access.canManageOwnedResource(existing, userId))) {
      return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
    }
    await adapter.executeStatements([
      { sql: `UPDATE tasks SET "projectId" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "projectId" = ?`, params: [id] },
      { sql: `DELETE FROM task_projects WHERE id = ?`, params: [id], requireChanges: 1 },
    ]);
    return c.json({ success: true });
  });

  return app;
}

export default createTaskProjectsRuntimeRouter;
