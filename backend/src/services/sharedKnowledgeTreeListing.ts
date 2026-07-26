import type Database from "better-sqlite3";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { resolveKnowledgeNodeAccess } from "./knowledgeCapabilities.js";
import type { KnowledgeTreeNode } from "./knowledgeTreeCore.js";

export interface SharedKnowledgeTreeNode extends KnowledgeTreeNode {
  sharedRootId: string;
  sharedDepth: number;
}

type CandidateRow = Omit<KnowledgeTreeNode, "access" | "childCount"> & {
  sharedRootId: string;
  sharedDepth: number;
  rootWeight: number;
  sourcePriority: number;
};

type SelectedCandidate = CandidateRow & {
  access: KnowledgeTreeNode["access"];
};

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

function isPreferredCandidate(next: CandidateRow, current: CandidateRow): boolean {
  if (next.rootWeight !== current.rootWeight) return next.rootWeight > current.rootWeight;
  if (next.sharedDepth !== current.sharedDepth) return next.sharedDepth < current.sharedDepth;
  if (next.sourcePriority !== current.sourcePriority) return next.sourcePriority < current.sourcePriority;
  return next.sharedRootId.localeCompare(current.sharedRootId) < 0;
}

/**
 * Lists content shared with the current user as real knowledge-tree nodes.
 *
 * Direct roots come from either the unified ACL table or the legacy notebook-members table.
 * Descendants are traversed through knowledge_tree_nodes so mixed document/folder nesting is
 * preserved. Overlapping roots are de-duplicated without exposing ancestors or siblings outside
 * the authorized subtrees.
 */
export function listSharedKnowledgeTree(input: {
  userId: string;
  workspaceId: string | null;
  db?: Database.Database;
}): SharedKnowledgeTreeNode[] {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const currentScopeKey = scopeKey(input.userId, input.workspaceId);

  const candidates = db.prepare(`
    WITH RECURSIVE
    direct_roots(sharedRootId, rootWeight, sourcePriority) AS (
      SELECT
        acl.nodeId,
        CASE acl.rolePreset
          WHEN 'admin' THEN 4
          WHEN 'maintainer' THEN 3
          WHEN 'editor' THEN 2
          ELSE 1
        END,
        0
      FROM knowledge_tree_acl acl
      JOIN knowledge_tree_nodes root ON root.id = acl.nodeId
      WHERE acl.userId = ?
        AND acl.canView <> 0
        AND root.isDeleted = 0
        AND root.scopeKey <> ?

      UNION ALL

      SELECT
        root.id,
        CASE nm.role
          WHEN 'owner' THEN 4
          WHEN 'editor' THEN 2
          ELSE 1
        END,
        1
      FROM notebook_members nm
      JOIN notebooks nb ON nb.id = nm.notebookId
      JOIN knowledge_tree_nodes root
        ON root.resourceType = 'notebook'
       AND root.resourceId = nb.id
       AND root.isDeleted = 0
      WHERE nm.userId = ?
        AND nm.status = 'active'
        AND nb.userId <> ?
        AND nb.isDeleted = 0
        AND root.scopeKey <> ?
    ),
    unique_roots(sharedRootId, rootWeight, sourcePriority) AS (
      SELECT sharedRootId, MAX(rootWeight), MIN(sourcePriority)
      FROM direct_roots
      GROUP BY sharedRootId
    ),
    shared_tree(sharedRootId, descendantId, sharedDepth, rootWeight, sourcePriority) AS (
      SELECT sharedRootId, sharedRootId, 0, rootWeight, sourcePriority
      FROM unique_roots
      UNION ALL
      SELECT tree.sharedRootId, child.id, tree.sharedDepth + 1, tree.rootWeight, tree.sourcePriority
      FROM shared_tree tree
      JOIN knowledge_tree_nodes child ON child.parentId = tree.descendantId
      WHERE child.isDeleted = 0
    )
    SELECT
      node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
      node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
      node.isExpanded, node.isDeleted, node.createdAt, node.updatedAt,
      ${TITLE_EXPRESSION} AS title,
      CASE WHEN node.resourceType = 'notebook' THEN nb.icon ELSE NULL END AS icon,
      CASE WHEN node.resourceType = 'note' THEN COALESCE(note.isPinned, 0) ELSE 0 END AS isPinned,
      CASE WHEN node.resourceType = 'note' THEN COALESCE(note.isFavorite, 0) ELSE 0 END AS isFavorite,
      CASE WHEN node.resourceType = 'note' THEN COALESCE(note.isLocked, 0) ELSE 0 END AS isLocked,
      CASE WHEN node.resourceType = 'note' THEN note.contentFormat ELSE NULL END AS contentFormat,
      shared_tree.sharedRootId, shared_tree.sharedDepth,
      shared_tree.rootWeight, shared_tree.sourcePriority
    FROM shared_tree
    JOIN knowledge_tree_nodes node ON node.id = shared_tree.descendantId
    LEFT JOIN notebooks nb ON node.resourceType = 'notebook' AND nb.id = node.resourceId
    LEFT JOIN notes note ON node.resourceType = 'note' AND note.id = node.resourceId
    LEFT JOIN mindmaps mm ON node.resourceType = 'mindmap' AND mm.id = node.resourceId
    LEFT JOIN files file ON node.resourceType = 'file' AND file.id = node.resourceId
    WHERE node.isDeleted = 0
    ORDER BY shared_tree.sharedRootId, shared_tree.sharedDepth, node.sortOrder,
             lower(${TITLE_EXPRESSION}), node.id
  `).all(
    input.userId,
    currentScopeKey,
    input.userId,
    input.userId,
    currentScopeKey,
  ) as CandidateRow[];

  const selectedById = new Map<string, SelectedCandidate>();
  for (const candidate of candidates) {
    const access = resolveKnowledgeNodeAccess(candidate.id, input.userId, db);
    if (!access.capabilities.canView) continue;
    const current = selectedById.get(candidate.id);
    if (!current || isPreferredCandidate(candidate, current)) {
      selectedById.set(candidate.id, { ...candidate, access });
    }
  }

  const selectedIds = new Set(selectedById.keys());
  const normalized = Array.from(selectedById.values()).map((node) => {
    const parent = node.parentId ? selectedById.get(node.parentId) : undefined;
    const parentId = parent && parent.sharedRootId === node.sharedRootId && selectedIds.has(parent.id)
      ? parent.id
      : null;
    return { ...node, parentId };
  });

  const childCounts = new Map<string, number>();
  for (const node of normalized) {
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) || 0) + 1);
  }

  return normalized
    .map(({ rootWeight: _rootWeight, sourcePriority: _sourcePriority, ...node }) => ({
      ...node,
      childCount: childCounts.get(node.id) || 0,
    }))
    .sort((a, b) =>
      a.sharedRootId.localeCompare(b.sharedRootId)
      || a.sharedDepth - b.sharedDepth
      || a.sortOrder - b.sortOrder
      || a.title.localeCompare(b.title)
      || a.id.localeCompare(b.id));
}
