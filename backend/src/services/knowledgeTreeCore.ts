import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import {
  hasKnowledgeCapability,
  resolveKnowledgeNodeAccess,
  type EffectiveKnowledgeAccess,
  type KnowledgeCapabilityName,
} from "./knowledgeCapabilities.js";

export type KnowledgeNodeType = "folder" | "note" | "markdown" | "word" | "mindmap" | "file";
export type KnowledgeResourceType = "notebook" | "note" | "mindmap" | "file";
export type KnowledgeDeleteMode = "subtree" | "promote";

export interface KnowledgeTreeNode {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  nodeType: KnowledgeNodeType;
  resourceType: KnowledgeResourceType;
  resourceId: string;
  title: string;
  sortOrder: number;
  isExpanded: number;
  isDeleted: number;
  childCount: number;
  createdAt: string;
  updatedAt: string;
  access: EffectiveKnowledgeAccess;
}

type NodeRow = Omit<KnowledgeTreeNode, "title" | "childCount" | "access">;

export class KnowledgeTreeError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

function readNode(db: Database.Database, nodeId: string, includeDeleted = false): NodeRow | null {
  return (db.prepare(`
    SELECT id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
           resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    FROM knowledge_tree_nodes
    WHERE id = ? ${includeDeleted ? "" : "AND isDeleted = 0"}
  `).get(nodeId) as NodeRow | undefined) || null;
}

function requireNode(db: Database.Database, nodeId: string, includeDeleted = false): NodeRow {
  const node = readNode(db, nodeId, includeDeleted);
  if (!node) throw new KnowledgeTreeError("KNOWLEDGE_NODE_NOT_FOUND", 404, "内容节点不存在");
  return node;
}

function requireCapability(
  db: Database.Database,
  nodeId: string,
  userId: string,
  capability: KnowledgeCapabilityName,
): EffectiveKnowledgeAccess {
  const access = resolveKnowledgeNodeAccess(nodeId, userId, db);
  if (!hasKnowledgeCapability(access, capability)) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "权限不足", {
      nodeId,
      required: capability,
      source: access.source,
    });
  }
  return access;
}

function workspaceRootAccess(db: Database.Database, userId: string, workspaceId: string | null): EffectiveKnowledgeAccess {
  if (!workspaceId) {
    return {
      nodeId: "",
      rolePreset: "admin",
      source: "owner",
      sourceNodeId: null,
      capabilities: {
        canView: true,
        canComment: true,
        canCreate: true,
        canEdit: true,
        canDelete: true,
        canMove: true,
        canDownload: true,
        canReshare: true,
        canManageMembers: true,
      },
    };
  }
  const row = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(workspaceId, userId) as { role: string } | undefined;
  const owner = db.prepare("SELECT ownerId FROM workspaces WHERE id = ?")
    .get(workspaceId) as { ownerId: string } | undefined;
  const role = owner?.ownerId === userId ? "owner" : row?.role;
  const admin = role === "owner" || role === "admin";
  const editor = admin || role === "editor";
  return {
    nodeId: "",
    rolePreset: admin ? "admin" : editor ? "editor" : role === "commenter" ? "commenter" : role === "viewer" ? "readonly" : "none",
    source: role ? "legacy" : "none",
    sourceNodeId: null,
    capabilities: {
      canView: !!role,
      canComment: editor || role === "commenter",
      canCreate: editor,
      canEdit: editor,
      canDelete: admin,
      canMove: admin,
      canDownload: !!role,
      canReshare: admin,
      canManageMembers: admin,
    },
  };
}

function resolveTargetAccess(
  db: Database.Database,
  targetParentId: string | null,
  userId: string,
  workspaceId: string | null,
): EffectiveKnowledgeAccess {
  return targetParentId
    ? resolveKnowledgeNodeAccess(targetParentId, userId, db)
    : workspaceRootAccess(db, userId, workspaceId);
}

function titleExpression(): string {
  return `CASE
    WHEN node.resourceType = 'notebook' THEN COALESCE(nb.name, '未命名文件夹')
    WHEN node.resourceType = 'note' THEN COALESCE(note.title, '无标题笔记')
    WHEN node.resourceType = 'mindmap' THEN COALESCE(mm.title, node.resourceId)
    WHEN node.resourceType = 'file' THEN COALESCE(file.filename, node.resourceId)
    ELSE node.resourceId
  END`;
}

export function listKnowledgeTree(input: {
  userId: string;
  workspaceId: string | null;
  includeDeleted?: boolean;
  db?: Database.Database;
}): KnowledgeTreeNode[] {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const key = scopeKey(input.userId, input.workspaceId);
  // In a workspace the scope key does not contain the requesting user. In personal space it does,
  // so another account cannot enumerate someone else's private tree by guessing an id.
  const rows = db.prepare(`
    SELECT node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
           node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
           node.isExpanded, node.isDeleted, node.deletedAt, node.createdAt, node.updatedAt,
           ${titleExpression()} AS title,
           (SELECT COUNT(*) FROM knowledge_tree_nodes child
             WHERE child.parentId = node.id AND child.isDeleted = 0) AS childCount
    FROM knowledge_tree_nodes node
    LEFT JOIN notebooks nb ON node.resourceType = 'notebook' AND nb.id = node.resourceId
    LEFT JOIN notes note ON node.resourceType = 'note' AND note.id = node.resourceId
    LEFT JOIN mindmaps mm ON node.resourceType = 'mindmap' AND mm.id = node.resourceId
    LEFT JOIN files file ON node.resourceType = 'file' AND file.id = node.resourceId
    WHERE node.scopeKey = ? ${input.includeDeleted ? "" : "AND node.isDeleted = 0"}
    ORDER BY node.parentId IS NOT NULL, node.parentId, node.sortOrder, lower(title), node.id
  `).all(key) as Array<NodeRow & { title: string; childCount: number }>;

  return rows
    .map((row) => ({ ...row, access: resolveKnowledgeNodeAccess(row.id, input.userId, db) }))
    .filter((row) => row.access.capabilities.canView);
}

function nearestNotebookContainer(db: Database.Database, nodeId: string | null): string | null {
  let cursor = nodeId;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) throw new KnowledgeTreeError("KNOWLEDGE_TREE_CYCLE", 409, "目录结构存在循环");
    visited.add(cursor);
    const node = readNode(db, cursor, true);
    if (!node) return null;
    if (node.resourceType === "notebook") return node.resourceId;
    if (node.resourceType === "note") {
      const note = db.prepare("SELECT notebookId FROM notes WHERE id = ?").get(node.resourceId) as { notebookId: string } | undefined;
      if (note?.notebookId) return note.notebookId;
    }
    cursor = node.parentId;
  }
  return null;
}

function recordHistory(db: Database.Database, input: {
  nodeId: string;
  action: "create" | "move" | "reorder" | "delete_subtree" | "delete_promote" | "restore";
  actorUserId: string;
  fromParentId?: string | null;
  toParentId?: string | null;
  metadata?: unknown;
}): void {
  db.prepare(`
    INSERT INTO knowledge_tree_history (
      id, nodeId, action, actorUserId, fromParentId, toParentId, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), input.nodeId, input.action, input.actorUserId,
    input.fromParentId ?? null, input.toParentId ?? null,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  );
}

function maxSortOrder(db: Database.Database, scope: string, parentId: string | null): number {
  const row = parentId
    ? db.prepare("SELECT COALESCE(MAX(sortOrder), -1) AS value FROM knowledge_tree_nodes WHERE scopeKey = ? AND parentId = ? AND isDeleted = 0")
      .get(scope, parentId) as { value: number }
    : db.prepare("SELECT COALESCE(MAX(sortOrder), -1) AS value FROM knowledge_tree_nodes WHERE scopeKey = ? AND parentId IS NULL AND isDeleted = 0")
      .get(scope) as { value: number };
  return Number(row?.value ?? -1) + 1;
}

function nodeForResource(db: Database.Database, resourceType: KnowledgeResourceType, resourceId: string): NodeRow {
  const row = db.prepare(`
    SELECT id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
           resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    FROM knowledge_tree_nodes WHERE resourceType = ? AND resourceId = ? LIMIT 1
  `).get(resourceType, resourceId) as NodeRow | undefined;
  if (!row) throw new KnowledgeTreeError("KNOWLEDGE_NODE_SYNC_FAILED", 409, "内容节点同步失败");
  return row;
}

export function createKnowledgeChild(input: {
  actorUserId: string;
  workspaceId: string | null;
  parentId: string | null;
  nodeType: "folder" | "note" | "markdown" | "word";
  title: string;
  db?: Database.Database;
}): KnowledgeTreeNode {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const parent = input.parentId ? requireNode(db, input.parentId) : null;
  const normalizedWorkspaceId = input.workspaceId || null;
  const expectedScope = scopeKey(input.actorUserId, normalizedWorkspaceId);
  if (parent && parent.scopeKey !== expectedScope) {
    throw new KnowledgeTreeError("KNOWLEDGE_TREE_SCOPE_MISMATCH", 400, "父节点不在当前空间");
  }
  const targetAccess = resolveTargetAccess(db, input.parentId, input.actorUserId, normalizedWorkspaceId);
  if (!targetAccess.capabilities.canCreate) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有在此处新建内容的权限", { required: "canCreate" });
  }

  const title = input.title.trim() || (input.nodeType === "folder" ? "新建文件夹" : "无标题笔记");
  const key = parent?.scopeKey || expectedScope;
  const sortOrder = maxSortOrder(db, key, input.parentId);
  let createdNode: NodeRow | null = null;

  const transaction = db.transaction(() => {
    if (input.nodeType === "folder") {
      const notebookId = uuid();
      const physicalParentId = nearestNotebookContainer(db, input.parentId);
      db.prepare(`
        INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, sortOrder)
        VALUES (?, ?, ?, ?, ?, '📁', ?)
      `).run(notebookId, input.actorUserId, normalizedWorkspaceId, physicalParentId, title, sortOrder);
      createdNode = nodeForResource(db, "notebook", notebookId);
    } else {
      const notebookId = nearestNotebookContainer(db, input.parentId);
      if (!notebookId) {
        throw new KnowledgeTreeError("KNOWLEDGE_TREE_NOTE_CONTAINER_REQUIRED", 400, "根级文档需要先创建文件夹");
      }
      const noteId = uuid();
      const contentFormat = input.nodeType === "markdown" ? "markdown" : "tiptap-json";
      const noteType = input.nodeType === "word" ? "word" : "normal";
      const content = contentFormat === "markdown" ? `# ${title}\n\n` : "{}";
      db.prepare(`
        INSERT INTO notes (
          id, userId, workspaceId, notebookId, title, content, contentText,
          contentFormat, note_type, sortOrder
        ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
      `).run(
        noteId, input.actorUserId, normalizedWorkspaceId, notebookId, title,
        content, contentFormat, noteType, sortOrder,
      );
      createdNode = nodeForResource(db, "note", noteId);
    }

    if (!createdNode) throw new KnowledgeTreeError("KNOWLEDGE_NODE_SYNC_FAILED", 409, "内容节点同步失败");
    db.prepare(`
      UPDATE knowledge_tree_nodes
      SET parentId = ?, sortOrder = ?, updatedAt = datetime('now')
      WHERE id = ?
    `).run(input.parentId, sortOrder, createdNode.id);
    recordHistory(db, {
      nodeId: createdNode.id,
      action: "create",
      actorUserId: input.actorUserId,
      toParentId: input.parentId,
      metadata: { nodeType: input.nodeType, title },
    });
  });
  transaction();

  const row = requireNode(db, createdNode!.id);
  return {
    ...row,
    title,
    childCount: 0,
    access: resolveKnowledgeNodeAccess(row.id, input.actorUserId, db),
  };
}

function isDescendant(db: Database.Database, ancestorId: string, candidateId: string): boolean {
  const row = db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM knowledge_tree_nodes WHERE parentId = ? AND isDeleted = 0
      UNION ALL
      SELECT child.id
      FROM knowledge_tree_nodes child
      JOIN descendants parent ON child.parentId = parent.id
      WHERE child.isDeleted = 0
    )
    SELECT 1 AS found FROM descendants WHERE id = ? LIMIT 1
  `).get(ancestorId, candidateId) as { found: number } | undefined;
  return !!row;
}

function syncBusinessParent(db: Database.Database, node: NodeRow, treeParentId: string | null): void {
  const notebookContainer = nearestNotebookContainer(db, treeParentId);
  if (node.resourceType === "note") {
    if (!notebookContainer) {
      throw new KnowledgeTreeError("KNOWLEDGE_TREE_NOTE_CONTAINER_REQUIRED", 400, "文档必须位于可承载文档的目录中");
    }
    db.prepare("UPDATE notes SET notebookId = ?, workspaceId = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(notebookContainer, node.workspaceId, node.resourceId);
  } else if (node.resourceType === "notebook") {
    db.prepare("UPDATE notebooks SET parentId = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(notebookContainer, node.resourceId);
  }
}

export function moveKnowledgeNode(input: {
  actorUserId: string;
  nodeId: string;
  parentId: string | null;
  sortOrder?: number;
  db?: Database.Database;
}): KnowledgeTreeNode {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const node = requireNode(db, input.nodeId);
  requireCapability(db, node.id, input.actorUserId, "canMove");

  const parent = input.parentId ? requireNode(db, input.parentId) : null;
  if (parent && parent.scopeKey !== node.scopeKey) {
    throw new KnowledgeTreeError("KNOWLEDGE_TREE_SCOPE_MISMATCH", 400, "不能跨空间移动内容");
  }
  if (input.parentId === node.id || (input.parentId && isDescendant(db, node.id, input.parentId))) {
    throw new KnowledgeTreeError("KNOWLEDGE_TREE_CYCLE", 400, "不能移动到自身或自己的后代节点");
  }
  const targetAccess = resolveTargetAccess(db, input.parentId, input.actorUserId, node.workspaceId);
  if (!targetAccess.capabilities.canCreate && !targetAccess.capabilities.canMove) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有移动到目标位置的权限", { required: "canCreate" });
  }

  const nextSort = Number.isFinite(input.sortOrder)
    ? Math.max(0, Math.trunc(input.sortOrder!))
    : maxSortOrder(db, node.scopeKey, input.parentId);
  const fromParentId = node.parentId;

  const transaction = db.transaction(() => {
    syncBusinessParent(db, node, input.parentId);
    // Business table triggers intentionally normalize to the nearest physical notebook. Restore
    // the richer document-parent relationship after that compatibility update.
    db.prepare(`
      UPDATE knowledge_tree_nodes
      SET parentId = ?, sortOrder = ?, updatedAt = datetime('now')
      WHERE id = ?
    `).run(input.parentId, nextSort, node.id);
    recordHistory(db, {
      nodeId: node.id,
      action: "move",
      actorUserId: input.actorUserId,
      fromParentId,
      toParentId: input.parentId,
      metadata: { sortOrder: nextSort },
    });
  });
  transaction();

  const moved = requireNode(db, node.id);
  return {
    ...moved,
    title: readNodeTitle(db, moved),
    childCount: countChildren(db, moved.id),
    access: resolveKnowledgeNodeAccess(moved.id, input.actorUserId, db),
  };
}

function readNodeTitle(db: Database.Database, node: NodeRow): string {
  if (node.resourceType === "notebook") {
    return (db.prepare("SELECT name FROM notebooks WHERE id = ?").get(node.resourceId) as { name: string } | undefined)?.name || "未命名文件夹";
  }
  if (node.resourceType === "note") {
    return (db.prepare("SELECT title FROM notes WHERE id = ?").get(node.resourceId) as { title: string } | undefined)?.title || "无标题笔记";
  }
  if (node.resourceType === "mindmap") {
    return (db.prepare("SELECT title FROM mindmaps WHERE id = ?").get(node.resourceId) as { title: string } | undefined)?.title || node.resourceId;
  }
  return node.resourceId;
}

function countChildren(db: Database.Database, nodeId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS count FROM knowledge_tree_nodes WHERE parentId = ? AND isDeleted = 0")
    .get(nodeId) as { count: number }).count || 0);
}

function descendantNodes(db: Database.Database, nodeId: string): NodeRow[] {
  return db.prepare(`
    WITH RECURSIVE subtree(id, depth) AS (
      SELECT id, 0 FROM knowledge_tree_nodes WHERE id = ?
      UNION ALL
      SELECT child.id, subtree.depth + 1
      FROM knowledge_tree_nodes child
      JOIN subtree ON child.parentId = subtree.id
      WHERE child.isDeleted = 0
    )
    SELECT node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
           node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
           node.isExpanded, node.isDeleted, node.deletedAt, node.createdAt, node.updatedAt
    FROM subtree JOIN knowledge_tree_nodes node ON node.id = subtree.id
    ORDER BY subtree.depth DESC
  `).all(nodeId) as NodeRow[];
}

function softDeleteBusinessNode(db: Database.Database, node: NodeRow): void {
  if (node.resourceType === "note") {
    db.prepare(`
      UPDATE notes SET isTrashed = 1, trashedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id = ? AND isTrashed = 0
    `).run(node.resourceId);
  } else if (node.resourceType === "notebook") {
    db.prepare(`
      UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id = ? AND isDeleted = 0
    `).run(node.resourceId);
  }
  db.prepare(`
    UPDATE knowledge_tree_nodes
    SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
    WHERE id = ?
  `).run(node.id);
}

export function deleteKnowledgeNode(input: {
  actorUserId: string;
  nodeId: string;
  mode: KnowledgeDeleteMode;
  db?: Database.Database;
}): { success: true; mode: KnowledgeDeleteMode; affectedNodeIds: string[]; promotedNodeIds: string[] } {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const node = requireNode(db, input.nodeId);
  requireCapability(db, node.id, input.actorUserId, "canDelete");

  const affected: string[] = [];
  const promoted: string[] = [];
  const transaction = db.transaction(() => {
    if (input.mode === "promote") {
      const children = db.prepare(`
        SELECT id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
               resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
        FROM knowledge_tree_nodes WHERE parentId = ? AND isDeleted = 0 ORDER BY sortOrder, id
      `).all(node.id) as NodeRow[];
      let order = maxSortOrder(db, node.scopeKey, node.parentId);
      for (const child of children) {
        syncBusinessParent(db, child, node.parentId);
        db.prepare("UPDATE knowledge_tree_nodes SET parentId = ?, sortOrder = ?, updatedAt = datetime('now') WHERE id = ?")
          .run(node.parentId, order++, child.id);
        promoted.push(child.id);
      }
      softDeleteBusinessNode(db, node);
      affected.push(node.id);
      recordHistory(db, {
        nodeId: node.id,
        action: "delete_promote",
        actorUserId: input.actorUserId,
        fromParentId: node.parentId,
        metadata: { promotedNodeIds: promoted },
      });
    } else {
      const nodes = descendantNodes(db, node.id);
      for (const current of nodes) {
        softDeleteBusinessNode(db, current);
        affected.push(current.id);
      }
      recordHistory(db, {
        nodeId: node.id,
        action: "delete_subtree",
        actorUserId: input.actorUserId,
        fromParentId: node.parentId,
        metadata: { affectedNodeIds: affected },
      });
    }
  });
  transaction();
  return { success: true, mode: input.mode, affectedNodeIds: affected, promotedNodeIds: promoted };
}

export function restoreKnowledgeNode(input: {
  actorUserId: string;
  nodeId: string;
  includeSubtree?: boolean;
  db?: Database.Database;
}): { success: true; restoredNodeIds: string[] } {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const node = requireNode(db, input.nodeId, true);
  const access = resolveKnowledgeNodeAccess(node.parentId || node.id, input.actorUserId, db);
  if (!access.capabilities.canDelete && node.userId !== input.actorUserId) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有恢复权限", { required: "canDelete" });
  }
  const nodes = input.includeSubtree === false ? [node] : descendantNodes(db, node.id);
  const restored: string[] = [];
  const transaction = db.transaction(() => {
    for (const current of nodes.reverse()) {
      if (current.resourceType === "note") {
        db.prepare("UPDATE notes SET isTrashed = 0, trashedAt = NULL, updatedAt = datetime('now') WHERE id = ?")
          .run(current.resourceId);
      } else if (current.resourceType === "notebook") {
        db.prepare("UPDATE notebooks SET isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now') WHERE id = ?")
          .run(current.resourceId);
      }
      db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now') WHERE id = ?")
        .run(current.id);
      restored.push(current.id);
    }
    recordHistory(db, {
      nodeId: node.id,
      action: "restore",
      actorUserId: input.actorUserId,
      toParentId: node.parentId,
      metadata: { restoredNodeIds: restored },
    });
  });
  transaction();
  return { success: true, restoredNodeIds: restored };
}

export function reorderKnowledgeNodes(input: {
  actorUserId: string;
  items: Array<{ id: string; sortOrder: number }>;
  db?: Database.Database;
}): { success: true; updated: number } {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  if (input.items.length > 500) throw new KnowledgeTreeError("KNOWLEDGE_REORDER_TOO_LARGE", 400, "单次最多排序 500 个节点");
  let updated = 0;
  const transaction = db.transaction(() => {
    for (const item of input.items) {
      const node = requireNode(db, item.id);
      requireCapability(db, node.id, input.actorUserId, "canMove");
      const sortOrder = Math.max(0, Math.trunc(Number(item.sortOrder) || 0));
      db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?")
        .run(sortOrder, node.id);
      if (node.resourceType === "note") {
        db.prepare("UPDATE notes SET sortOrder = ? WHERE id = ?").run(sortOrder, node.resourceId);
      } else if (node.resourceType === "notebook") {
        db.prepare("UPDATE notebooks SET sortOrder = ? WHERE id = ?").run(sortOrder, node.resourceId);
      }
      recordHistory(db, {
        nodeId: node.id,
        action: "reorder",
        actorUserId: input.actorUserId,
        fromParentId: node.parentId,
        toParentId: node.parentId,
        metadata: { sortOrder },
      });
      updated++;
    }
  });
  transaction();
  return { success: true, updated };
}

export function listKnowledgeTreeHistory(nodeId: string, userId: string, db: Database.Database = getDb()) {
  ensureKnowledgeTreeTables(db);
  requireCapability(db, nodeId, userId, "canView");
  return db.prepare(`
    SELECT history.*, actor.username AS actorUsername, target.username AS targetUsername
    FROM knowledge_tree_history history
    LEFT JOIN users actor ON actor.id = history.actorUserId
    LEFT JOIN users target ON target.id = history.targetUserId
    WHERE history.nodeId = ?
    ORDER BY history.createdAt DESC, history.id DESC
    LIMIT 200
  `).all(nodeId);
}
