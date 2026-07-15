/**
 * Member Query Service
 *
 * 职责：
 * - 承接成员 / 权限相关复杂查询（notebook_members / notebook_acl_overrides / notes / notebooks）
 * - 不处理 HTTP / 鉴权 / 业务日志
 * - 数据库访问统一委托给 Repository 边界
 * - 返回与原 SQL 一致的数据结构
 *
 * 设计原则：
 * - 单表 CRUD 仍由各 Repository 负责
 * - 跨表权限查询归 QueryService
 * - notebook-permissions.ts 作为服务层薄包装，内部调用 memberQueryService
 * - PostgreSQL 同步/异步双库实现由 #249 统一推进
 */

import { memberQueryRepository } from "../repositories/memberQueryRepository";

export interface NotebookMemberAccessRow {
  role: string;
  sourceNotebookId: string;
  depth: number;
  source: "override" | "member";
  allowDownload?: number;
  allowReshare?: number;
}

export function ensureNotebookAclOverridesTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS notebook_acl_overrides (
      notebookId TEXT NOT NULL,
      userId TEXT NOT NULL,
      permission TEXT NOT NULL CHECK(permission IN ('none', 'read', 'comment', 'write', 'manage')),
      allowDownload INTEGER NOT NULL DEFAULT 1,
      allowReshare INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (notebookId, userId),
      FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notebook_acl_user
      ON notebook_acl_overrides(userId, notebookId);
  `);
}

function getNotebookMemberAccess(notebookId: string, userId: string): NotebookMemberAccessRow | undefined {
  ensureNotebookAclOverridesTable();
  const db = getDb();
  return db.prepare(`
    WITH RECURSIVE ancestors(id, parentId, depth) AS (
      SELECT id, parentId, 0
      FROM notebooks
      WHERE id = ? AND isDeleted = 0
      UNION ALL
      SELECT parent.id, parent.parentId, ancestors.depth + 1
      FROM notebooks parent
      JOIN ancestors ON parent.id = ancestors.parentId
      WHERE parent.isDeleted = 0
    ), candidates AS (
      SELECT
        acl.permission AS role,
        ancestors.id AS sourceNotebookId,
        ancestors.depth AS depth,
        'override' AS source,
        acl.allowDownload AS allowDownload,
        acl.allowReshare AS allowReshare,
        0 AS sourcePriority
      FROM ancestors
      JOIN notebook_acl_overrides acl
        ON acl.notebookId = ancestors.id AND acl.userId = ?

      UNION ALL

      SELECT
        nm.role AS role,
        ancestors.id AS sourceNotebookId,
        ancestors.depth AS depth,
        'member' AS source,
        1 AS allowDownload,
        CASE WHEN nm.role = 'owner' THEN 1 ELSE 0 END AS allowReshare,
        1 AS sourcePriority
      FROM ancestors
      JOIN notebook_members nm
        ON nm.notebookId = ancestors.id
       AND nm.userId = ?
       AND nm.status = 'active'
    )
    SELECT role, sourceNotebookId, depth, source, allowDownload, allowReshare
    FROM candidates
    ORDER BY depth ASC, sourcePriority ASC
    LIMIT 1
  `).get(notebookId, userId, userId) as NotebookMemberAccessRow | undefined;
}

export const memberQueryService = {
  /** 获取用户在指定笔记本中的角色。 */
  getNotebookMemberRole(
    notebookId: string,
    userId: string,
  ): { role: string } | undefined {
    return memberQueryRepository.getNotebookMemberRole(notebookId, userId);
  },

  /** 获取用户在指定笔记所属笔记本中的角色。 */
  getNoteNotebookMemberRole(
    noteId: string,
    userId: string,
  ): { role: string } | undefined {
    return memberQueryRepository.getNoteNotebookMemberRole(noteId, userId);
  },

  /** 列出用户参与的共享笔记本 ID。 */
  listSharedNotebookIds(userId: string): string[] {
    return memberQueryRepository.listSharedNotebookIds(userId);
  },
};
