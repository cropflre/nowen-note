import { Hono } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import { createTagsRepository } from "../repositories/tagsRepository";

function normalizeWorkspaceId(raw: string | undefined): string | null {
  if (!raw || raw === "personal") return null;
  return raw;
}

export function createTagsRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();
  const tagsRepository = createTagsRepository(adapter);

  app.get("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const workspaceId = normalizeWorkspaceId(c.req.query("workspaceId"));
    const includeEmpty = c.req.query("includeEmpty") === "true";

    if (workspaceId) {
      const membership = await adapter.queryOne<{ role: string }>(
        `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
        [workspaceId, userId],
      );
      if (!membership) return c.json({ error: "无权访问该工作区" }, 403);
    }

    const rows = await tagsRepository.listByUserAsync(userId, workspaceId, includeEmpty);
    return c.json(rows.map((row) => ({ ...row, noteCount: Number(row.noteCount ?? 0) })));
  });

  return app;
}

export default createTagsRuntimeRouter;
