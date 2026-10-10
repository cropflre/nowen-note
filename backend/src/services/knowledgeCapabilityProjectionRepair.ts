import type Database from "better-sqlite3";

import { getDb } from "../db/schema.js";
import {
  synchronizeLegacyNoteHierarchy,
  synchronizeLegacyNotebookHierarchy,
} from "./legacyKnowledgeHierarchy.js";

export type RepairableKnowledgeResourceType = "note" | "notebook";

type ProjectionRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  isDeleted: number;
};

type NoteRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  notebookId: string;
  isTrashed: number;
};

type NotebookRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  isDeleted: number;
};

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

function sameNullable(a: string | null, b: string | null): boolean {
  return (a || null) === (b || null);
}

function readProjectionRows(
  db: Database.Database,
  resourceType: RepairableKnowledgeResourceType,
  resourceId: string,
): ProjectionRow[] {
  return db.prepare(`
    SELECT id, userId, workspaceId, scopeKey, parentId, isDeleted
    FROM knowledge_tree_nodes
    WHERE resourceType = ? AND resourceId = ?
    ORDER BY isDeleted ASC, updatedAt DESC
  `).all(resourceType, resourceId) as ProjectionRow[];
}

function parentIsValid(
  db: Database.Database,
  parentId: string | null,
  expectedScopeKey: string,
): boolean {
  if (!parentId) return true;
  const parent = db.prepare(`
    SELECT scopeKey, isDeleted
    FROM knowledge_tree_nodes
    WHERE id = ?
  `).get(parentId) as { scopeKey: string; isDeleted: number } | undefined;
  return !!parent && parent.scopeKey === expectedScopeKey && parent.isDeleted === 0;
}

function projectionMatches(
  db: Database.Database,
  projection: ProjectionRow,
  authoritative: {
    userId: string;
    workspaceId: string | null;
    isDeleted: number;
  },
): boolean {
  const expectedScopeKey = scopeKey(authoritative.userId, authoritative.workspaceId);
  return projection.userId === authoritative.userId
    && sameNullable(projection.workspaceId, authoritative.workspaceId)
    && projection.scopeKey === expectedScopeKey
    && projection.isDeleted === authoritative.isDeleted
    && parentIsValid(db, projection.parentId, expectedScopeKey);
}

/**
 * 修复旧导入/恢复链路可能遗留的 knowledge_tree_nodes 投影不一致。
 *
 * 这里只同步业务资源已经确认存在时的结构元数据，随后调用方必须重新执行原有
 * capability resolver；本函数本身绝不授予权限，也不会覆盖正常的 ACL / deny /
 * restricted 策略。存在重复投影时不自动猜测删除哪一条，保持拒绝并交给数据巡检。
 */
export function repairKnowledgeResourceProjectionIfStale(
  resourceType: RepairableKnowledgeResourceType,
  resourceId: string,
  actorUserId: string,
  db: Database.Database = getDb(),
): boolean {
  const projections = readProjectionRows(db, resourceType, resourceId);
  if (projections.length > 1) return false;

  try {
    if (resourceType === "note") {
      const note = db.prepare(`
        SELECT id, userId, workspaceId, notebookId, isTrashed
        FROM notes
        WHERE id = ?
      `).get(resourceId) as NoteRow | undefined;
      if (!note) return false;

      const projection = projections[0];
      if (projection && projectionMatches(db, projection, {
        userId: note.userId,
        workspaceId: note.workspaceId,
        isDeleted: note.isTrashed ? 1 : 0,
      })) {
        return false;
      }

      // 先修物理 notebook 的投影，避免 note 在回挂失效父节点时触发结构守卫。
      synchronizeLegacyNotebookHierarchy({
        db,
        notebookId: note.notebookId,
        actorUserId,
        reason: "metadata",
        parentMode: "preserve",
      });
      synchronizeLegacyNoteHierarchy({
        db,
        noteId: note.id,
        actorUserId,
        reason: "metadata",
        parentMode: "preserve",
      });
      return true;
    }

    const notebook = db.prepare(`
      SELECT id, userId, workspaceId, isDeleted
      FROM notebooks
      WHERE id = ?
    `).get(resourceId) as NotebookRow | undefined;
    if (!notebook) return false;

    const projection = projections[0];
    if (projection && projectionMatches(db, projection, {
      userId: notebook.userId,
      workspaceId: notebook.workspaceId,
      isDeleted: notebook.isDeleted ? 1 : 0,
    })) {
      return false;
    }

    synchronizeLegacyNotebookHierarchy({
      db,
      notebookId: notebook.id,
      actorUserId,
      reason: "metadata",
      parentMode: "preserve",
    });
    return true;
  } catch (error) {
    console.warn(
      `[knowledge-capability] failed to repair stale ${resourceType} projection ${resourceId}:`,
      error,
    );
    return false;
  }
}
