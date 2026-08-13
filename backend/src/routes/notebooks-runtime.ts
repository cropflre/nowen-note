import { Hono } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";

function normalizeWorkspaceId(raw: string | undefined): string | null {
  if (!raw || raw === "personal") return null;
  return raw;
}

function normalizeNotebookRow(row: Record<string, any>) {
  return {
    ...row,
    noteCount: Number(row.noteCount ?? 0),
  };
}

export function createNotebooksRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();

  app.get("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const workspaceId = normalizeWorkspaceId(c.req.query("workspaceId"));

    if (workspaceId) {
      const membership = await adapter.queryOne<{ role: string }>(
        `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
        [workspaceId, userId],
      );
      if (!membership) return c.json({ error: "无权访问该工作区" }, 403);

      const rows = await adapter.queryMany<Record<string, any>>(
        `WITH RECURSIVE nb_tree("ancestorId", "descendantId") AS (
           SELECT id, id
             FROM notebooks
            WHERE "workspaceId" = ? AND "isDeleted" = false
           UNION ALL
           SELECT tree."ancestorId", child.id
             FROM nb_tree tree
             JOIN notebooks child ON child."parentId" = tree."descendantId"
            WHERE child."workspaceId" = ? AND child."isDeleted" = false
         ),
         note_counts("notebookId", "noteCount") AS (
           SELECT tree."ancestorId", COUNT(note.id)
             FROM nb_tree tree
             JOIN notes note ON note."notebookId" = tree."descendantId"
            WHERE note."isTrashed" = false AND note."workspaceId" = ?
            GROUP BY tree."ancestorId"
         )
         SELECT nb.*, COALESCE(counts."noteCount", 0) AS "noteCount"
           FROM notebooks nb
           LEFT JOIN note_counts counts ON counts."notebookId" = nb.id
          WHERE nb."workspaceId" = ? AND nb."isDeleted" = false
          ORDER BY nb."sortOrder" ASC, nb."createdAt" ASC, nb.id ASC`,
        [workspaceId, workspaceId, workspaceId, workspaceId],
      );
      return c.json(rows.map(normalizeNotebookRow));
    }

    const rows = await adapter.queryMany<Record<string, any>>(
      `WITH RECURSIVE nb_tree("ancestorId", "descendantId") AS (
         SELECT id, id
           FROM notebooks
          WHERE "userId" = ? AND "workspaceId" IS NULL AND "isDeleted" = false
         UNION ALL
         SELECT tree."ancestorId", child.id
           FROM nb_tree tree
           JOIN notebooks child ON child."parentId" = tree."descendantId"
          WHERE child."userId" = ? AND child."workspaceId" IS NULL AND child."isDeleted" = false
       ),
       note_counts("notebookId", "noteCount") AS (
         SELECT tree."ancestorId", COUNT(note.id)
           FROM nb_tree tree
           JOIN notes note ON note."notebookId" = tree."descendantId"
          WHERE note."userId" = ? AND note."isTrashed" = false AND note."workspaceId" IS NULL
          GROUP BY tree."ancestorId"
       )
       SELECT nb.*, COALESCE(counts."noteCount", 0) AS "noteCount"
         FROM notebooks nb
         LEFT JOIN note_counts counts ON counts."notebookId" = nb.id
        WHERE nb."userId" = ? AND nb."workspaceId" IS NULL AND nb."isDeleted" = false
        ORDER BY nb."sortOrder" ASC, nb."createdAt" ASC, nb.id ASC`,
      [userId, userId, userId, userId],
    );

    return c.json(rows.map(normalizeNotebookRow));
  });

  return app;
}

export default createNotebooksRuntimeRouter;
