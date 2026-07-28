import type Database from "better-sqlite3";
import { getDb } from "../db/schema";
import { ensureNotebookAclOverridesTable } from "../queries/memberQueryService";

export interface TransferNotebookOwnershipInput {
  notebookId: string;
  actorUserId: string;
  targetUserId: string;
}

export interface TransferNotebookOwnershipResult {
  notebookId: string;
  previousOwnerId: string;
  newOwnerId: string;
  notebookCount: number;
  noteCount: number;
  attachmentCount: number;
  detachedFromParent: boolean;
}

export class NotebookOwnershipTransferError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "NotebookOwnershipTransferError";
    this.code = code;
    this.status = status;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/**
 * 将个人空间目录及完整子树转交给一个现有协作者。
 *
 * 约束：
 * - 仅个人空间目录支持转交；团队空间的所有权由工作区角色管理。
 * - 仅真实所有者可以发起，拥有 manage 权限的协作者不能代替所有者操作。
 * - 接收人必须已经是该目录的直接协作者，避免误输账号导致不可逆转交。
 * - 若目录原本位于另一个目录下，转交时自动提升为新所有者个人空间的根目录，
 *   避免产生跨用户 parentId 链。
 */
export function transferNotebookOwnership(
  input: TransferNotebookOwnershipInput,
  db: Database.Database = getDb(),
): TransferNotebookOwnershipResult {
  const notebookId = String(input.notebookId || "").trim();
  const actorUserId = String(input.actorUserId || "").trim();
  const targetUserId = String(input.targetUserId || "").trim();

  if (!actorUserId) throw new NotebookOwnershipTransferError("UNAUTHENTICATED", "未登录", 401);
  if (!notebookId || !targetUserId) {
    throw new NotebookOwnershipTransferError("INVALID_ARGUMENT", "notebookId 和 targetUserId 必填");
  }

  const root = db.prepare(
    `SELECT id, userId, workspaceId, parentId, isDeleted
       FROM notebooks
      WHERE id = ?`,
  ).get(notebookId) as {
    id: string;
    userId: string;
    workspaceId: string | null;
    parentId: string | null;
    isDeleted: number;
  } | undefined;

  if (!root || root.isDeleted) {
    throw new NotebookOwnershipTransferError("NOTEBOOK_NOT_FOUND", "目录不存在或已删除", 404);
  }
  if (root.workspaceId) {
    throw new NotebookOwnershipTransferError(
      "WORKSPACE_NOTEBOOK_TRANSFER_UNSUPPORTED",
      "团队空间目录由工作区角色管理，暂不支持单独转交所有者",
    );
  }
  if (root.userId !== actorUserId) {
    throw new NotebookOwnershipTransferError("OWNER_REQUIRED", "只有目录所有者可以转交", 403);
  }
  if (targetUserId === actorUserId) {
    throw new NotebookOwnershipTransferError("TARGET_IS_OWNER", "接收人已经是当前所有者");
  }

  const target = db.prepare(
    "SELECT id FROM users WHERE id = ? AND isDisabled = 0",
  ).get(targetUserId) as { id: string } | undefined;
  if (!target) {
    throw new NotebookOwnershipTransferError("TARGET_USER_NOT_FOUND", "接收用户不存在或已停用", 404);
  }

  const targetMembership = db.prepare(
    `SELECT role, status
       FROM notebook_members
      WHERE notebookId = ? AND userId = ?`,
  ).get(notebookId, targetUserId) as { role: string; status: string } | undefined;
  if (!targetMembership || targetMembership.status !== "active") {
    throw new NotebookOwnershipTransferError(
      "TARGET_NOT_COLLABORATOR",
      "请先将接收人添加为该目录的协作者",
    );
  }

  const treeRows = db.prepare(
    `WITH RECURSIVE subtree(id, parentId) AS (
       SELECT id, parentId FROM notebooks WHERE id = ? AND isDeleted = 0
       UNION ALL
       SELECT child.id, child.parentId
         FROM notebooks child
         JOIN subtree parent ON child.parentId = parent.id
        WHERE child.isDeleted = 0
     )
     SELECT id, parentId FROM subtree`,
  ).all(notebookId) as Array<{ id: string; parentId: string | null }>;

  if (treeRows.length === 0) {
    throw new NotebookOwnershipTransferError("NOTEBOOK_NOT_FOUND", "目录不存在或已删除", 404);
  }

  const notebookIds = treeRows.map((row) => row.id);
  const notebookIdSet = new Set(notebookIds);
  const internalEdges = treeRows.filter(
    (row): row is { id: string; parentId: string } =>
      Boolean(row.parentId && notebookIdSet.has(row.parentId)),
  );
  const notebookMarks = placeholders(notebookIds.length);
  const noteIds = (db.prepare(
    `SELECT id FROM notes WHERE notebookId IN (${notebookMarks})`,
  ).all(...notebookIds) as Array<{ id: string }>).map((row) => row.id);
  const noteMarks = noteIds.length > 0 ? placeholders(noteIds.length) : "";

  let attachmentCount = 0;
  const detachedFromParent = Boolean(root.parentId);
  ensureNotebookAclOverridesTable();

  const execute = db.transaction(() => {
    // Tree guards intentionally reject a half-transferred tree. Temporarily detach the subtree,
    // move resources and ownership while every node is a root, then restore only internal edges.
    db.prepare(
      `UPDATE notebooks
          SET parentId = NULL, updatedAt = datetime('now')
        WHERE id IN (${notebookMarks}) AND parentId IS NOT NULL`,
    ).run(...notebookIds);

    if (noteIds.length > 0) {
      db.prepare(
        `UPDATE notes
            SET userId = ?, updatedAt = datetime('now')
          WHERE id IN (${noteMarks})`,
      ).run(targetUserId, ...noteIds);

      const attachmentResult = db.prepare(
        `UPDATE attachments
            SET userId = ?, workspaceId = NULL
          WHERE noteId IN (${noteMarks})`,
      ).run(targetUserId, ...noteIds);
      attachmentCount = attachmentResult.changes;
    }

    db.prepare(
      `UPDATE notebooks
          SET userId = ?, updatedAt = datetime('now')
        WHERE id IN (${notebookMarks})`,
    ).run(targetUserId, ...notebookIds);

    const restoreParent = db.prepare(
      "UPDATE notebooks SET parentId = ?, updatedAt = datetime('now') WHERE id = ?",
    );
    for (const edge of internalEdges) {
      restoreParent.run(edge.parentId, edge.id);
    }

    db.prepare(
      `DELETE FROM notebook_acl_overrides
        WHERE notebookId IN (${notebookMarks})
          AND userId IN (?, ?)`,
    ).run(...notebookIds, actorUserId, targetUserId);

    db.prepare(
      `UPDATE notebook_members
          SET role = 'editor', status = 'active', updatedAt = datetime('now')
        WHERE notebookId IN (${notebookMarks})
          AND userId = ?`,
    ).run(...notebookIds, actorUserId);

    db.prepare(
      `INSERT INTO notebook_members (
         id, notebookId, userId, role, status, allowDownload, allowReshare,
         source, sourceId, invitedBy
       ) VALUES (?, ?, ?, 'editor', 'active', 1, 0, 'manual', NULL, ?)
       ON CONFLICT(notebookId, userId) DO UPDATE SET
         role = 'editor', status = 'active', allowDownload = 1, allowReshare = 0,
         source = 'manual', sourceId = NULL, invitedBy = excluded.invitedBy,
         updatedAt = datetime('now')`,
    ).run(`${notebookId}:${actorUserId}`, notebookId, actorUserId, targetUserId);

    db.prepare(
      `INSERT INTO notebook_members (
         id, notebookId, userId, role, status, allowDownload, allowReshare,
         source, sourceId, invitedBy
       ) VALUES (?, ?, ?, 'owner', 'active', 1, 1, 'manual', NULL, ?)
       ON CONFLICT(notebookId, userId) DO UPDATE SET
         role = 'owner', status = 'active', allowDownload = 1, allowReshare = 1,
         source = 'manual', sourceId = NULL, invitedBy = excluded.invitedBy,
         updatedAt = datetime('now')`,
    ).run(`${notebookId}:${targetUserId}`, notebookId, targetUserId, actorUserId);
  });

  execute();

  return {
    notebookId,
    previousOwnerId: actorUserId,
    newOwnerId: targetUserId,
    notebookCount: notebookIds.length,
    noteCount: noteIds.length,
    attachmentCount,
    detachedFromParent,
  };
}
