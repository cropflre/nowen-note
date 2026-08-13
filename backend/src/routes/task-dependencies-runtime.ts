import { randomUUID } from "node:crypto";
import { Hono } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import { createTaskModuleAccessRuntime } from "../services/task-module-access-runtime";

interface TaskScopeRow {
  id: string;
  userId: string;
  workspaceId: string | null;
}

interface TaskDependencyRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  predecessorTaskId: string;
  successorTaskId: string;
  type: string;
  createdAt: string | Date;
  updatedAt?: string | Date | null;
}

export function createTaskDependenciesRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();
  const access = createTaskModuleAccessRuntime(adapter);

  async function taskScope(id: string): Promise<TaskScopeRow | undefined> {
    return adapter.queryOne<TaskScopeRow>(
      `SELECT id, "userId" AS "userId", "workspaceId" AS "workspaceId" FROM tasks WHERE id = ?`,
      [id],
    );
  }

  async function createsCycle(predecessorTaskId: string, successorTaskId: string): Promise<boolean> {
    const row = await adapter.queryOne<{ found: number }>(
      `WITH RECURSIVE reachable(id) AS (
         SELECT ?::text
         UNION
         SELECT d."successorTaskId"
           FROM task_dependencies d
           JOIN reachable r ON d."predecessorTaskId" = r.id
       )
       SELECT 1 AS found FROM reachable WHERE id = ? LIMIT 1`,
      [successorTaskId, predecessorTaskId],
    );
    return !!row;
  }

  app.get("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const scopeResult = await access.resolveScope(c.req.query("workspaceId"), userId);
    if (!scopeResult.ok) return c.json({ error: scopeResult.error, code: scopeResult.code }, scopeResult.status);
    const taskId = c.req.query("taskId");
    const workspaceId = scopeResult.scope.workspaceId;
    let rows: TaskDependencyRow[];
    if (taskId) {
      const task = await taskScope(taskId);
      if (!task || !(await access.canRead(task, userId))) return c.json({ error: "Task not found" }, 404);
      if ((task.workspaceId ?? null) !== workspaceId) {
        return c.json({ error: "Task scope mismatch", code: "SCOPE_MISMATCH" }, 400);
      }
      rows = workspaceId
        ? await adapter.queryMany<TaskDependencyRow>(
            `SELECT * FROM task_dependencies
              WHERE ("predecessorTaskId" = ? OR "successorTaskId" = ?) AND "workspaceId" = ?
              ORDER BY "createdAt" ASC`,
            [taskId, taskId, workspaceId],
          )
        : await adapter.queryMany<TaskDependencyRow>(
            `SELECT * FROM task_dependencies
              WHERE ("predecessorTaskId" = ? OR "successorTaskId" = ?)
                AND "userId" = ? AND "workspaceId" IS NULL
              ORDER BY "createdAt" ASC`,
            [taskId, taskId, userId],
          );
    } else {
      rows = workspaceId
        ? await adapter.queryMany<TaskDependencyRow>(
            `SELECT * FROM task_dependencies WHERE "workspaceId" = ? ORDER BY "createdAt" ASC`,
            [workspaceId],
          )
        : await adapter.queryMany<TaskDependencyRow>(
            `SELECT * FROM task_dependencies
              WHERE "userId" = ? AND "workspaceId" IS NULL
              ORDER BY "createdAt" ASC`,
            [userId],
          );
    }
    return c.json(rows);
  });

  app.post("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const predecessorTaskId = typeof body.predecessorTaskId === "string" ? body.predecessorTaskId : "";
    const successorTaskId = typeof body.successorTaskId === "string" ? body.successorTaskId : "";
    const type = body.type === undefined ? "finish_to_start" : String(body.type);
    if (!predecessorTaskId || !successorTaskId) {
      return c.json({ error: "predecessorTaskId and successorTaskId are required", code: "BAD_REQUEST" }, 400);
    }
    if (predecessorTaskId === successorTaskId) {
      return c.json({ error: "Cannot depend on self", code: "SELF_DEPENDENCY" }, 400);
    }
    if (type !== "finish_to_start") {
      return c.json({ error: "Only finish_to_start is supported in V1", code: "INVALID_DEPENDENCY_TYPE" }, 400);
    }

    const [predecessor, successor] = await Promise.all([taskScope(predecessorTaskId), taskScope(successorTaskId)]);
    if (!predecessor || !successor) return c.json({ error: "Task not found" }, 404);
    if ((predecessor.workspaceId ?? null) !== (successor.workspaceId ?? null)) {
      return c.json({ error: "Tasks must be in the same scope", code: "SCOPE_MISMATCH" }, 400);
    }

    const workspaceId = predecessor.workspaceId;
    if (workspaceId) {
      if (!(await access.canEditWorkspace(workspaceId, userId))) {
        return c.json({ error: "Insufficient permissions", code: "FORBIDDEN" }, 403);
      }
    } else if (predecessor.userId !== userId || successor.userId !== userId) {
      return c.json({ error: "No permission", code: "FORBIDDEN" }, 403);
    }

    const existing = await adapter.queryOne<{ id: string }>(
      `SELECT id FROM task_dependencies
        WHERE "predecessorTaskId" = ? AND "successorTaskId" = ? AND type = ?`,
      [predecessorTaskId, successorTaskId, type],
    );
    if (existing) return c.json({ error: "Dependency already exists", code: "DEPENDENCY_EXISTS" }, 409);
    if (await createsCycle(predecessorTaskId, successorTaskId)) {
      return c.json({ error: "Circular dependency is not allowed", code: "DEPENDENCY_CYCLE" }, 400);
    }

    const id = randomUUID();
    try {
      await adapter.execute(
        `INSERT INTO task_dependencies (
           id, "userId", "workspaceId", "predecessorTaskId", "successorTaskId", type
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, userId, workspaceId, predecessorTaskId, successorTaskId, type],
      );
    } catch (error) {
      const duplicate = await adapter.queryOne<{ id: string }>(
        `SELECT id FROM task_dependencies
          WHERE "predecessorTaskId" = ? AND "successorTaskId" = ? AND type = ?`,
        [predecessorTaskId, successorTaskId, type],
      );
      if (duplicate) return c.json({ error: "Dependency already exists", code: "DEPENDENCY_EXISTS" }, 409);
      throw error;
    }
    return c.json(await adapter.queryOne<TaskDependencyRow>(`SELECT * FROM task_dependencies WHERE id = ?`, [id]), 201);
  });

  app.delete("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const id = c.req.param("id");
    const dependency = await adapter.queryOne<TaskDependencyRow>(`SELECT * FROM task_dependencies WHERE id = ?`, [id]);
    if (!dependency) return c.json({ error: "Dependency not found" }, 404);
    if (dependency.workspaceId) {
      if (!(await access.canEditWorkspace(dependency.workspaceId, userId))) {
        return c.json({ error: "Insufficient permissions", code: "FORBIDDEN" }, 403);
      }
    } else if (dependency.userId !== userId) {
      return c.json({ error: "No permission", code: "FORBIDDEN" }, 403);
    }
    await adapter.execute(`DELETE FROM task_dependencies WHERE id = ?`, [id]);
    return c.json({ success: true });
  });

  return app;
}

export default createTaskDependenciesRuntimeRouter;
