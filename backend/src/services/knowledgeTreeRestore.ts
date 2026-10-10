import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { resolveResourceKnowledgeAccessForTombstone } from "./knowledgeCapabilities.js";
import { KnowledgeTreeError } from "./knowledgeTreeCore.js";

type RestorableNode = {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  resourceType: "notebook" | "note" | "mindmap" | "file";
  resourceId: string;
  isDeleted: number;
};

function canRestoreRoot(db: Database.Database, node: RestorableNode, actorUserId: string): boolean {
  // Restore is a tombstone lifecycle operation. Evaluate the deleted resource's
  // own effective ACL (including explicit deny/restricted boundaries) instead of
  // inferring permission from the nearest surviving parent.
  return resolveResourceKnowledgeAccessForTombstone(
    node.resourceType,
    node.resourceId,
    actorUserId,
    db,
  ).capabilities.canDelete;
}

function readSubtree(db: Database.Database, nodeId: string, includeSubtree: boolean): RestorableNode[] {
  if (!includeSubtree) {
    const node = db.prepare(`
      SELECT id, userId, workspaceId, parentId, resourceType, resourceId, isDeleted
      FROM knowledge_tree_nodes WHERE id = ?
    `).get(nodeId) as RestorableNode | undefined;
    return node ? [node] : [];
  }
  return db.prepare(`
    WITH RECURSIVE subtree(id, depth) AS (
      SELECT id, 0 FROM knowledge_tree_nodes WHERE id = ?
      UNION ALL
      SELECT child.id, subtree.depth + 1
      FROM knowledge_tree_nodes child
      JOIN subtree ON child.parentId = subtree.id
    )
    SELECT node.id, node.userId, node.workspaceId, node.parentId,
           node.resourceType, node.resourceId, node.isDeleted
    FROM subtree
    JOIN knowledge_tree_nodes node ON node.id = subtree.id
    ORDER BY subtree.depth ASC, node.sortOrder ASC, node.id ASC
  `).all(nodeId) as RestorableNode[];
}

export function restoreKnowledgeNode(input: {
  actorUserId: string;
  nodeId: string;
  includeSubtree?: boolean;
  db?: Database.Database;
}): { success: true; restoredNodeIds: string[] } {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const root = db.prepare(`
    SELECT id, userId, workspaceId, parentId, resourceType, resourceId, isDeleted
    FROM knowledge_tree_nodes WHERE id = ?
  `).get(input.nodeId) as RestorableNode | undefined;
  if (!root) throw new KnowledgeTreeError("KNOWLEDGE_NODE_NOT_FOUND", 404, "内容节点不存在");
  if (!root.isDeleted) throw new KnowledgeTreeError("KNOWLEDGE_NODE_NOT_TRASHED", 409, "内容不在回收站");
  if (!canRestoreRoot(db, root, input.actorUserId)) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有恢复权限", { required: "canDelete" });
  }
  if (root.parentId) {
    const parent = db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id = ?")
      .get(root.parentId) as { isDeleted: number } | undefined;
    if (parent?.isDeleted) throw new KnowledgeTreeError("KNOWLEDGE_PARENT_DELETED", 409, "请先恢复上级文件夹");
  }

  // Only restore the cohort recorded by this folder's latest delete operation. A child
  // trashed earlier must stay in the bin when its former parent is restored.
  const deletion = input.includeSubtree === false ? undefined : db.prepare(`
    SELECT metadata FROM knowledge_tree_history
    WHERE nodeId = ? AND action = 'delete_subtree'
    ORDER BY rowid DESC LIMIT 1
  `).get(root.id) as { metadata: string | null } | undefined;
  let affectedIds: Set<string> | null = null;
  if (deletion?.metadata) {
    try {
      const parsed = JSON.parse(deletion.metadata) as { affectedNodeIds?: unknown };
      if (Array.isArray(parsed.affectedNodeIds)) {
        affectedIds = new Set(parsed.affectedNodeIds.filter((id): id is string => typeof id === "string"));
      }
    } catch { /* Missing legacy metadata restores only the requested node. */ }
  }
  const nodes = readSubtree(db, root.id, input.includeSubtree !== false)
    .filter((node) => node.isDeleted && (node.id === root.id || affectedIds?.has(node.id)));
  const restored: string[] = [];
  const transaction = db.transaction(() => {
    // Activate every navigation row first. Legacy resource triggers then see an active parent even
    // when their own restore UPDATE writes scopeKey/parentId as part of an idempotent sync.
    for (const node of nodes) {
      db.prepare(`
        UPDATE knowledge_tree_nodes
        SET isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now')
        WHERE id = ?
      `).run(node.id);
      restored.push(node.id);
    }

    for (const node of nodes) {
      if (node.resourceType === "note") {
        db.prepare("UPDATE notes SET isTrashed = 0, trashedAt = NULL, updatedAt = datetime('now') WHERE id = ?")
          .run(node.resourceId);
      } else if (node.resourceType === "notebook") {
        db.prepare("UPDATE notebooks SET isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now') WHERE id = ?")
          .run(node.resourceId);
      }
    }

    db.prepare(`
      INSERT INTO knowledge_tree_history (
        id, nodeId, action, actorUserId, toParentId, metadata
      ) VALUES (?, ?, 'restore', ?, ?, ?)
    `).run(uuid(), root.id, input.actorUserId, root.parentId, JSON.stringify({ restoredNodeIds: restored }));
  });
  transaction();
  return { success: true, restoredNodeIds: restored };
}
