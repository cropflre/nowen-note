import { Hono } from "hono";

import { getDb } from "../db/schema";
import {
  hasKnowledgeCapability,
  resolveResourceKnowledgeAccess,
} from "../services/knowledgeCapabilities";
import {
  clearSearchNotebookExcluded,
  getEffectiveExcludedNotebookIds,
  listDirectSearchNotebookExclusions,
  setSearchNotebookExcluded,
} from "../services/searchNotebookExclusions";

const app = new Hono();

function userIdOf(c: any): string {
  return c.req.header("X-User-Id") || "";
}

function canViewNotebook(notebookId: string, userId: string): boolean {
  const access = resolveResourceKnowledgeAccess("notebook", notebookId, userId, getDb());
  return hasKnowledgeCapability(access, "canView");
}

app.get("/", (c) => {
  const userId = userIdOf(c);
  const db = getDb();
  const direct = listDirectSearchNotebookExclusions(userId, db)
    // Never reveal stale exclusions for resources the current user can no longer see.
    .filter((row) => canViewNotebook(row.notebookId, userId));
  const visibleEffective = getEffectiveExcludedNotebookIds(userId, db);
  return c.json({
    direct,
    directCount: direct.length,
    effectiveNotebookCount: visibleEffective.size,
  });
});

app.put("/:notebookId", async (c) => {
  const userId = userIdOf(c);
  const notebookId = c.req.param("notebookId");
  if (!canViewNotebook(notebookId, userId)) {
    return c.json({ error: "没有查看该笔记本的权限", code: "SEARCH_NOTEBOOK_FORBIDDEN" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const row = setSearchNotebookExcluded({
    userId,
    notebookId,
    includeDescendants: body?.includeDescendants !== false,
  });
  return c.json({ success: true, exclusion: row });
});

app.delete("/:notebookId", (c) => {
  const userId = userIdOf(c);
  const notebookId = c.req.param("notebookId");
  // Clearing a caller's own stale rule is safe even when their content permission was revoked.
  const removed = clearSearchNotebookExcluded({ userId, notebookId });
  return c.json({ success: true, removed });
});

export default app;
