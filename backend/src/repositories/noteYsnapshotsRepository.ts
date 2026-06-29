/**
 * Note Y-snapshots Repository
 *
 * 职责：
 * - 封装 note_ysnapshots 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

function getAdapter() {
  return new SqliteAdapter(getDb());
}

export const noteYsnapshotsRepository = {
  /**
   * 获取笔记的 Y.js 快照。
   *
   * @param noteId 笔记 ID
   * @returns 快照记录，或 undefined
   */
  getByNoteId(noteId: string): { snapshot_blob: Buffer; updatesMergedTo: number } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT snapshot_blob, updatesMergedTo FROM note_ysnapshots WHERE noteId = ?")
      .get(noteId) as { snapshot_blob: Buffer; updatesMergedTo: number } | undefined;
  },

  /**
   * 获取笔记的 updatesMergedTo。
   *
   * @param noteId 笔记 ID
   * @returns updatesMergedTo，或 undefined
   */
  getUpdatesMergedTo(noteId: string): { updatesMergedTo: number } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT updatesMergedTo FROM note_ysnapshots WHERE noteId = ?")
      .get(noteId) as { updatesMergedTo: number } | undefined;
  },

  /**
   * 创建或更新快照。
   *
   * @param noteId 笔记 ID
   * @param snapshotBlob 快照数据
   * @param updatesMergedTo 已合并的 update ID
   */
  upsert(noteId: string, snapshotBlob: Buffer, updatesMergedTo: number): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO note_ysnapshots (noteId, snapshot_blob, updatesMergedTo, updatedAt)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(noteId) DO UPDATE SET
         snapshot_blob = excluded.snapshot_blob,
         updatesMergedTo = excluded.updatesMergedTo,
         updatedAt = datetime('now')`
    ).run(noteId, snapshotBlob, updatesMergedTo);
  },

  /**
   * 删除笔记的快照。
   *
   * @param noteId 笔记 ID
   */
  deleteByNoteId(noteId: string): void {
    const db = getDb();
    db.prepare("DELETE FROM note_ysnapshots WHERE noteId = ?").run(noteId);
  },

  async getByNoteIdAsync(noteId: string): Promise<{ snapshot_blob: Buffer; updatesMergedTo: number } | undefined> {
    return getAdapter().queryOne<{ snapshot_blob: Buffer; updatesMergedTo: number }>(
      "SELECT snapshot_blob, updatesMergedTo FROM note_ysnapshots WHERE noteId = ?",
      [noteId],
    );
  },

  async getUpdatesMergedToAsync(noteId: string): Promise<{ updatesMergedTo: number } | undefined> {
    return getAdapter().queryOne<{ updatesMergedTo: number }>(
      "SELECT updatesMergedTo FROM note_ysnapshots WHERE noteId = ?",
      [noteId],
    );
  },

  async upsertAsync(noteId: string, snapshotBlob: Buffer, updatesMergedTo: number): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO note_ysnapshots (noteId, snapshot_blob, updatesMergedTo, updatedAt)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(noteId) DO UPDATE SET
         snapshot_blob = excluded.snapshot_blob,
         updatesMergedTo = excluded.updatesMergedTo,
         updatedAt = datetime('now')`,
      [noteId, snapshotBlob, updatesMergedTo],
    );
  },

  async deleteByNoteIdAsync(noteId: string): Promise<void> {
    await getAdapter().execute("DELETE FROM note_ysnapshots WHERE noteId = ?", [noteId]);
  },
};
