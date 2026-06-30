/**
 * Notebook Members Repository
 *
 * 职责：
 * - 封装 notebook_members 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

function getAdapter() {
  return new SqliteAdapter(getDb());
}

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

  /**
   * 获取笔记本成员列表（含用户信息）。
   *
   * @param notebookId 笔记本 ID
   * @returns 成员列表
   */
  listByNotebook(notebookId: string): Array<{
    id: string;
    notebookId: string;
    userId: string;
    role: string;
    status: string;
    invitedBy: string | null;
    createdAt: string;
    updatedAt: string;
    username: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  }> {
    const db = getDb();
    return db
      .prepare(
        `SELECT nm.id, nm.notebookId, nm.userId, nm.role, nm.status, nm.invitedBy,
                nm.createdAt, nm.updatedAt,
                u.username, u.email, u.displayName, u.avatarUrl
         FROM notebook_members nm
         JOIN users u ON u.id = nm.userId
         WHERE nm.notebookId = ? AND nm.status != 'removed'
         ORDER BY CASE nm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                  u.username ASC`
      )
      .all(notebookId) as any[];
  },

  /**
   * 获取单个成员信息（含用户信息）。
   *
   * @param notebookId 笔记本 ID
   * @param userId 用户 ID
   * @returns 成员信息，或 undefined
   */
  getByNotebookAndUser(notebookId: string, userId: string): {
    id: string;
    notebookId: string;
    userId: string;
    role: string;
    status: string;
    invitedBy: string | null;
    createdAt: string;
    updatedAt: string;
    username: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  } | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT nm.id, nm.notebookId, nm.userId, nm.role, nm.status, nm.invitedBy,
                nm.createdAt, nm.updatedAt,
                u.username, u.email, u.displayName, u.avatarUrl
         FROM notebook_members nm
         JOIN users u ON u.id = nm.userId
         WHERE nm.notebookId = ? AND nm.userId = ?`
      )
      .get(notebookId, userId) as any;
  },

  async getRoleAsync(notebookId: string, userId: string): Promise<{ role: string } | undefined> {
    return getAdapter().queryOne<{ role: string }>(
      "SELECT role FROM notebook_members WHERE notebookId = ? AND userId = ? AND status != 'removed'",
      [notebookId, userId],
    );
  },

  async upsertAsync(input: {
    id: string;
    notebookId: string;
    userId: string;
    role: string;
    invitedBy: string | null;
  }): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO notebook_members (id, notebookId, userId, role, status, invitedBy)
       VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT(notebookId, userId) DO UPDATE SET
         role = excluded.role,
         status = 'active',
         updatedAt = datetime('now')`,
      [input.id, input.notebookId, input.userId, input.role, input.invitedBy],
    );
  },

  async updateRoleAsync(notebookId: string, userId: string, role: string): Promise<void> {
    await getAdapter().execute(
      "UPDATE notebook_members SET role = ?, updatedAt = datetime('now') WHERE notebookId = ? AND userId = ?",
      [role, notebookId, userId],
    );
  },

  async removeAsync(notebookId: string, userId: string): Promise<void> {
    await getAdapter().execute(
      "UPDATE notebook_members SET status = 'removed', updatedAt = datetime('now') WHERE notebookId = ? AND userId = ?",
      [notebookId, userId],
    );
  },

  async listByNotebookAsync(notebookId: string): Promise<Array<{
    id: string;
    notebookId: string;
    userId: string;
    role: string;
    status: string;
    invitedBy: string | null;
    createdAt: string;
    updatedAt: string;
    username: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  }>> {
    return getAdapter().queryMany<any>(
      `SELECT nm.id, nm.notebookId, nm.userId, nm.role, nm.status, nm.invitedBy,
              nm.createdAt, nm.updatedAt,
              u.username, u.email, u.displayName, u.avatarUrl
       FROM notebook_members nm
       JOIN users u ON u.id = nm.userId
       WHERE nm.notebookId = ? AND nm.status != 'removed'
       ORDER BY CASE nm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                u.username ASC`,
      [notebookId],
    );
  },

  async getByNotebookAndUserAsync(notebookId: string, userId: string): Promise<{
    id: string;
    notebookId: string;
    userId: string;
    role: string;
    status: string;
    invitedBy: string | null;
    createdAt: string;
    updatedAt: string;
    username: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  } | undefined> {
    return getAdapter().queryOne<any>(
      `SELECT nm.id, nm.notebookId, nm.userId, nm.role, nm.status, nm.invitedBy,
              nm.createdAt, nm.updatedAt,
              u.username, u.email, u.displayName, u.avatarUrl
       FROM notebook_members nm
       JOIN users u ON u.id = nm.userId
       WHERE nm.notebookId = ? AND nm.userId = ?`,
      [notebookId, userId],
    );
  },
};
