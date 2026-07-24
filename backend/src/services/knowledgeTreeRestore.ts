import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { resolveKnowledgeNodeAccess } from "./knowledgeCapabilities.js";
import { KnowledgeTreeError } from "./knowledgeTreeCore.js";

type RestorableNode = {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  resourceType: "notebook" | "note" | "mindmap" | "file";
  resourceId: string;
};

function canRestoreRoot(db: Database.Database, node: RestorableNode, actorUserId: string): boolean {
  if (!node.workspaceId) return node.userId === actorUserId;
  const workspace = db.prepare("SELECT ownerId FROM workspaces WHERE id = ?").get(node.workspaceId) as
    | { ownerId: string }
    | undefined;
  if (workspace?.ownerId === actorUserId) return true;
  const member = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(node.workspaceId, actorUserId) as { role: string } | undefined;
  if (member?.role === "owner" || member?.role === "admin") return true;
  if (!node.parentId) return false;
  return resolveKnowledgeNodeAccess(node.parentId, actorUserId, db).capabilities.canDelete;
}

function readSubtree(db: Database.Database, nodeId: string, includeSubtree: boolean): RestorableNode[] {
  if (!includeSubtree) {
    const node = db.prepare(`
      SELECT id, userId, workspaceId, parentId, resourceType, resourceId
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
           node.resourceType, node.resourceId
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
    SELECT id, userId, workspaceId, parentId, resourceType, resourceId
    FROM knowledge_tree_nodes WHERE id = ?
  `).get(input.nodeId) as RestorableNode | undefined;
  if (!root) throw new KnowledgeTreeError("KNOWLEDGE_NODE_NOT_FOUND", 404, "内容节点不存在");
  if (!canRestoreRoot(db, root, input.actorUserId)) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有恢复权限", { required: "canDelete" });
  }

  const nodes = readSubtree(db, input.nodeId, input.includeSubtree !== false);
  const restored: string[] = [];
  const transaction = db.transaction(() => {
    // Activate every navigation row first. Legacy resource triggers then see an active parent even
    // when their own restore UPDATE writes scopeKey/parentId as part of an idempotent sync.
    for (const node of nodes) {
      console.log("[knowledge-tree-restore] activate-node", node.id, node.parentId);
      db.prepare(`
        UPDATE knowledge_tree_nodes
        SET isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now')
        WHERE id = ?
      `).run(node.id);
      restored.push(node.id);
    }

    for (const node of nodes) {
      console.log("[knowledge-tree-restore] restore-resource", node.resourceType, node.resourceId, node.parentId);
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
