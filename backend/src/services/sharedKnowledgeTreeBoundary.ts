import type Database from "better-sqlite3";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { listSharedKnowledgeTree } from "./sharedKnowledgeTreeListing.js";

type NodeScopeRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  isDeleted: number;
};

function participatesInWorkspace(db: Database.Database, workspaceId: string, userId: string): boolean {
  const owner = db.prepare("SELECT ownerId FROM workspaces WHERE id = ?")
    .get(workspaceId) as { ownerId: string } | undefined;
  if (owner?.ownerId === userId) return true;
  return Boolean(db.prepare(
    "SELECT 1 AS found FROM workspace_members WHERE workspaceId = ? AND userId = ? LIMIT 1",
  ).get(workspaceId, userId));
}

/**
 * Returns the effective shared root assigned to a node for an actor.
 *
 * Personal content owned by another account is shared. Workspace content is only treated as a
 * shared-root subtree when the actor is not a member of that workspace and receives access from
 * a node ACL or legacy notebook membership. Ordinary workspace members continue to use the normal
 * workspace tree and are not restricted by the shared-root boundary.
 */
export function resolveSharedKnowledgeRoot(
  nodeId: string,
  actorUserId: string,
  db: Database.Database = getDb(),
): string | null {
  ensureKnowledgeTreeTables(db);
  const node = db.prepare(`
    SELECT id, userId, workspaceId, isDeleted
    FROM knowledge_tree_nodes
    WHERE id = ?
  `).get(nodeId) as NodeScopeRow | undefined;
  if (!node || node.isDeleted) return null;

  if (!node.workspaceId && node.userId === actorUserId) return null;
  if (node.workspaceId && participatesInWorkspace(db, node.workspaceId, actorUserId)) return null;

  const shared = listSharedKnowledgeTree({
    userId: actorUserId,
    // Use the actor's personal scope as the excluded section so ACL-only workspace content can
    // still be resolved as shared when the actor is not a workspace member.
    workspaceId: null,
    db,
  });
  return shared.find((entry) => entry.id === nodeId)?.sharedRootId || null;
}
