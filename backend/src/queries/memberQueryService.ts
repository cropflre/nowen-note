/**
 * Member Query Service
 *
 * 职责：
 * - 承接成员 / 权限相关复杂查询（notebook_members / notes / notebooks JOIN）
 * - 不处理 HTTP / 鉴权 / 业务日志
 * - 使用 getDb() 获取数据库实例
 * - 返回与原 SQL 一致的数据结构
 *
 * 设计原则：
 * - 单表 CRUD 仍由各 Repository 负责
 * - 跨表权限查询归 QueryService
 * - notebook-permissions.ts 作为服务层薄包装，内部调用 memberQueryService
 * - 未来 PostgreSQL 接入时，只需为 QueryService 提供 pg 实现
 */

import { getDb } from "../db/schema";

export const memberQueryService = {
  /**
   * 获取用户在指定笔记本中的角色。
   *
   * 单表查询 notebook_members，条件：notebookId + userId + status='active'。
   * 用于 resolveNotebookMemberPermission。
   *
   * @param notebookId 笔记本 ID
   * @param userId 用户 ID
   * @returns 角色字符串，或 undefined
   */
  getNotebookMemberRole(
    notebookId: string,
    userId: string,
  ): { role: string } | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT role
           FROM notebook_members
          WHERE notebookId = ? AND userId = ? AND status = 'active'`,
      )
      .get(notebookId, userId) as { role: string } | undefined;
  },

  /**
   * 获取用户在指定笔记所属笔记本中的角色。
   *
   * 跨 notes + notebook_members JOIN。
   * 用于 resolveNoteNotebookMemberPermission。
   *
   * @param noteId 笔记 ID
   * @param userId 用户 ID
   * @returns 角色字符串，或 undefined
   */
  getNoteNotebookMemberRole(
    noteId: string,
    userId: string,
  ): { role: string } | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT nm.role
           FROM notes n
           JOIN notebook_members nm ON nm.notebookId = n.notebookId
          WHERE n.id = ? AND nm.userId = ? AND nm.status = 'active'`,
      )
      .get(noteId, userId) as { role: string } | undefined;
  },

  /**
   * 列出用户参与的共享笔记本 ID 列表。
   *
   * 跨 notebook_members + notebooks JOIN。
   * 当前无调用者，迁移以保持 notebook-permissions.ts 内部 SQL 清零。
   *
   * @param userId 用户 ID
   * @returns 笔记本 ID 列表
   */
  listSharedNotebookIds(userId: string): string[] {
    const db = getDb();
    return (
      db
        .prepare(
          `SELECT nm.notebookId
             FROM notebook_members nm
             JOIN notebooks nb ON nb.id = nm.notebookId
            WHERE nm.userId = ?
              AND nm.status = 'active'
              AND nb.userId <> ?
              AND nb.isDeleted = 0
            ORDER BY nb.updatedAt DESC, nb.id ASC`,
        )
        .all(userId, userId) as { notebookId: string }[]
    ).map((row) => row.notebookId);
  },
};
