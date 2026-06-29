/**
 * Notebook Members Repository
 *
 * 职责：
 * - 封装 notebook_members 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";

export const notebookMembersRepository = {
  /**
   * 获取成员角色。
   *
   * @param notebookId 笔记本 ID
   * @param userId 用户 ID
   * @returns 成员角色，或 undefined
   */
  getRole(notebookId: string, userId: string): { role: string } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT role FROM notebook_members WHERE notebookId = ? AND userId = ? AND status != 'removed'")
      .get(notebookId, userId) as { role: string } | undefined;
  },

  /**
   * 创建或更新成员。
   *
   * @param input 成员数据
   */
  upsert(input: {
    id: string;
    notebookId: string;
    userId: string;
    role: string;
    invitedBy: string | null;
  }): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO notebook_members (id, notebookId, userId, role, status, invitedBy)
       VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT(notebookId, userId) DO UPDATE SET
         role = excluded.role,
         status = 'active',
         updatedAt = datetime('now')`
    ).run(input.id, input.notebookId, input.userId, input.role, input.invitedBy);
  },

  /**
   * 更新成员角色。
   *
   * @param notebookId 笔记本 ID
   * @param userId 用户 ID
   * @param role 新角色
   */
  updateRole(notebookId: string, userId: string, role: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE notebook_members SET role = ?, updatedAt = datetime('now') WHERE notebookId = ? AND userId = ?"
    ).run(role, notebookId, userId);
  },

  /**
   * 移除成员（软删除）。
   *
   * @param notebookId 笔记本 ID
   * @param userId 用户 ID
   */
  remove(notebookId: string, userId: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE notebook_members SET status = 'removed', updatedAt = datetime('now') WHERE notebookId = ? AND userId = ?"
    ).run(notebookId, userId);
  },
};
