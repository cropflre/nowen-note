import { Hono, type Context } from "hono";
import { v4 as uuid } from "uuid";

import type { DatabaseAdapter } from "../db/adapters/types";
import {
  normalizeWorkspaceIcon,
  workspaceIconForRead,
} from "../lib/workspace-icon";

type WorkspaceRole = "owner" | "admin" | "editor" | "commenter" | "viewer";

const ROLE_LEVEL: Record<WorkspaceRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  admin: 4,
  owner: 5,
};

export interface WorkspacesRuntimeOptions {
  publishToUser?: (userId: string, event: Record<string, unknown>) => void | Promise<void>;
}

function hasRole(role: string | null | undefined, minimum: WorkspaceRole): boolean {
  if (!role || !(role in ROLE_LEVEL)) return false;
  return ROLE_LEVEL[role as WorkspaceRole] >= ROLE_LEVEL[minimum];
}

function normalizeWorkspaceRow<T extends Record<string, any>>(row: T): T & {
  memberCount: number;
  notebookCount: number;
} {
  return {
    ...row,
    icon: workspaceIconForRead(row.icon),
    memberCount: Number(row.memberCount ?? 0),
    notebookCount: Number(row.notebookCount ?? 0),
  };
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
}

export function createWorkspacesRuntimeRouter(
  adapter: DatabaseAdapter,
  options: WorkspacesRuntimeOptions = {},
) {
  const app = new Hono();

  async function isSystemAdmin(userId: string): Promise<boolean> {
    const row = await adapter.queryOne<{ role: string }>(
      `SELECT role FROM users WHERE id = ?`,
      [userId],
    );
    return row?.role === "admin";
  }

  async function membershipRole(workspaceId: string, userId: string): Promise<string | null> {
    const row = await adapter.queryOne<{ role: string }>(
      `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
      [workspaceId, userId],
    );
    return row?.role ?? null;
  }

  async function effectiveRole(workspaceId: string, userId: string): Promise<string | null> {
    if (await isSystemAdmin(userId)) return "owner";
    return membershipRole(workspaceId, userId);
  }

  async function loadWorkspace(workspaceId: string, role?: string | null) {
    const row = await adapter.queryOne<Record<string, any>>(
      `SELECT w.id,
              w.name,
              w.description,
              w.icon,
              w."ownerId" AS "ownerId",
              w."createdAt" AS "createdAt",
              w."updatedAt" AS "updatedAt",
              w."enabledFeatures" AS "enabledFeatures",
              (SELECT COUNT(*) FROM workspace_members wm WHERE wm."workspaceId" = w.id) AS "memberCount",
              (SELECT COUNT(*) FROM notebooks nb WHERE nb."workspaceId" = w.id) AS "notebookCount"
         FROM workspaces w
        WHERE w.id = ?`,
      [workspaceId],
    );
    return row ? normalizeWorkspaceRow({ ...row, ...(role ? { role } : {}) }) : undefined;
  }

  async function broadcastWorkspaceUpdated(workspaceId: string, workspace: Record<string, unknown>) {
    if (!options.publishToUser) return;
    const members = await adapter.queryMany<{ userId: string }>(
      `SELECT "userId" AS "userId" FROM workspace_members WHERE "workspaceId" = ?`,
      [workspaceId],
    );
    await Promise.all(members.map((member) => Promise.resolve(options.publishToUser?.(
      member.userId,
      { type: "workspace:updated", workspaceId, workspace },
    ))));
  }

  app.get("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const rows = await adapter.queryMany<Record<string, any>>(
      `SELECT w.id,
              w.name,
              w.description,
              w.icon,
              w."ownerId" AS "ownerId",
              w."createdAt" AS "createdAt",
              w."updatedAt" AS "updatedAt",
              w."enabledFeatures" AS "enabledFeatures",
              m.role,
              (SELECT COUNT(*) FROM workspace_members wm WHERE wm."workspaceId" = w.id) AS "memberCount",
              (SELECT COUNT(*) FROM notebooks nb WHERE nb."workspaceId" = w.id) AS "notebookCount"
         FROM workspaces w
         JOIN workspace_members m ON m."workspaceId" = w.id
        WHERE m."userId" = ?
        ORDER BY w."createdAt" ASC`,
      [userId],
    );

    return c.json(rows.map(normalizeWorkspaceRow));
  });

  app.post("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const body = await readJsonBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "工作区名称不能为空" }, 400);

    const normalizedIcon = normalizeWorkspaceIcon(body.icon);
    if (!normalizedIcon.ok) {
      return c.json({ error: normalizedIcon.error, code: "INVALID_WORKSPACE_ICON" }, 400);
    }

    const id = uuid();
    await adapter.executeStatements([
      {
        sql: `INSERT INTO workspaces (id, name, description, icon, "ownerId")
              VALUES (?, ?, ?, ?, ?)`,
        params: [
          id,
          name,
          typeof body.description === "string" ? body.description : "",
          normalizedIcon.icon,
          userId,
        ],
        requireChanges: 1,
      },
      {
        sql: `INSERT INTO workspace_members ("workspaceId", "userId", role)
              VALUES (?, ?, 'owner')`,
        params: [id, userId],
        requireChanges: 1,
      },
    ]);

    const workspace = await loadWorkspace(id, "owner");
    if (!workspace) return c.json({ error: "工作区创建后未能读取记录" }, 500);
    return c.json(workspace, 201);
  });

  app.get("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const id = c.req.param("id");
    const role = await effectiveRole(id, userId);
    if (!role) return c.json({ error: "无权访问该工作区" }, 403);

    const workspace = await loadWorkspace(id, role);
    if (!workspace) return c.json({ error: "工作区不存在" }, 404);
    return c.json(workspace);
  });

  app.put("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const id = c.req.param("id");
    const role = await effectiveRole(id, userId);
    if (!hasRole(role, "admin")) return c.json({ error: "权限不足" }, 403);

    const body = await readJsonBody(c);
    const fields: string[] = [];
    const params: unknown[] = [];

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return c.json({ error: "工作区名称不能为空" }, 400);
      }
      fields.push("name = ?");
      params.push(body.name.trim());
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string") {
        return c.json({ error: "工作区描述格式无效" }, 400);
      }
      fields.push("description = ?");
      params.push(body.description);
    }
    if (body.icon !== undefined) {
      const normalizedIcon = normalizeWorkspaceIcon(body.icon);
      if (!normalizedIcon.ok) {
        return c.json({ error: normalizedIcon.error, code: "INVALID_WORKSPACE_ICON" }, 400);
      }
      fields.push("icon = ?");
      params.push(normalizedIcon.icon);
    }
    if (fields.length === 0) return c.json({ error: "无可更新字段" }, 400);

    fields.push('"updatedAt" = CURRENT_TIMESTAMP');
    params.push(id);
    const result = await adapter.execute(
      `UPDATE workspaces SET ${fields.join(", ")} WHERE id = ?`,
      params,
    );
    if (result.changes !== 1) return c.json({ error: "工作区不存在" }, 404);

    const workspace = await loadWorkspace(id, role);
    if (!workspace) return c.json({ error: "工作区不存在" }, 404);
    await broadcastWorkspaceUpdated(id, workspace);
    return c.json(workspace);
  });

  return app;
}

export default createWorkspacesRuntimeRouter;
