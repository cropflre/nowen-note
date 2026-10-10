import type Database from "better-sqlite3";
import { hasKnowledgeCapability, resolveKnowledgeNodeAccess } from "../services/knowledgeCapabilities.js";
import { SyncError } from "./errors.js";
import { resolveAuthorizedScope } from "./scope.js";

interface TreeRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  resourceType: string;
  resourceId: string;
  sortOrder: number;
  isDeleted: number;
}

interface Structure {
  parentId: string | null;
  sortOrder: number;
  isDeleted: number;
}

export interface KnowledgeTreeStructureMutation {
  userId: string;
  workspaceId: string | null;
  entityId: string;
  operation: "upsert" | "delete";
  payload?: Record<string, unknown>;
}

function readNode(db: Database.Database, id: string): TreeRow | undefined {
  return db.prepare(`
    SELECT id, userId, workspaceId, scopeKey, parentId, resourceType,
           resourceId, sortOrder, isDeleted
    FROM knowledge_tree_nodes WHERE id = ?
  `).get(id) as TreeRow | undefined;
}

function structureOf(row: TreeRow): Structure {
  return { parentId: row.parentId, sortOrder: row.sortOrder, isDeleted: row.isDeleted };
}

function sameStructure(a: Structure, b: Structure): boolean {
  return a.parentId === b.parentId && a.sortOrder === b.sortOrder && a.isDeleted === b.isDeleted;
}

function parseStructure(payload: Record<string, unknown>, prefix: "" | "base"): Structure | null {
  const parentKey = prefix ? "baseParentId" : "parentId";
  const sortKey = prefix ? "baseSortOrder" : "sortOrder";
  const deletedKey = prefix ? "baseIsDeleted" : "isDeleted";
  if (prefix && !(parentKey in payload) && !(sortKey in payload) && !(deletedKey in payload)) {
    return null; // Initial projection; the business entity creates the same node first.
  }
  const parentId = payload[parentKey];
  const sortOrder = payload[sortKey];
  const isDeleted = payload[deletedKey];
  if ((parentId !== null && (typeof parentId !== "string" || !parentId))
    || !Number.isSafeInteger(sortOrder) || (sortOrder as number) < 0
    || (isDeleted !== 0 && isDeleted !== 1)) {
    throw new SyncError("INVALID_PAYLOAD", "知识树结构字段无效");
  }
  return { parentId, sortOrder, isDeleted } as Structure;
}

function assertNodeAccess(
  db: Database.Database, nodeId: string, userId: string,
  capability: "canView" | "canMove" | "canDelete",
): void {
  const access = resolveKnowledgeNodeAccess(nodeId, userId, db, { includeDeleted: true });
  if (!hasKnowledgeCapability(access, capability)) {
    throw new SyncError("SCOPE_FORBIDDEN", "没有修改知识树节点的权限");
  }
}

/**
 * Apply only structural fields. The business entity is synchronized separately and its
 * projection must already exist. This function is kept outside the active entity set until
 * snapshot, pull/apply and subscription negotiation can consume the same contract.
 */
export function applyKnowledgeTreeStructureMutation(
  db: Database.Database,
  input: KnowledgeTreeStructureMutation,
): void {
  const scopeKey = input.workspaceId ? `workspace:${input.workspaceId}` : "personal";
  const scope = resolveAuthorizedScope(db, input.userId, scopeKey, "write");
  const node = readNode(db, input.entityId);
  const treeScope = input.workspaceId ? scope.scopeKey : `personal:${input.userId}`;

  if (input.operation === "delete") {
    if (!node || node.scopeKey !== treeScope) return;
    assertNodeAccess(db, node.id, input.userId, "canDelete");
    const table = { notebook: "notebooks", note: "notes", mindmap: "mindmaps", file: "files" }[node.resourceType];
    if (!table) throw new SyncError("INVALID_PAYLOAD", "不支持的知识树资源类型");
    if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(node.resourceId)) {
      throw new SyncError("MISSING_DEPENDENCY", "请先同步资源删除，再删除知识树投影");
    }
    db.prepare("DELETE FROM knowledge_tree_nodes WHERE id = ?").run(node.id);
    return;
  }

  const payload = input.payload;
  if (!payload || payload.id !== input.entityId || !node || node.scopeKey !== treeScope) {
    throw new SyncError("MISSING_DEPENDENCY", "知识树对应的资源尚未同步或不在当前空间");
  }
  if (payload.resourceType !== node.resourceType || payload.resourceId !== node.resourceId) {
    throw new SyncError("INVALID_PAYLOAD", "知识树资源身份不可变更");
  }
  const desired = parseStructure(payload, "")!;
  if (payload.deletedAt !== null && payload.deletedAt !== undefined
    && typeof payload.deletedAt !== "string") {
    throw new SyncError("INVALID_PAYLOAD", "知识树删除时间无效");
  }
  const current = structureOf(node);
  assertNodeAccess(db, node.id, input.userId, "canView");
  if (sameStructure(current, desired)) return;

  const base = parseStructure(payload, "base");
  if (!base || !sameStructure(current, base)) {
    throw new SyncError("VERSION_CONFLICT", "知识树位置或回收站状态已在另一台设备上变更");
  }
  if (desired.parentId !== current.parentId || desired.sortOrder !== current.sortOrder) {
    assertNodeAccess(db, node.id, input.userId, "canMove");
  }
  if (desired.isDeleted !== current.isDeleted) {
    assertNodeAccess(db, node.id, input.userId, "canDelete");
  }
  if (desired.parentId) {
    const parent = readNode(db, desired.parentId);
    if (!parent || parent.isDeleted) throw new SyncError("MISSING_DEPENDENCY", "目标父节点尚未同步");
    if (parent.scopeKey !== treeScope) throw new SyncError("SCOPE_FORBIDDEN", "不能跨空间移动知识树节点");
    const access = resolveKnowledgeNodeAccess(parent.id, input.userId, db);
    if (!hasKnowledgeCapability(access, "canCreate") && !hasKnowledgeCapability(access, "canMove")) {
      throw new SyncError("SCOPE_FORBIDDEN", "没有移动到目标位置的权限");
    }
  }
  if (desired.parentId === node.id || (desired.parentId && db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM knowledge_tree_nodes WHERE parentId = ?
      UNION ALL
      SELECT child.id FROM knowledge_tree_nodes child
      JOIN descendants parent ON child.parentId = parent.id
    )
    SELECT 1 FROM descendants WHERE id = ? LIMIT 1
  `).get(node.id, desired.parentId))) {
    throw new SyncError("INVALID_PAYLOAD", "知识树不能形成循环");
  }

  db.prepare(`
    UPDATE knowledge_tree_nodes
    SET parentId = ?, sortOrder = ?, isDeleted = ?, deletedAt = ?, updatedAt = datetime('now')
    WHERE id = ? AND scopeKey = ?
  `).run(desired.parentId, desired.sortOrder, desired.isDeleted,
    desired.isDeleted ? payload.deletedAt ?? new Date().toISOString() : null,
    node.id, treeScope);
}
