/**
 * Attachment References Repository
 *
 * 职责：
 * - 封装 attachment_references 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";

export const attachmentReferencesRepository = {
  /**
   * 获取笔记关联的附件 ID 列表。
   *
   * @param noteId 笔记 ID
   * @returns 附件 ID 列表
   */
  listByNoteId(noteId: string): string[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT attachmentId FROM attachment_references WHERE noteId = ?")
      .all(noteId) as { attachmentId: string }[];
    return rows.map((r) => r.attachmentId);
  },

  /**
   * 批量添加附件关联。
   *
   * @param noteId 笔记 ID
   * @param attachmentIds 附件 ID 列表
   */
  addReferences(noteId: string, attachmentIds: string[]): void {
    if (attachmentIds.length === 0) return;
    const db = getDb();
    const insertOne = db.prepare(
      "INSERT OR IGNORE INTO attachment_references (attachmentId, noteId) VALUES (?, ?)"
    );
    for (const id of attachmentIds) {
      try {
        insertOne.run(id, noteId);
      } catch {
        // 跳过非法 ID
      }
    }
  },

  /**
   * 批量删除附件关联。
   *
   * @param noteId 笔记 ID
   * @param attachmentIds 附件 ID 列表
   * @returns 删除的行数
   */
  removeReferences(noteId: string, attachmentIds: string[]): number {
    if (attachmentIds.length === 0) return 0;
    const db = getDb();
    const placeholders = attachmentIds.map(() => "?").join(",");
    const info = db
      .prepare(
        `DELETE FROM attachment_references WHERE noteId = ? AND attachmentId IN (${placeholders})`
      )
      .run(noteId, ...attachmentIds);
    return Number(info.changes || 0);
  },
};
