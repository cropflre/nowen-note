import type Database from "better-sqlite3";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { ensureKnowledgeTreePasswordTable } from "../db/knowledgeTreePasswordMigration.js";
import { resolveKnowledgeNodeAccess } from "./knowledgeCapabilities.js";
import type { KnowledgeTreeNode } from "./knowledgeTreeCore.js";

const ROOT_DOCUMENT_NOTEBOOK_PREFIX = "__nowen_root_documents__:";
const ROOT_DOCUMENT_NODE_PREFIX = `notebook:${ROOT_DOCUMENT_NOTEBOOK_PREFIX}`;

type ListedNodeRow = Omit<KnowledgeTreeNode, "access">;

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

const TITLE_EXPRESSION = `CASE
  WHEN node.resourceType = 'notebook' THEN COALESCE(nb.name, '未命名文件夹')
  WHEN node.resourceType = 'note' THEN COALESCE(note.title, '无标题笔记')
  WHEN node.resourceType = 'mindmap' THEN COALESCE(mm.title, node.resourceId)
  WHEN node.resourceType = 'file' THEN COALESCE(file.filename, node.resourceId)
  ELSE node.resourceId
END`;

/**
 * Read the mixed navigation tree without relying on an output alias in ORDER BY.
 * SQLite treats `title` as ambiguous once notes and mindmaps are joined, even when the SELECT
 * list also defines `AS title`; repeating the qualified CASE expression is deterministic.
 */
export function listKnowledgeTree(input: {
  userId: string;
  workspaceId: string | null;
  includeDeleted?: boolean;
  db?: Database.Database;
}): KnowledgeTreeNode[] {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  ensureKnowledgeTreePasswordTable(db);
  const key = scopeKey(input.userId, input.workspaceId);
  const rows = db.prepare(`
    SELECT node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
           node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
           node.isExpanded, node.isDeleted, node.deletedAt, node.createdAt, node.updatedAt,
           ${TITLE_EXPRESSION} AS title,
           CASE WHEN node.resourceType = 'notebook' THEN nb.icon ELSE NULL END AS icon,
           CASE WHEN node.resourceType = 'note' THEN COALESCE(note.isPinned, 0) ELSE 0 END AS isPinned,
           CASE WHEN node.resourceType = 'note' AND EXISTS(
             SELECT 1 FROM favorites favorite
             WHERE favorite.noteId = note.id AND favorite.userId = ?
           ) THEN 1 ELSE 0 END AS isFavorite,
           CASE WHEN node.resourceType = 'note' THEN COALESCE(note.isLocked, 0) ELSE 0 END AS isLocked,
           CASE WHEN node.resourceType = 'notebook' AND notebook_password.notebookId IS NOT NULL THEN 1 ELSE 0 END AS isPasswordProtected,
           CASE WHEN node.resourceType = 'note' THEN note.contentFormat ELSE NULL END AS contentFormat,
           0 AS childCount
    FROM knowledge_tree_nodes node
    LEFT JOIN notebooks nb ON node.resourceType = 'notebook' AND nb.id = node.resourceId
    LEFT JOIN notebook_passwords notebook_password
      ON node.resourceType = 'notebook' AND notebook_password.notebookId = node.resourceId
    LEFT JOIN notes note ON node.resourceType = 'note' AND note.id = node.resourceId
    LEFT JOIN mindmaps mm ON node.resourceType = 'mindmap' AND mm.id = node.resourceId
    LEFT JOIN files file ON node.resourceType = 'file' AND file.id = node.resourceId
    WHERE node.scopeKey = ? ${input.includeDeleted ? "" : "AND node.isDeleted = 0"}
    ORDER BY
      node.parentId IS NOT NULL,
      node.parentId,
      node.sortOrder,
      lower(${TITLE_EXPRESSION}),
      node.id
  `).all(input.userId, key) as ListedNodeRow[];

  const visible = rows
    .filter((row) => !(row.resourceType === "notebook" && row.resourceId.startsWith(ROOT_DOCUMENT_NOTEBOOK_PREFIX)))
    .map((row) => ({
      ...row,
      parentId: row.parentId?.startsWith(ROOT_DOCUMENT_NODE_PREFIX) ? null : row.parentId,
      // includeDeleted is an explicit recycle-bin/history view. Evaluate the
      // tombstone with its original ACL instead of making the flag ineffective.
      // Ordinary tree reads keep includeDeleted=false and still hide tombstones.
      access: resolveKnowledgeNodeAccess(
        row.id,
        input.userId,
        db,
        { includeDeleted: input.includeDeleted === true },
      ),
    }))
    .filter((row) => row.access.capabilities.canView);

  const visibleIds = new Set(visible.map((row) => row.id));
  const visibleChildCounts = new Map<string, number>();
  for (const row of visible) {
    if (!row.parentId || !visibleIds.has(row.parentId)) continue;
    visibleChildCounts.set(row.parentId, (visibleChildCounts.get(row.parentId) || 0) + 1);
  }

  return visible.map((row) => ({
    ...row,
    // A directly shared descendant must remain reachable even when its restricted
    // ancestor is hidden. Promote it to a visible root instead of leaking the
    // ancestor title or leaving an orphaned parent reference.
    parentId: row.parentId && visibleIds.has(row.parentId) ? row.parentId : null,
    childCount: visibleChildCounts.get(row.id) || 0,
  }));
}
