import type Database from "better-sqlite3";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { resolveKnowledgeNodeAccess } from "./knowledgeCapabilities.js";
import type { KnowledgeTreeNode } from "./knowledgeTreeCore.js";

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
  const key = scopeKey(input.userId, input.workspaceId);
  const rows = db.prepare(`
    SELECT node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
           node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
           node.isExpanded, node.isDeleted, node.deletedAt, node.createdAt, node.updatedAt,
           ${TITLE_EXPRESSION} AS title,
           (SELECT COUNT(*) FROM knowledge_tree_nodes child
             WHERE child.parentId = node.id AND child.isDeleted = 0) AS childCount
    FROM knowledge_tree_nodes node
    LEFT JOIN notebooks nb ON node.resourceType = 'notebook' AND nb.id = node.resourceId
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
  `).all(key) as ListedNodeRow[];

  return rows
    .map((row) => ({ ...row, access: resolveKnowledgeNodeAccess(row.id, input.userId, db) }))
    .filter((row) => row.access.capabilities.canView);
}
