import type Database from "better-sqlite3";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import {
  createKnowledgeChild as createKnowledgeChildBase,
  moveKnowledgeNode as moveKnowledgeNodeBase,
  type KnowledgeTreeNode,
} from "./knowledgeTreeCore.js";

export const ROOT_DOCUMENT_NOTEBOOK_PREFIX = "__nowen_root_documents__:";
const ROOT_DOCUMENT_NOTEBOOK_NAME = "__NOWEN_ROOT_DOCUMENTS__";

export function isRootDocumentNotebookId(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ROOT_DOCUMENT_NOTEBOOK_PREFIX);
}

function rootNotebookId(userId: string, workspaceId: string | null): string {
  return workspaceId
    ? `${ROOT_DOCUMENT_NOTEBOOK_PREFIX}workspace:${workspaceId}`
    : `${ROOT_DOCUMENT_NOTEBOOK_PREFIX}personal:${userId}`;
}

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

function resolveContainerOwner(
  db: Database.Database,
  actorUserId: string,
  workspaceId: string | null,
): string {
  if (!workspaceId) return actorUserId;
  const workspace = db.prepare("SELECT ownerId FROM workspaces WHERE id = ?")
    .get(workspaceId) as { ownerId: string } | undefined;
  return workspace?.ownerId || actorUserId;
}

function activateRootContainer(
  db: Database.Database,
  actorUserId: string,
  workspaceId: string | null,
): { notebookId: string; nodeId: string; ownerUserId: string; scope: string } {
  ensureKnowledgeTreeTables(db);
  const ownerUserId = resolveContainerOwner(db, actorUserId, workspaceId);
  const notebookId = rootNotebookId(ownerUserId, workspaceId);
  const nodeId = `notebook:${notebookId}`;
  const scope = scopeKey(ownerUserId, workspaceId);

  db.prepare(`
    INSERT OR IGNORE INTO notebooks (
      id, userId, workspaceId, parentId, name, icon, sortOrder,
      isExpanded, isDeleted, deletedAt
    ) VALUES (?, ?, ?, NULL, ?, '📄', -2147483648, 0, 0, NULL)
  `).run(notebookId, ownerUserId, workspaceId, ROOT_DOCUMENT_NOTEBOOK_NAME);

  db.prepare(`
    UPDATE notebooks
       SET userId = ?, workspaceId = ?, parentId = NULL, name = ?,
           sortOrder = -2147483648, isExpanded = 0,
           isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now')
     WHERE id = ?
  `).run(ownerUserId, workspaceId, ROOT_DOCUMENT_NOTEBOOK_NAME, notebookId);

  db.prepare(`
    INSERT OR IGNORE INTO knowledge_tree_nodes (
      id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
      resourceId, sortOrder, isExpanded, isDeleted, deletedAt
    ) VALUES (?, ?, ?, ?, NULL, 'folder', 'notebook', ?, -2147483648, 0, 0, NULL)
  `).run(nodeId, ownerUserId, workspaceId, scope, notebookId);

  db.prepare(`
    UPDATE knowledge_tree_nodes
       SET userId = ?, workspaceId = ?, scopeKey = ?, parentId = NULL,
           sortOrder = -2147483648, isExpanded = 0,
           isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now')
     WHERE id = ?
  `).run(ownerUserId, workspaceId, scope, nodeId);

  return { notebookId, nodeId, ownerUserId, scope };
}

function hideRootContainer(db: Database.Database, notebookId: string, nodeId: string): void {
  db.prepare(`
    UPDATE notebooks
       SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
     WHERE id = ?
  `).run(notebookId);
  db.prepare("DELETE FROM knowledge_tree_nodes WHERE id = ?").run(nodeId);
}

function rootDocumentContainerForParent(
  db: Database.Database,
  parentId: string,
): { ownerUserId: string; workspaceId: string | null } | null {
  ensureKnowledgeTreeTables(db);
  const parent = db.prepare(`
    SELECT tree.userId AS ownerUserId, tree.workspaceId, note.notebookId
      FROM knowledge_tree_nodes tree
      JOIN notes note
        ON tree.resourceType = 'note' AND tree.resourceId = note.id
     WHERE tree.id = ? AND tree.isDeleted = 0
  `).get(parentId) as {
    ownerUserId: string;
    workspaceId: string | null;
    notebookId: string | null;
  } | undefined;

  if (!parent || !isRootDocumentNotebookId(parent.notebookId)) return null;
  return { ownerUserId: parent.ownerUserId, workspaceId: parent.workspaceId || null };
}

function nextRootSortOrder(db: Database.Database, scope: string, nodeId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(sortOrder), -1) + 1 AS value
      FROM knowledge_tree_nodes
     WHERE scopeKey = ? AND parentId IS NULL AND isDeleted = 0 AND id <> ?
  `).get(scope, nodeId) as { value: number } | undefined;
  return Number(row?.value ?? 0);
}

function detachDocumentAtRoot(
  db: Database.Database,
  node: KnowledgeTreeNode,
  scope: string,
  temporaryParentId: string,
  action: "create" | "move",
): KnowledgeTreeNode {
  const sortOrder = nextRootSortOrder(db, scope, node.id);
  db.prepare(`
    UPDATE knowledge_tree_nodes
       SET parentId = NULL, sortOrder = ?, updatedAt = datetime('now')
     WHERE id = ?
  `).run(sortOrder, node.id);
  db.prepare("UPDATE notes SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?")
    .run(sortOrder, node.resourceId);
  db.prepare(`
    UPDATE knowledge_tree_history
       SET toParentId = NULL
     WHERE nodeId = ? AND action = ? AND toParentId = ?
  `).run(node.id, action, temporaryParentId);
  return { ...node, parentId: null, sortOrder };
}

export function createKnowledgeChild(input: {
  actorUserId: string;
  workspaceId: string | null;
  parentId: string | null;
  nodeType: "folder" | "note" | "markdown" | "word";
  title: string;
  db?: Database.Database;
}): KnowledgeTreeNode {
  if (input.parentId !== null) {
    const db = input.db || getDb();
    const parentContainer = rootDocumentContainerForParent(db, input.parentId);
    if (!parentContainer) return createKnowledgeChildBase(input);

    const execute = db.transaction(() => {
      const container = activateRootContainer(
        db,
        parentContainer.ownerUserId,
        parentContainer.workspaceId,
      );
      try {
        return createKnowledgeChildBase({ ...input, db });
      } finally {
        hideRootContainer(db, container.notebookId, container.nodeId);
      }
    });
    return execute();
  }

  if (input.nodeType === "folder") {
    return createKnowledgeChildBase(input);
  }

  const db = input.db || getDb();
  const execute = db.transaction(() => {
    const container = activateRootContainer(db, input.actorUserId, input.workspaceId || null);
    const created = createKnowledgeChildBase({
      ...input,
      parentId: container.nodeId,
      db,
    });
    const detached = detachDocumentAtRoot(db, created, container.scope, container.nodeId, "create");
    hideRootContainer(db, container.notebookId, container.nodeId);
    return detached;
  });
  return execute();
}

export function moveKnowledgeNode(input: {
  actorUserId: string;
  nodeId: string;
  parentId: string | null;
  sortOrder?: number;
  db?: Database.Database;
}): KnowledgeTreeNode {
  if (input.parentId !== null) return moveKnowledgeNodeBase(input);

  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const node = db.prepare(`
    SELECT id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
           resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
      FROM knowledge_tree_nodes
     WHERE id = ? AND isDeleted = 0
  `).get(input.nodeId) as (KnowledgeTreeNode & { resourceType: string }) | undefined;

  if (!node || node.resourceType !== "note") return moveKnowledgeNodeBase(input);

  const execute = db.transaction(() => {
    const container = activateRootContainer(db, input.actorUserId, node.workspaceId || null);
    const moved = moveKnowledgeNodeBase({
      ...input,
      parentId: container.nodeId,
      db,
    });
    const detached = detachDocumentAtRoot(db, moved, node.scopeKey, container.nodeId, "move");
    hideRootContainer(db, container.notebookId, container.nodeId);
    return detached;
  });
  return execute();
}
