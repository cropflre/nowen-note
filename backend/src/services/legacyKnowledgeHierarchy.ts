import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";

export type LegacyHierarchyResourceType = "notebook" | "note";
export type LegacyHierarchyReason = "create" | "move" | "reorder" | "delete" | "restore" | "metadata";
export type LegacyParentMode = "resource" | "preserve";

interface KnowledgeNodeRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  nodeType: "folder" | "note" | "markdown" | "word";
  resourceType: LegacyHierarchyResourceType;
  resourceId: string;
  sortOrder: number;
  isExpanded: number;
  isDeleted: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NotebookRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  sortOrder: number;
  isExpanded: number;
  isDeleted: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NoteRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  notebookId: string;
  contentFormat: string;
  note_type: string | null;
  sortOrder: number;
  isTrashed: number;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyHierarchyConsistencyIssue {
  code:
    | "MISSING_NODE"
    | "DUPLICATE_NODE"
    | "SCOPE_MISMATCH"
    | "PARENT_MISSING"
    | "PARENT_SCOPE_MISMATCH"
    | "NOTEBOOK_PARENT_MISMATCH"
    | "NOTE_CONTAINER_MISMATCH";
  resourceType: LegacyHierarchyResourceType;
  resourceId: string;
  nodeId?: string;
  detail?: string;
}

export class LegacyKnowledgeHierarchyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

function ensureKnowledgeTreeStorage(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_tree_nodes'",
  ).get() as { found: number } | undefined;
  // Old databases and isolated route tests may not have loaded the knowledge-tree runtime bootstrap.
  // Only initialize when the table is absent. If tests intentionally drop legacy sync triggers while
  // keeping the table, this guard does not recreate those triggers.
  if (!exists) ensureKnowledgeTreeTables(db);
}

function expectedNodeId(resourceType: LegacyHierarchyResourceType, resourceId: string): string {
  return `${resourceType}:${resourceId}`;
}

function readNodesForResource(
  db: Database.Database,
  resourceType: LegacyHierarchyResourceType,
  resourceId: string,
): KnowledgeNodeRow[] {
  return db.prepare(`
    SELECT id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
           resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    FROM knowledge_tree_nodes
    WHERE resourceType = ? AND resourceId = ?
    ORDER BY createdAt, id
  `).all(resourceType, resourceId) as KnowledgeNodeRow[];
}

function requireUniqueNode(
  db: Database.Database,
  resourceType: LegacyHierarchyResourceType,
  resourceId: string,
): KnowledgeNodeRow {
  const nodes = readNodesForResource(db, resourceType, resourceId);
  if (nodes.length === 0) {
    throw new LegacyKnowledgeHierarchyError(
      "LEGACY_KNOWLEDGE_NODE_MISSING",
      "业务资源缺少统一内容树节点",
      { resourceType, resourceId },
    );
  }
  if (nodes.length > 1) {
    throw new LegacyKnowledgeHierarchyError(
      "LEGACY_KNOWLEDGE_NODE_DUPLICATE",
      "业务资源存在重复的统一内容树节点",
      { resourceType, resourceId, nodeIds: nodes.map((node) => node.id) },
    );
  }
  return nodes[0];
}

function readNotebook(db: Database.Database, notebookId: string): NotebookRow {
  const row = db.prepare(`
    SELECT id, userId, workspaceId, parentId, sortOrder, isExpanded, isDeleted,
           deletedAt, createdAt, updatedAt
    FROM notebooks WHERE id = ?
  `).get(notebookId) as NotebookRow | undefined;
  if (!row) {
    throw new LegacyKnowledgeHierarchyError(
      "LEGACY_NOTEBOOK_NOT_FOUND",
      "笔记本不存在",
      { notebookId },
    );
  }
  return row;
}

function readNote(db: Database.Database, noteId: string): NoteRow {
  const row = db.prepare(`
    SELECT id, userId, workspaceId, notebookId, contentFormat, note_type, sortOrder,
           isTrashed, trashedAt, createdAt, updatedAt
    FROM notes WHERE id = ?
  `).get(noteId) as NoteRow | undefined;
  if (!row) {
    throw new LegacyKnowledgeHierarchyError(
      "LEGACY_NOTE_NOT_FOUND",
      "笔记不存在",
      { noteId },
    );
  }
  return row;
}

function noteNodeType(note: NoteRow): "note" | "markdown" | "word" {
  if (note.note_type === "word") return "word";
  if (note.contentFormat === "markdown") return "markdown";
  return "note";
}

function validParent(
  db: Database.Database,
  parentId: string | null,
  expectedScope: string,
): string | null {
  if (!parentId) return null;
  const parent = db.prepare(`
    SELECT id, scopeKey, isDeleted FROM knowledge_tree_nodes WHERE id = ?
  `).get(parentId) as { id: string; scopeKey: string; isDeleted: number } | undefined;
  if (!parent || parent.scopeKey !== expectedScope || parent.isDeleted === 1) return null;
  return parent.id;
}

function recordHistory(
  db: Database.Database,
  input: {
    nodeId: string;
    actorUserId: string;
    reason: LegacyHierarchyReason;
    fromParentId?: string | null;
    toParentId?: string | null;
    metadata?: Record<string, unknown>;
  },
): void {
  if (input.reason === "metadata") return;
  const action = input.reason === "delete"
    ? "delete_subtree"
    : input.reason;
  db.prepare(`
    INSERT INTO knowledge_tree_history (
      id, nodeId, action, actorUserId, fromParentId, toParentId, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    input.nodeId,
    action,
    input.actorUserId,
    input.fromParentId ?? null,
    input.toParentId ?? null,
    input.metadata ? JSON.stringify({ source: "legacy-api", ...input.metadata }) : JSON.stringify({ source: "legacy-api" }),
  );
}

function updateNode(
  db: Database.Database,
  input: {
    node: KnowledgeNodeRow;
    userId: string;
    workspaceId: string | null;
    parentId: string | null;
    parentMode: LegacyParentMode;
    nodeType: KnowledgeNodeRow["nodeType"];
    sortOrder: number;
    isExpanded: number;
    isDeleted: number;
    deletedAt: string | null;
    updatedAt: string;
  },
): KnowledgeNodeRow {
  const key = scopeKey(input.userId, input.workspaceId);
  let nextParentId = input.node.parentId;
  if (input.parentMode === "resource") {
    nextParentId = input.parentId;
  } else if (nextParentId && !validParent(db, nextParentId, key)) {
    nextParentId = input.parentId;
  }

  if (nextParentId) {
    const parent = db.prepare("SELECT scopeKey FROM knowledge_tree_nodes WHERE id = ?")
      .get(nextParentId) as { scopeKey: string } | undefined;
    if (!parent || parent.scopeKey !== key) {
      throw new LegacyKnowledgeHierarchyError(
        "LEGACY_KNOWLEDGE_PARENT_SCOPE_MISMATCH",
        "内容节点与目标父节点不属于同一空间",
        { nodeId: input.node.id, parentId: nextParentId, scopeKey: key },
      );
    }
  }

  const parentChanged = input.node.parentId !== nextParentId;
  if (parentChanged) {
    db.prepare(`
      UPDATE knowledge_tree_nodes
      SET userId = ?, workspaceId = ?, scopeKey = ?, parentId = ?, nodeType = ?,
          sortOrder = ?, isExpanded = ?, isDeleted = ?, deletedAt = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      input.userId,
      input.workspaceId,
      key,
      nextParentId,
      input.nodeType,
      input.sortOrder,
      input.isExpanded,
      input.isDeleted,
      input.deletedAt,
      input.updatedAt,
      input.node.id,
    );
  } else {
    // Avoid writing parentId when a whole deleted subtree is being synchronized. The structural
    // guard intentionally rejects assigning a deleted parent, even when the relationship is unchanged.
    db.prepare(`
      UPDATE knowledge_tree_nodes
      SET userId = ?, workspaceId = ?, scopeKey = ?, nodeType = ?, sortOrder = ?,
          isExpanded = ?, isDeleted = ?, deletedAt = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      input.userId,
      input.workspaceId,
      key,
      input.nodeType,
      input.sortOrder,
      input.isExpanded,
      input.isDeleted,
      input.deletedAt,
      input.updatedAt,
      input.node.id,
    );
  }

  return requireUniqueNode(db, input.node.resourceType, input.node.resourceId);
}

function ensureNotebookNode(
  db: Database.Database,
  notebookId: string,
  visited = new Set<string>(),
  cache?: Map<string, KnowledgeNodeRow>,
): KnowledgeNodeRow {
  const cached = cache?.get(notebookId);
  if (cached) return cached;
  if (visited.has(notebookId)) {
    throw new LegacyKnowledgeHierarchyError(
      "LEGACY_NOTEBOOK_CYCLE",
      "旧笔记本层级存在循环",
      { notebookId },
    );
  }
  visited.add(notebookId);
  const notebook = readNotebook(db, notebookId);
  const key = scopeKey(notebook.userId, notebook.workspaceId);
  const parentNode = notebook.parentId ? ensureNotebookNode(db, notebook.parentId, visited, cache) : null;
  const initialParentId = parentNode && parentNode.scopeKey === key && parentNode.isDeleted === 0
    ? parentNode.id
    : null;

  db.prepare(`
    INSERT OR IGNORE INTO knowledge_tree_nodes (
      id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType, resourceId,
      sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, 'folder', 'notebook', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    expectedNodeId("notebook", notebook.id),
    notebook.userId,
    notebook.workspaceId,
    key,
    initialParentId,
    notebook.id,
    notebook.sortOrder || 0,
    notebook.isExpanded ?? 1,
    notebook.isDeleted || 0,
    notebook.deletedAt,
    notebook.createdAt,
    notebook.updatedAt,
  );
  const node = requireUniqueNode(db, "notebook", notebook.id);
  cache?.set(notebook.id, node);
  return node;
}

function ensureNoteNodeFromRow(
  db: Database.Database,
  note: NoteRow,
  notebookNode: KnowledgeNodeRow,
): KnowledgeNodeRow {
  const key = scopeKey(note.userId, note.workspaceId);
  const initialParentId = notebookNode.scopeKey === key && notebookNode.isDeleted === 0
    ? notebookNode.id
    : null;
  db.prepare(`
    INSERT OR IGNORE INTO knowledge_tree_nodes (
      id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType, resourceId,
      sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, 'note', ?, ?, 1, ?, ?, ?, ?)
  `).run(
    expectedNodeId("note", note.id),
    note.userId,
    note.workspaceId,
    key,
    initialParentId,
    noteNodeType(note),
    note.id,
    note.sortOrder || 0,
    note.isTrashed || 0,
    note.trashedAt,
    note.createdAt,
    note.updatedAt,
  );
  return requireUniqueNode(db, "note", note.id);
}

function ensureNoteNode(db: Database.Database, noteId: string): KnowledgeNodeRow {
  const note = readNote(db, noteId);
  const notebookNode = ensureNotebookNode(db, note.notebookId);
  return ensureNoteNodeFromRow(db, note, notebookNode);
}

export function synchronizeLegacyNotebookHierarchy(input: {
  db: Database.Database;
  notebookId: string;
  actorUserId: string;
  reason: LegacyHierarchyReason;
  parentMode?: LegacyParentMode;
}): KnowledgeNodeRow {
  ensureKnowledgeTreeStorage(input.db);
  const notebook = readNotebook(input.db, input.notebookId);
  const parentNode = notebook.parentId ? ensureNotebookNode(input.db, notebook.parentId) : null;
  const node = ensureNotebookNode(input.db, notebook.id);
  const before = { parentId: node.parentId, sortOrder: node.sortOrder, isDeleted: node.isDeleted };
  const updated = updateNode(input.db, {
    node,
    userId: notebook.userId,
    workspaceId: notebook.workspaceId,
    parentId: parentNode?.id || null,
    parentMode: input.parentMode || "resource",
    nodeType: "folder",
    sortOrder: notebook.sortOrder || 0,
    isExpanded: notebook.isExpanded ?? 1,
    isDeleted: notebook.isDeleted || 0,
    deletedAt: notebook.deletedAt,
    updatedAt: notebook.updatedAt,
  });
  recordHistory(input.db, {
    nodeId: updated.id,
    actorUserId: input.actorUserId,
    reason: input.reason,
    fromParentId: before.parentId,
    toParentId: updated.parentId,
    metadata: {
      resourceType: "notebook",
      resourceId: notebook.id,
      previousSortOrder: before.sortOrder,
      sortOrder: updated.sortOrder,
      previousDeleted: before.isDeleted,
      isDeleted: updated.isDeleted,
    },
  });
  return updated;
}

export function synchronizeLegacyNoteHierarchy(input: {
  db: Database.Database;
  noteId: string;
  actorUserId: string;
  reason: LegacyHierarchyReason;
  parentMode?: LegacyParentMode;
}): KnowledgeNodeRow {
  ensureKnowledgeTreeStorage(input.db);
  const note = readNote(input.db, input.noteId);
  const notebookNode = ensureNotebookNode(input.db, note.notebookId);
  const node = ensureNoteNode(input.db, note.id);
  const before = { parentId: node.parentId, sortOrder: node.sortOrder, isDeleted: node.isDeleted };
  const updated = updateNode(input.db, {
    node,
    userId: note.userId,
    workspaceId: note.workspaceId,
    parentId: notebookNode.id,
    parentMode: input.parentMode || "preserve",
    nodeType: noteNodeType(note),
    sortOrder: note.sortOrder || 0,
    isExpanded: node.isExpanded ?? 1,
    isDeleted: note.isTrashed || 0,
    deletedAt: note.trashedAt,
    updatedAt: note.updatedAt,
  });
  recordHistory(input.db, {
    nodeId: updated.id,
    actorUserId: input.actorUserId,
    reason: input.reason,
    fromParentId: before.parentId,
    toParentId: updated.parentId,
    metadata: {
      resourceType: "note",
      resourceId: note.id,
      physicalNotebookId: note.notebookId,
      previousSortOrder: before.sortOrder,
      sortOrder: updated.sortOrder,
      previousDeleted: before.isDeleted,
      isDeleted: updated.isDeleted,
    },
  });
  return updated;
}

/**
 * 批量导入专用同步入口。同一批次缓存目录节点，避免每篇笔记都重复递归父目录；
 * 普通增删改仍走单资源同步入口，保持既有行为不变。
 */
export function synchronizeLegacyImportHierarchy(input: {
  db: Database.Database;
  notebookIds: string[];
  createdNotebookIds?: string[];
  noteIds: string[];
  actorUserId: string;
}): { notebooks: number; notes: number } {
  ensureKnowledgeTreeStorage(input.db);
  const notebookCache = new Map<string, KnowledgeNodeRow>();
  const uniqueNotebookIds = Array.from(new Set(input.notebookIds.filter(Boolean)));
  const createdNotebookIds = new Set(input.createdNotebookIds || []);
  const uniqueNoteIds = Array.from(new Set(input.noteIds.filter(Boolean)));

  for (const notebookId of uniqueNotebookIds) {
    const updated = synchronizeLegacyNotebookHierarchy({
      db: input.db,
      notebookId,
      actorUserId: input.actorUserId,
      reason: createdNotebookIds.has(notebookId) ? "create" : "metadata",
      parentMode: "resource",
    });
    notebookCache.set(notebookId, updated);
  }

  for (const noteId of uniqueNoteIds) {
    const note = readNote(input.db, noteId);
    const notebookNode = ensureNotebookNode(input.db, note.notebookId, new Set<string>(), notebookCache);
    const node = ensureNoteNodeFromRow(input.db, note, notebookNode);
    const before = { parentId: node.parentId, sortOrder: node.sortOrder, isDeleted: node.isDeleted };
    const updated = updateNode(input.db, {
      node,
      userId: note.userId,
      workspaceId: note.workspaceId,
      parentId: notebookNode.id,
      parentMode: "resource",
      nodeType: noteNodeType(note),
      sortOrder: note.sortOrder || 0,
      isExpanded: node.isExpanded ?? 1,
      isDeleted: note.isTrashed || 0,
      deletedAt: note.trashedAt,
      updatedAt: note.updatedAt,
    });
    recordHistory(input.db, {
      nodeId: updated.id,
      actorUserId: input.actorUserId,
      reason: "create",
      fromParentId: before.parentId,
      toParentId: updated.parentId,
      metadata: {
        resourceType: "note",
        resourceId: note.id,
        physicalNotebookId: note.notebookId,
        previousSortOrder: before.sortOrder,
        sortOrder: updated.sortOrder,
        previousDeleted: before.isDeleted,
        isDeleted: updated.isDeleted,
      },
    });
  }

  return { notebooks: uniqueNotebookIds.length, notes: uniqueNoteIds.length };
}

function nearestNotebookResourceId(db: Database.Database, nodeId: string | null): string | null {
  let cursor = nodeId;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) return null;
    visited.add(cursor);
    const row = db.prepare(`
      SELECT parentId, resourceType, resourceId FROM knowledge_tree_nodes WHERE id = ?
    `).get(cursor) as { parentId: string | null; resourceType: string; resourceId: string } | undefined;
    if (!row) return null;
    if (row.resourceType === "notebook") return row.resourceId;
    cursor = row.parentId;
  }
  return null;
}

export function auditLegacyKnowledgeHierarchy(input: {
  db: Database.Database;
  userId?: string;
  workspaceId?: string | null;
}): LegacyHierarchyConsistencyIssue[] {
  const issues: LegacyHierarchyConsistencyIssue[] = [];
  const filters: string[] = [];
  const params: unknown[] = [];
  if (input.workspaceId !== undefined) {
    if (input.workspaceId === null) filters.push("workspaceId IS NULL");
    else { filters.push("workspaceId = ?"); params.push(input.workspaceId); }
  }
  if (input.userId) { filters.push("userId = ?"); params.push(input.userId); }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const notebooks = input.db.prepare(`
    SELECT id, userId, workspaceId, parentId FROM notebooks ${where}
  `).all(...params) as Array<Pick<NotebookRow, "id" | "userId" | "workspaceId" | "parentId">>;
  const notes = input.db.prepare(`
    SELECT id, userId, workspaceId, notebookId FROM notes ${where}
  `).all(...params) as Array<Pick<NoteRow, "id" | "userId" | "workspaceId" | "notebookId">>;

  for (const resource of [...notebooks.map((row) => ({ ...row, resourceType: "notebook" as const })),
    ...notes.map((row) => ({ ...row, resourceType: "note" as const }))]) {
    const nodes = readNodesForResource(input.db, resource.resourceType, resource.id);
    if (nodes.length === 0) {
      issues.push({ code: "MISSING_NODE", resourceType: resource.resourceType, resourceId: resource.id });
      continue;
    }
    if (nodes.length > 1) {
      issues.push({
        code: "DUPLICATE_NODE",
        resourceType: resource.resourceType,
        resourceId: resource.id,
        detail: nodes.map((node) => node.id).join(","),
      });
      continue;
    }
    const node = nodes[0];
    const key = scopeKey(resource.userId, resource.workspaceId);
    if (node.scopeKey !== key || (node.workspaceId || null) !== (resource.workspaceId || null)) {
      issues.push({ code: "SCOPE_MISMATCH", resourceType: resource.resourceType, resourceId: resource.id, nodeId: node.id });
    }
    if (node.parentId) {
      const parent = input.db.prepare("SELECT scopeKey FROM knowledge_tree_nodes WHERE id = ?")
        .get(node.parentId) as { scopeKey: string } | undefined;
      if (!parent) {
        issues.push({ code: "PARENT_MISSING", resourceType: resource.resourceType, resourceId: resource.id, nodeId: node.id });
      } else if (parent.scopeKey !== node.scopeKey) {
        issues.push({ code: "PARENT_SCOPE_MISMATCH", resourceType: resource.resourceType, resourceId: resource.id, nodeId: node.id });
      }
    }
    if (resource.resourceType === "notebook") {
      const expectedParent = resource.parentId ? expectedNodeId("notebook", resource.parentId) : null;
      if (node.parentId !== expectedParent) {
        issues.push({ code: "NOTEBOOK_PARENT_MISMATCH", resourceType: "notebook", resourceId: resource.id, nodeId: node.id });
      }
    } else {
      const containerId = nearestNotebookResourceId(input.db, node.parentId);
      if (containerId !== resource.notebookId) {
        issues.push({
          code: "NOTE_CONTAINER_MISMATCH",
          resourceType: "note",
          resourceId: resource.id,
          nodeId: node.id,
          detail: `tree=${containerId || "null"}, projection=${resource.notebookId}`,
        });
      }
    }
  }
  return issues;
}
