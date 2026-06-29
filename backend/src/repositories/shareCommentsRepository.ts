/**
 * Share Comments Repository
 *
 * 职责：
 * - 封装 share_comments 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";

export const shareCommentsRepository = {
  /**
   * 获取评论详情（用于权限校验）。
   *
   * @param commentId 评论 ID
   * @returns 评论记录，或 undefined
   */
  getById(commentId: string): { id: string; userId: string | null } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT id, userId FROM share_comments WHERE id = ?")
      .get(commentId) as { id: string; userId: string | null } | undefined;
  },

  /**
   * 获取评论的解决状态。
   *
   * @param commentId 评论 ID
   * @returns 评论记录，或 undefined
   */
  getResolved(commentId: string): { isResolved: number } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT isResolved FROM share_comments WHERE id = ?")
      .get(commentId) as { isResolved: number } | undefined;
  },

  /**
   * 更新评论的解决状态。
   *
   * @param commentId 评论 ID
   * @param isResolved 是否解决
   */
  updateResolved(commentId: string, isResolved: number): void {
    const db = getDb();
    db.prepare("UPDATE share_comments SET isResolved = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(isResolved, commentId);
  },

  /**
   * 删除评论。
   *
   * @param commentId 评论 ID
   */
  delete(commentId: string): void {
    const db = getDb();
    db.prepare("DELETE FROM share_comments WHERE id = ?").run(commentId);
  },

  /**
   * 统计用户的评论数量。
   *
   * @param userId 用户 ID
   * @returns 评论数量
   */
  countByUser(userId: string): number {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) as c FROM share_comments WHERE userId = ?").get(userId) as { c: number };
    return row.c;
  },

  /**
   * 转移用户（用户迁移时使用）。
   *
   * @param fromUserId 源用户 ID
   * @param toUserId 目标用户 ID
   * @returns 更新的行数
   */
  transferOwnership(fromUserId: string, toUserId: string): number {
    const db = getDb();
    const result = db.prepare("UPDATE share_comments SET userId = ? WHERE userId = ?").run(toUserId, fromUserId);
    return result.changes;
  },

  /**
   * 创建评论。
   *
   * @param input 评论数据
   */
  create(input: {
    id: string;
    noteId: string;
    userId: string | null;
    guestName?: string;
    guestIpHash?: string;
    parentId?: string | null;
    content: string;
    anchorData?: string | null;
  }): void {
    const db = getDb();
    if (input.userId) {
      db.prepare(
        `INSERT INTO share_comments (id, noteId, userId, parentId, content, anchorData)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(input.id, input.noteId, input.userId, input.parentId || null, input.content, input.anchorData || null);
    } else {
      db.prepare(
        `INSERT INTO share_comments (id, noteId, userId, guestName, guestIpHash, parentId, content, anchorData)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(input.id, input.noteId, null, input.guestName || null, input.guestIpHash || null, input.parentId || null, input.content, input.anchorData || null);
    }
  },

  /**
   * 按 noteId 列出评论（含用户信息，管理端视图）。
   *
   * 用于笔记所有者查看评论列表。SELECT sc.*, u.username, u.avatarUrl。
   *
   * @param noteId 笔记 ID
   * @returns 评论列表
   */
  listByNoteIdWithUser(noteId: string): any[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT sc.*, u.username, u.avatarUrl
         FROM share_comments sc
         LEFT JOIN users u ON sc.userId = u.id
         WHERE sc.noteId = ?
         ORDER BY sc.createdAt ASC`,
      )
      .all(noteId) as any[];
  },

  /**
   * 按 ID 获取评论详情（含用户信息，管理端视图）。
   *
   * 用于添加/修改评论后返回完整记录。
   *
   * @param id 评论 ID
   * @returns 评论记录，或 undefined
   */
  getByIdWithUser(id: string): any | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT sc.*, u.username, u.avatarUrl
         FROM share_comments sc
         LEFT JOIN users u ON sc.userId = u.id
         WHERE sc.id = ?`,
      )
      .get(id) as any | undefined;
  },

  /**
   * 按 noteId 列出评论（含用户信息 + 计算字段，公开访问视图）。
   *
   * 用于访客查看评论。额外返回 displayName 和 isGuest。
   *
   * @param noteId 笔记 ID
   * @returns 评论列表
   */
  listByNoteIdWithUserForPublic(noteId: string): any[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT sc.id, sc.noteId, sc.userId, sc.guestName, sc.parentId, sc.content, sc.anchorData,
                sc.isResolved, sc.createdAt, sc.updatedAt,
                u.username, u.avatarUrl,
                COALESCE(NULLIF(sc.guestName, ''), u.username, '匿名') AS displayName,
                CASE WHEN sc.userId IS NULL THEN 1 ELSE 0 END AS isGuest
         FROM share_comments sc
         LEFT JOIN users u ON sc.userId = u.id
         WHERE sc.noteId = ?
         ORDER BY sc.createdAt ASC`,
      )
      .all(noteId) as any[];
  },

  /**
   * 按 ID 获取评论详情（含用户信息 + 计算字段，公开访问视图）。
   *
   * 用于访客添加评论后返回完整记录。额外返回 displayName 和 isGuest。
   *
   * @param id 评论 ID
   * @returns 评论记录，或 undefined
   */
  getByIdWithUserForPublic(id: string): any | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT sc.id, sc.noteId, sc.userId, sc.guestName, sc.parentId, sc.content, sc.anchorData,
                sc.isResolved, sc.createdAt, sc.updatedAt,
                u.username, u.avatarUrl,
                COALESCE(NULLIF(sc.guestName, ''), u.username, '匿名') AS displayName,
                CASE WHEN sc.userId IS NULL THEN 1 ELSE 0 END AS isGuest
         FROM share_comments sc
         LEFT JOIN users u ON sc.userId = u.id
         WHERE sc.id = ?`,
      )
      .get(id) as any | undefined;
  },
};
