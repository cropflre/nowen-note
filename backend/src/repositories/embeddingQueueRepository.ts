/**
 * Embedding Queue Repository
 *
 * 职责：
 * - 封装 embedding_queue 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

function getAdapter() {
  return new SqliteAdapter(getDb());
}

export const embeddingQueueRepository = {
  /**
   * 删除队列项。
   *
   * @param noteId 笔记 ID
   */
  deleteByNoteId(noteId: string): void {
    const db = getDb();
    db.prepare("DELETE FROM embedding_queue WHERE \"noteId\" = ?").run(noteId);
  },

  /**
   * 更新状态为完成（内容太短跳过）。
   *
   * @param noteId 笔记 ID
   */
  markSkipped(noteId: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE embedding_queue SET status = 'done', \"updatedAt\" = datetime('now'), \"lastError\" = 'skipped: content too short' WHERE \"noteId\" = ?"
    ).run(noteId);
  },

  /**
   * 更新状态为完成。
   *
   * @param noteId 笔记 ID
   */
  markDone(noteId: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE embedding_queue SET status = 'done', \"lastError\" = NULL, \"updatedAt\" = datetime('now') WHERE \"noteId\" = ?"
    ).run(noteId);
  },

  /**
   * 更新状态为处理中。
   *
   * @param noteId 笔记 ID
   */
  markProcessing(noteId: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE embedding_queue SET status = 'processing', \"updatedAt\" = datetime('now') WHERE \"noteId\" = ?"
    ).run(noteId);
  },

  /**
   * 更新状态和错误信息。
   *
   * @param noteId 笔记 ID
   * @param status 状态
   * @param retries 重试次数
   * @param lastError 错误信息
   */
  updateStatus(noteId: string, status: string, retries: number, lastError: string): void {
    const db = getDb();
    db.prepare(
      `UPDATE embedding_queue
       SET status = ?, retries = ?, "lastError" = ?, "updatedAt" = datetime('now')
       WHERE "noteId" = ?`
    ).run(status, retries, lastError, noteId);
  },

  /**
   * 获取待处理的队列项。
   *
   * @param maxRetries 最大重试次数
   * @param limit 限制数量
   * @returns 队列项列表
   */
  listPending(maxRetries: number, limit: number): Array<{ noteId: string; userId: string; retries: number }> {
    const db = getDb();
    return db
      .prepare(
        `SELECT "noteId", "userId", retries
         FROM embedding_queue
         WHERE status = 'pending' AND retries < ?
         ORDER BY "enqueuedAt" ASC
         LIMIT ?`
      )
      .all(maxRetries, limit) as Array<{ noteId: string; userId: string; retries: number }>;
  },

  /**
   * 批量入队。
   *
   * @param whereClause WHERE 子句（不含 WHERE 关键字）
   * @param params 参数
   */
  enqueueByWhere(whereClause: string, params: any[]): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO embedding_queue ("noteId", "userId", "workspaceId", status, retries, "enqueuedAt", "updatedAt")
       SELECT id, "userId", "workspaceId", 'pending', 0, datetime('now'), datetime('now')
       FROM notes WHERE ${whereClause}
       ON CONFLICT("noteId") DO UPDATE SET
         "workspaceId" = excluded."workspaceId",
         status = 'pending',
         retries = 0,
         "lastError" = NULL,
         "updatedAt" = datetime('now')`
    ).run(...params);
  },

  /**
   * 统计队列项数量。
   *
   * @param whereClause WHERE 子句（不含 WHERE 关键字）
   * @param params 参数
   * @returns 队列项数量
   */
  countByWhere(whereClause: string, params: any[]): number {
    const db = getDb();
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM embedding_queue WHERE ${whereClause}`)
      .get(...params) as { c: number };
    return row.c;
  },

  /**
   * 按状态统计队列项数量。
   *
   * @param whereClause WHERE 子句（不含 WHERE 关键字，可为空）
   * @param params 参数
   * @returns 状态统计
   */
  countByStatus(whereClause: string, params: any[]): Array<{ status: string; c: number }> {
    const db = getDb();
    const whereTail = whereClause ? ` WHERE ${whereClause}` : "";
    return db
      .prepare(`SELECT status, COUNT(*) as c FROM embedding_queue${whereTail} GROUP BY status`)
      .all(...params) as Array<{ status: string; c: number }>;
  },

  async deleteByNoteIdAsync(noteId: string): Promise<void> {
    await getAdapter().execute("DELETE FROM embedding_queue WHERE \"noteId\" = ?", [noteId]);
  },

  async markSkippedAsync(noteId: string): Promise<void> {
    await getAdapter().execute(
      "UPDATE embedding_queue SET status = 'done', \"updatedAt\" = datetime('now'), \"lastError\" = 'skipped: content too short' WHERE \"noteId\" = ?",
      [noteId],
    );
  },

  async markDoneAsync(noteId: string): Promise<void> {
    await getAdapter().execute(
      "UPDATE embedding_queue SET status = 'done', \"lastError\" = NULL, \"updatedAt\" = datetime('now') WHERE \"noteId\" = ?",
      [noteId],
    );
  },

  async markProcessingAsync(noteId: string): Promise<void> {
    await getAdapter().execute(
      "UPDATE embedding_queue SET status = 'processing', \"updatedAt\" = datetime('now') WHERE \"noteId\" = ?",
      [noteId],
    );
  },

  async updateStatusAsync(noteId: string, status: string, retries: number, lastError: string): Promise<void> {
    await getAdapter().execute(
      `UPDATE embedding_queue
       SET status = ?, retries = ?, "lastError" = ?, "updatedAt" = datetime('now')
       WHERE "noteId" = ?`,
      [status, retries, lastError, noteId],
    );
  },

  async listPendingAsync(maxRetries: number, limit: number): Promise<Array<{ noteId: string; userId: string; retries: number }>> {
    return getAdapter().queryMany<{ noteId: string; userId: string; retries: number }>(
      `SELECT "noteId", "userId", retries
       FROM embedding_queue
       WHERE status = 'pending' AND retries < ?
       ORDER BY "enqueuedAt" ASC
       LIMIT ?`,
      [maxRetries, limit],
    );
  },

  async enqueueByWhereAsync(whereClause: string, params: unknown[]): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO embedding_queue ("noteId", "userId", "workspaceId", status, retries, "enqueuedAt", "updatedAt")
       SELECT id, "userId", "workspaceId", 'pending', 0, datetime('now'), datetime('now')
       FROM notes WHERE ${whereClause}
       ON CONFLICT("noteId") DO UPDATE SET
         "workspaceId" = excluded."workspaceId",
         status = 'pending',
         retries = 0,
         "lastError" = NULL,
         "updatedAt" = datetime('now')`,
      params,
    );
  },

  async countByWhereAsync(whereClause: string, params: unknown[]): Promise<number> {
    const row = await getAdapter().queryOne<{ c: number }>(
      `SELECT COUNT(*) as c FROM embedding_queue WHERE ${whereClause}`,
      params,
    );
    return row?.c ?? 0;
  },

  async countByStatusAsync(whereClause: string, params: unknown[]): Promise<Array<{ status: string; c: number }>> {
    const whereTail = whereClause ? ` WHERE ${whereClause}` : "";
    return getAdapter().queryMany<{ status: string; c: number }>(
      `SELECT status, COUNT(*) as c FROM embedding_queue${whereTail} GROUP BY status`,
      params,
    );
  },
};
