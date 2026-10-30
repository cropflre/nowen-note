/**
 * Attachment References Repository
 *
 * 职责：
 * - 封装 attachment_references 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

function getAdapter() {
  return new SqliteAdapter(getDb());
}

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
      .prepare('SELECT "attachmentId" FROM attachment_references WHERE "noteId" = ?')
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
      'INSERT OR IGNORE INTO attachment_references ("attachmentId", "noteId") VALUES (?, ?)'
    );
    for (const id of attachmentIds) {
      try {
        insertOne.run(id, noteId);
      } catch (error) {
        // Missing legacy attachment IDs remain ignorable; storage/trigger failures
        // must reach the caller so its content/index transaction can roll back.
        if ((error as { code?: string }).code !== "SQLITE_CONSTRAINT_FOREIGNKEY") throw error;
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
        `DELETE FROM attachment_references WHERE "noteId" = ? AND "attachmentId" IN (${placeholders})`
      )
      .run(noteId, ...attachmentIds);
    return Number(info.changes || 0);
  },

  /**
   * 检查附件是否被指定笔记引用。
   *
   * @param attachmentId 附件 ID
   * @param noteId 笔记 ID
   * @returns 是否被引用
   */
  isReferencedByNote(attachmentId: string, noteId: string): boolean {
    const db = getDb();
    const row = db
      .prepare('SELECT 1 FROM attachment_references WHERE "attachmentId" = ? AND "noteId" = ?')
      .get(attachmentId, noteId);
    return !!row;
  },

  /**
   * 检查附件是否被任何笔记引用。
   *
   * @param attachmentId 附件 ID
   * @returns 是否被引用
   */
  isReferenced(attachmentId: string): boolean {
    const db = getDb();
    const row = db
      .prepare('SELECT 1 FROM attachment_references WHERE "attachmentId" = ?')
      .get(attachmentId);
    return !!row;
  },

  async listByNoteIdAsync(noteId: string): Promise<string[]> {
    const rows = await getAdapter().queryMany<{ attachmentId: string }>(
      'SELECT "attachmentId" FROM attachment_references WHERE "noteId" = ?',
      [noteId],
    );
    return rows.map((r) => r.attachmentId);
  },

  async addReferencesAsync(noteId: string, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    for (const id of attachmentIds) {
      try {
        await getAdapter().execute(
          'INSERT OR IGNORE INTO attachment_references ("attachmentId", "noteId") VALUES (?, ?)',
          [id, noteId],
        );
      } catch (error) {
        // Missing legacy attachment IDs remain ignorable; storage/trigger failures
        // must reach the caller so its content/index transaction can roll back.
        if ((error as { code?: string }).code !== "SQLITE_CONSTRAINT_FOREIGNKEY") throw error;
      }
    }
  },

  async removeReferencesAsync(noteId: string, attachmentIds: string[]): Promise<number> {
    if (attachmentIds.length === 0) return 0;
    const placeholders = attachmentIds.map(() => "?").join(",");
    const result = await getAdapter().execute(
      `DELETE FROM attachment_references WHERE "noteId" = ? AND "attachmentId" IN (${placeholders})`,
      [noteId, ...attachmentIds],
    );
    return Number(result.changes || 0);
  },

  async isReferencedByNoteAsync(attachmentId: string, noteId: string): Promise<boolean> {
    const row = await getAdapter().queryOne<{ _1: number }>(
      'SELECT 1 FROM attachment_references WHERE "attachmentId" = ? AND "noteId" = ?',
      [attachmentId, noteId],
    );
    return !!row;
  },

  async isReferencedAsync(attachmentId: string): Promise<boolean> {
    const row = await getAdapter().queryOne<{ _1: number }>(
      'SELECT 1 FROM attachment_references WHERE "attachmentId" = ?',
      [attachmentId],
    );
    return !!row;
  },
};
