/**
 * Note Y-updates Repository
 *
 * 职责：
 * - 封装 note_yupdates 与 yjs_operation_receipts 的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { createHash } from "node:crypto";
import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

export interface YjsOperationReceipt {
  noteId: string;
  operationId: string;
  updateId: number;
  userId: string | null;
  updateHash: string;
  persistedAt: string;
}

function getAdapter() {
  return new SqliteAdapter(getDb());
}

function hashUpdate(update: Buffer): string {
  return createHash("sha256").update(update).digest("hex");
}

export const noteYupdatesRepository = {
  /** 获取笔记的 Y.js updates（指定 ID 之后的）。 */
  listAfterId(noteId: string, afterId: number): Array<{ id: number; update_blob: Buffer }> {
    const db = getDb();
    return db
      .prepare("SELECT id, update_blob FROM note_yupdates WHERE noteId = ? AND id > ? ORDER BY id ASC")
      .all(noteId, afterId) as Array<{ id: number; update_blob: Buffer }>;
  },

  /** 创建不带 ACK operationId 的旧协议 Y.js update。 */
  create(noteId: string, userId: string, update: Buffer): number {
    const db = getDb();
    const info = db
      .prepare("INSERT INTO note_yupdates (noteId, userId, update_blob, clock) VALUES (?, ?, ?, ?)")
      .run(noteId, userId, update, Date.now());
    return Number(info.lastInsertRowid);
  },

  /**
   * 原子写入 Y.js update 与 operation receipt。
   * receipt 唯一约束失败时整个事务回滚，禁止留下没有幂等回执的更新日志。
   */
  createWithOperation(
    noteId: string,
    userId: string,
    update: Buffer,
    operationId: string,
  ): number {
    const db = getDb();
    const persistedAt = new Date().toISOString();
    const updateHash = hashUpdate(update);
    const transaction = db.transaction(() => {
      const info = db
        .prepare("INSERT INTO note_yupdates (noteId, userId, update_blob, clock) VALUES (?, ?, ?, ?)")
        .run(noteId, userId, update, Date.now());
      const updateId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO yjs_operation_receipts
           (noteId, operationId, updateId, userId, updateHash, persistedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(noteId, operationId, updateId, userId || null, updateHash, persistedAt);
      return updateId;
    });
    return transaction();
  },

  findOperationReceipt(noteId: string, operationId: string): YjsOperationReceipt | undefined {
    return getDb().prepare(
      `SELECT noteId, operationId, updateId, userId, updateHash, persistedAt
       FROM yjs_operation_receipts
       WHERE noteId = ? AND operationId = ?`,
    ).get(noteId, operationId) as YjsOperationReceipt | undefined;
  },

  deleteOperationReceiptsBefore(persistedBefore: string): number {
    const result = getDb()
      .prepare("DELETE FROM yjs_operation_receipts WHERE persistedAt < ?")
      .run(persistedBefore);
    return result.changes;
  },

  /** 获取笔记的最大 update ID。 */
  getMaxId(noteId: string): { maxId: number | null } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT MAX(id) as maxId FROM note_yupdates WHERE noteId = ?")
      .get(noteId) as { maxId: number | null } | undefined;
  },

  /** 删除指定 ID 以下的 updates。回执按独立保留期清理，不跟随 update GC。 */
  deleteUpTo(noteId: string, maxId: number): void {
    const db = getDb();
    db.prepare("DELETE FROM note_yupdates WHERE noteId = ? AND id <= ?").run(noteId, maxId);
  },

  /** 删除笔记的所有旧协议 Yjs 数据。 */
  deleteByNoteId(noteId: string): void {
    const db = getDb();
    db.transaction(() => {
      db.prepare("DELETE FROM note_yupdates WHERE noteId = ?").run(noteId);
      db.prepare("DELETE FROM yjs_operation_receipts WHERE noteId = ?").run(noteId);
    })();
  },

  /** 转移用户（用户迁移时使用）。返回值保持为更新的 update 行数。 */
  transferOwnership(fromUserId: string, toUserId: string): number {
    const db = getDb();
    return db.transaction(() => {
      const result = db.prepare("UPDATE note_yupdates SET userId = ? WHERE userId = ?").run(toUserId, fromUserId);
      db.prepare("UPDATE yjs_operation_receipts SET userId = ? WHERE userId = ?").run(toUserId, fromUserId);
      return result.changes;
    })();
  },

  async listAfterIdAsync(noteId: string, afterId: number): Promise<Array<{ id: number; update_blob: Buffer }>> {
    return getAdapter().queryMany<{ id: number; update_blob: Buffer }>(
      "SELECT id, update_blob FROM note_yupdates WHERE noteId = ? AND id > ? ORDER BY id ASC",
      [noteId, afterId],
    );
  },

  async createAsync(noteId: string, userId: string, update: Buffer): Promise<number> {
    const result = await getAdapter().execute(
      "INSERT INTO note_yupdates (noteId, userId, update_blob, clock) VALUES (?, ?, ?, ?)",
      [noteId, userId, update, Date.now()],
    );
    return Number(result.lastInsertRowid);
  },

  async getMaxIdAsync(noteId: string): Promise<{ maxId: number | null } | undefined> {
    return getAdapter().queryOne<{ maxId: number | null }>(
      "SELECT MAX(id) as maxId FROM note_yupdates WHERE noteId = ?",
      [noteId],
    );
  },

  async deleteUpToAsync(noteId: string, maxId: number): Promise<void> {
    await getAdapter().execute(
      "DELETE FROM note_yupdates WHERE noteId = ? AND id <= ?",
      [noteId, maxId],
    );
  },

  async deleteByNoteIdAsync(noteId: string): Promise<void> {
    await getAdapter().executeStatements([
      { sql: "DELETE FROM note_yupdates WHERE noteId = ?", params: [noteId] },
      { sql: "DELETE FROM yjs_operation_receipts WHERE noteId = ?", params: [noteId] },
    ]);
  },

  async transferOwnershipAsync(fromUserId: string, toUserId: string): Promise<number> {
    const adapter = getAdapter();
    const result = await adapter.execute(
      "UPDATE note_yupdates SET userId = ? WHERE userId = ?",
      [toUserId, fromUserId],
    );
    await adapter.execute(
      "UPDATE yjs_operation_receipts SET userId = ? WHERE userId = ?",
      [toUserId, fromUserId],
    );
    return result.changes;
  },
};
