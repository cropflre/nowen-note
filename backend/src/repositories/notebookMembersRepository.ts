/**
 * Notebook Members Repository
 *
 * 职责：
 * - 封装 notebook_members 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { getDatabaseAdapter } from "../db/runtime";

function getAdapter() {
  return getDatabaseAdapter();
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
      .prepare("SELECT role FROM notebook_members WHERE \"notebookId\" = ? AND \"userId\" = ? AND status != 'removed'")
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
    allowDownload?: number | boolean;
    allowReshare?: number | boolean;
    source?: "manual" | "invite_link" | "publication";
    sourceId?: string | null;
  }): void {
    const db = getDb();
    const source = input.source || "manual";
    const allowDownload = input.allowDownload === false || input.allowDownload === 0 ? 0 : 1;
    const allowReshare = input.allowReshare === true || input.allowReshare === 1 ? 1 : 0;
    db.prepare(
      `INSERT INTO notebook_members (
         id, "notebookId", "userId", role, status, "allowDownload", "allowReshare", source, "sourceId", "invitedBy"
       ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
       ON CONFLICT("notebookId", "userId") DO UPDATE SET
         role = CASE
           WHEN notebook_members.source = 'manual' AND excluded.source != 'manual' THEN notebook_members.role
           ELSE excluded.role
         END,
         status = 'active',
         "allowDownload" = CASE
           WHEN notebook_members.source = 'manual' AND excluded.source != 'manual' THEN notebook_members."allowDownload"
           ELSE excluded."allowDownload"
         END,
         "allowReshare" = CASE
           WHEN notebook_members.source = 'manual' AND excluded.source != 'manual' THEN notebook_members."allowReshare"
           ELSE excluded."allowReshare"
         END,
         source = CASE
           WHEN notebook_members.source = 'manual' AND excluded.source != 'manual' THEN notebook_members.source
           ELSE excluded.source
         END,
         "sourceId" = CASE
           WHEN notebook_members.source = 'manual' AND excluded.source != 'manual' THEN notebook_members."sourceId"
           ELSE excluded."sourceId"
         END,
         "invitedBy" = CASE
           WHEN notebook_members.source = 'manual' AND excluded.source != 'manual' THEN notebook_members."invitedBy"
           ELSE excluded."invitedBy"
         END,
         "updatedAt" = datetime('now')`
    ).run(
      input.id, input.notebookId, input.userId, input.role, allowDownload, allowReshare,
      source, input.sourceId || null, input.invitedBy,
    );
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
      "UPDATE notebook_members SET role = ?, \"updatedAt\" = datetime('now') WHERE \"notebookId\" = ? AND \"userId\" = ?"
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
      "UPDATE notebook_members SET status = 'removed', \"updatedAt\" = datetime('now') WHERE \"notebookId\" = ? AND \"userId\" = ?"
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
    allowDownload: number;
    allowReshare: number;
    source: string;
    sourceId: string | null;
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
        `SELECT nm.id, nm."notebookId", nm."userId", nm.role, nm.status, nm."allowDownload", nm."allowReshare", nm.source, nm."sourceId", nm."invitedBy",
                nm."createdAt", nm."updatedAt",
                u.username, u.email, u."displayName", u."avatarUrl"
         FROM notebook_members nm
         JOIN users u ON u.id = nm."userId"
         WHERE nm."notebookId" = ? AND nm.status != 'removed'
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
    allowDownload: number;
    allowReshare: number;
    source: string;
    sourceId: string | null;
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
        `SELECT nm.id, nm."notebookId", nm."userId", nm.role, nm.status, nm."allowDownload", nm."allowReshare", nm.source, nm."sourceId", nm."invitedBy",
                nm."createdAt", nm."updatedAt",
                u.username, u.email, u."displayName", u."avatarUrl"
         FROM notebook_members nm
         JOIN users u ON u.id = nm."userId"
         WHERE nm."notebookId" = ? AND nm."userId" = ?`
      )
      .get(notebookId, userId) as any;
  },

  removeBySource(source: "invite_link" | "publication", sourceId: string): number {
    const result = getDb().prepare(
      `UPDATE notebook_members SET status = 'removed', "updatedAt" = datetime('now')
       WHERE source = ? AND "sourceId" = ? AND status = 'active'`,
    ).run(source, sourceId);
    return result.changes;
  },

  restrictBySource(
    source: "invite_link" | "publication",
    sourceId: string,
    input: { role: "viewer" | "editor"; allowDownload: boolean; allowReshare: boolean },
  ): number {
    const result = getDb().prepare(
      `UPDATE notebook_members
       SET role = CASE WHEN ? = 'viewer' AND role = 'editor' THEN 'viewer' ELSE role END,
           "allowDownload" = ?, "allowReshare" = ?, "updatedAt" = datetime('now')
       WHERE source = ? AND "sourceId" = ? AND status = 'active'`,
    ).run(input.role, input.allowDownload ? 1 : 0, input.allowReshare ? 1 : 0, source, sourceId);
    return result.changes;
  },

  async getRoleAsync(notebookId: string, userId: string): Promise<{ role: string } | undefined> {
    return getAdapter().queryOne<{ role: string }>(
      "SELECT role FROM notebook_members WHERE \"notebookId\" = ? AND \"userId\" = ? AND status != 'removed'",
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
      `INSERT INTO notebook_members (id, "notebookId", "userId", role, status, "invitedBy")
       VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT("notebookId", "userId") DO UPDATE SET
         role = excluded.role,
         status = 'active',
         "updatedAt" = datetime('now')`,
      [input.id, input.notebookId, input.userId, input.role, input.invitedBy],
    );
  },

  async updateRoleAsync(notebookId: string, userId: string, role: string): Promise<void> {
    await getAdapter().execute(
      "UPDATE notebook_members SET role = ?, \"updatedAt\" = datetime('now') WHERE \"notebookId\" = ? AND \"userId\" = ?",
      [role, notebookId, userId],
    );
  },

  async removeAsync(notebookId: string, userId: string): Promise<void> {
    await getAdapter().execute(
      "UPDATE notebook_members SET status = 'removed', \"updatedAt\" = datetime('now') WHERE \"notebookId\" = ? AND \"userId\" = ?",
      [notebookId, userId],
    );
  },

  async listByNotebookAsync(notebookId: string): Promise<Array<{
    id: string;
    notebookId: string;
    userId: string;
    role: string;
    status: string;
    allowDownload: number;
    allowReshare: number;
    source: string;
    sourceId: string | null;
    invitedBy: string | null;
    createdAt: string;
    updatedAt: string;
    username: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  }>> {
    return getAdapter().queryMany<any>(
      `SELECT nm.id, nm."notebookId", nm."userId", nm.role, nm.status, nm."allowDownload", nm."allowReshare", nm.source, nm."sourceId", nm."invitedBy",
              nm."createdAt", nm."updatedAt",
              u.username, u.email, u."displayName", u."avatarUrl"
       FROM notebook_members nm
       JOIN users u ON u.id = nm."userId"
       WHERE nm."notebookId" = ? AND nm.status != 'removed'
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
    allowDownload: number;
    allowReshare: number;
    source: string;
    sourceId: string | null;
    invitedBy: string | null;
    createdAt: string;
    updatedAt: string;
    username: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  } | undefined> {
    return getAdapter().queryOne<any>(
      `SELECT nm.id, nm."notebookId", nm."userId", nm.role, nm.status, nm."allowDownload", nm."allowReshare", nm.source, nm."sourceId", nm."invitedBy",
              nm."createdAt", nm."updatedAt",
              u.username, u.email, u."displayName", u."avatarUrl"
       FROM notebook_members nm
       JOIN users u ON u.id = nm."userId"
       WHERE nm."notebookId" = ? AND nm."userId" = ?`,
      [notebookId, userId],
    );
  },
};
