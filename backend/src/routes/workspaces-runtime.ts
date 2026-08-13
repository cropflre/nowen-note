import { Hono } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import { workspaceIconForRead } from "../lib/workspace-icon";

export function createWorkspacesRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();

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

    return c.json(rows.map((row) => ({
      ...row,
      icon: workspaceIconForRead(row.icon),
      memberCount: Number(row.memberCount ?? 0),
      notebookCount: Number(row.notebookCount ?? 0),
    })));
  });

  return app;
}

export default createWorkspacesRuntimeRouter;
