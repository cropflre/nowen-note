import type Database from "better-sqlite3";
import { hasKnowledgeCapability, resolveKnowledgeNodeAccess } from "../services/knowledgeCapabilities.js";
import { SyncError } from "./errors.js";
import { resolveAuthorizedScope } from "./scope.js";

interface TreeRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  nodeType: string;
  resourceType: string;
  resourceId: string;
  sortOrder: number;
  isDeleted: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeTreeSnapshotItem {
  entityId: string;
  payload: Record<string, unknown>;
}

/**
 * Prepare the tree phase of a future negotiated Snapshot. Business entities must be sent first.
 * Never silently flatten a missing parent or omit a file node: either would lose the user's tree.
 * This is deliberately not exposed by /snapshot until every client can apply the same contract.
 */
export function prepareKnowledgeTreeSnapshot(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
): KnowledgeTreeSnapshotItem[] {
  resolveAuthorizedScope(db, userId, workspaceId ? `workspace:${workspaceId}` : "personal", "read");
  const rows = db.prepare(`
    SELECT id, userId, workspaceId, parentId, nodeType, resourceType, resourceId,
           sortOrder, isDeleted, deletedAt, createdAt, updatedAt
    FROM knowledge_tree_nodes
    WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?)
      AND id NOT GLOB 'notebook:__nowen_root_documents__:*'
  `).all(workspaceId, workspaceId, userId) as TreeRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visible = new Map<string, boolean>();
  const canView = (row: TreeRow): boolean => {
    if (!workspaceId) return true;
    let allowed = visible.get(row.id);
    if (allowed === undefined) {
      allowed = hasKnowledgeCapability(
        resolveKnowledgeNodeAccess(row.id, userId, db, { includeDeleted: true }), "canView",
      );
      visible.set(row.id, allowed);
    }
    return allowed;
  };
  const ordered: TreeRow[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (row: TreeRow): void => {
    if (state.get(row.id) === "done") return;
    if (state.get(row.id) === "visiting") {
      throw new SyncError("MISSING_DEPENDENCY", "知识树存在循环，不能生成结构快照");
    }
    state.set(row.id, "visiting");
    if (row.parentId) {
      const parent = byId.get(row.parentId);
      if (!parent || !canView(parent)) {
        throw new SyncError("MISSING_DEPENDENCY", "知识树父节点缺失或不可见，不能生成结构快照");
      }
      visit(parent);
    }
    const table = { notebook: "notebooks", note: "notes", mindmap: "mindmaps" }[row.resourceType];
    const resourceExists = row.resourceType === "file"
        ? db.prepare(`SELECT 1 FROM attachments a JOIN notes n ON n.id = a.noteId
          WHERE a.id = ? AND a.workspaceId IS ? AND n.workspaceId IS ?
            AND (? IS NOT NULL OR a.userId = ?)`)
          .get(row.resourceId, workspaceId, workspaceId, workspaceId, userId)
      : table && db.prepare(`SELECT 1 FROM ${table}
          WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)`)
          .get(row.resourceId, workspaceId, workspaceId, userId);
    if (!resourceExists) {
      throw new SyncError("MISSING_DEPENDENCY", "知识树业务资源缺失，不能生成结构快照");
    }
    state.set(row.id, "done");
    ordered.push(row);
  };
  for (const row of rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (canView(row)) visit(row);
  }
  return ordered.map(({ id, ...payload }) => ({ entityId: id, payload: { id, ...payload } }));
}

export function knowledgeTreeSnapshotPage(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
  afterId: string | null,
  limit: number,
): { items: KnowledgeTreeSnapshotItem[]; nextCursor: string | null } {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new SyncError("INVALID_PAYLOAD", "知识树快照分页大小无效");
  }
  const ordered = prepareKnowledgeTreeSnapshot(db, userId, workspaceId);
  const cursorIndex = afterId === null ? -1 : ordered.findIndex((item) => item.entityId === afterId);
  if (afterId !== null && cursorIndex < 0) {
    throw new SyncError("INVALID_PAYLOAD", "知识树快照游标已失效，需重新开始");
  }
  const items = ordered.slice(cursorIndex + 1, cursorIndex + 1 + limit);
  const hasMore = cursorIndex + 1 + items.length < ordered.length;
  return { items, nextCursor: hasMore ? items[items.length - 1].entityId : null };
}
