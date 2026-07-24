/**
 * Note ACL Repository
 *
 * 职责：
 * - 封装 note_acl 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { getDatabaseAdapter } from "../db/runtime";

function getAdapter() {
  return getDatabaseAdapter();
}

/** note_acl 记录 */
export interface NoteAclRecord {
  noteId: string;
  userId: string;
  permission: string;
  grantedBy: string | null;
  createdAt: string;
}

export const noteAclRepository = {
  /**
   * 获取用户对笔记的权限。
   *
   * @param noteId 笔记 ID
   * @param userId 用户 ID
   * @returns 权限记录，或 undefined
   */
  getPermission(noteId: string, userId: string): { permission: string } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT permission FROM note_acl WHERE noteId = ? AND userId = ?")
      .get(noteId, userId) as { permission: string } | undefined;
  },

  /**
   * 删除用户在工作区内的所有笔记权限。
   *
   * @param userId 用户 ID
   * @param workspaceId 工作区 ID
   */
  deleteByUserAndWorkspace(userId: string, workspaceId: string): void {
    const db = getDb();
    db.prepare(
      "DELETE FROM note_acl WHERE userId = ? AND noteId IN (SELECT id FROM notes WHERE workspaceId = ?)"
    ).run(userId, workspaceId);
  },

  /**
   * 删除指定笔记和用户的权限。
   *
   * @param noteId 笔记 ID
   * @param userId 用户 ID
   */
  deleteByNoteAndUser(noteId: string, userId: string): void {
    const db = getDb();
    db.prepare("DELETE FROM note_acl WHERE noteId = ? AND userId = ?").run(noteId, userId);
  },

  /**
   * 将用户的权限转移给另一个用户。
   *
   * @param fromUserId 源用户 ID
   * @param toUserId 目标用户 ID
   * @returns 更新的行数
   */
  transferOwnership(fromUserId: string, toUserId: string): number {
    const db = getDb();
    const result = db.prepare("UPDATE note_acl SET userId = ? WHERE userId = ?").run(toUserId, fromUserId);
    return result.changes;
  },

  /**
   * 获取两个用户共同有权限的笔记 ID 列表。
   *
   * @param userId1 用户 1 ID
   * @param userId2 用户 2 ID
   * @returns 笔记 ID 列表
   */
  listCommonNotes(userId1: string, userId2: string): string[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT noteId FROM note_acl
         WHERE userId = ? AND noteId IN (SELECT noteId FROM note_acl WHERE userId = ?)`
      )
      .all(userId1, userId2) as { noteId: string }[];
    return rows.map((r) => r.noteId);
  },

  async getPermissionAsync(noteId: string, userId: string): Promise<{ permission: string } | undefined> {
    return getAdapter().queryOne<{ permission: string }>(
      "SELECT permission FROM note_acl WHERE noteId = ? AND userId = ?",
      [noteId, userId],
    );
  },

  async deleteByUserAndWorkspaceAsync(userId: string, workspaceId: string): Promise<void> {
    await getAdapter().execute(
      "DELETE FROM note_acl WHERE userId = ? AND noteId IN (SELECT id FROM notes WHERE workspaceId = ?)",
      [userId, workspaceId],
    );
  },

  async deleteByNoteAndUserAsync(noteId: string, userId: string): Promise<void> {
    await getAdapter().execute(
      "DELETE FROM note_acl WHERE noteId = ? AND userId = ?",
      [noteId, userId],
    );
  },

  async transferOwnershipAsync(fromUserId: string, toUserId: string): Promise<number> {
    const result = await getAdapter().execute(
      "UPDATE note_acl SET userId = ? WHERE userId = ?",
      [toUserId, fromUserId],
    );
    return result.changes;
  },

  async listCommonNotesAsync(userId1: string, userId2: string): Promise<string[]> {
    const rows = await getAdapter().queryMany<{ noteId: string }>(
      `SELECT noteId FROM note_acl
       WHERE userId = ? AND noteId IN (SELECT noteId FROM note_acl WHERE userId = ?)`,
      [userId1, userId2],
    );
    return rows.map((r) => r.noteId);
  },
};
