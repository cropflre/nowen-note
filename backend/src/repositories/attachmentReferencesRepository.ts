/**
 * Attachment References Repository
 *
 * 同步方法继续服务现有 SQLite 事务；异步方法通过统一数据库 Runtime Adapter，
 * 可在 SQLite 与 PostgreSQL 下复用同一业务接口。
 */

import type { DatabaseAdapter } from "../db/adapters/types";
import type { DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import { getDb } from "../db/schema";

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function resolveDialect(dialect?: DatabaseDialect): DatabaseDialect {
  if (dialect) return dialect;
  try {
    return getDatabaseDialect();
  } catch {
    return "sqlite";
  }
}

export function createAttachmentReferencesRepository(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getDialect = () => resolveDialect(dialect);

  return {
    // ---- 同步方法（仅 SQLite，供现有原子事务调用） ----

    listByNoteId(noteId: string): string[] {
      const rows = getDb()
        .prepare('SELECT "attachmentId" FROM attachment_references WHERE "noteId" = ? ORDER BY "attachmentId"')
        .all(noteId) as Array<{ attachmentId: string }>;
      return rows.map((row) => row.attachmentId);
    },

    addReferences(noteId: string, attachmentIds: string[]): void {
      if (!attachmentIds.length) return;
      const insertOne = getDb().prepare(
        'INSERT OR IGNORE INTO attachment_references ("attachmentId", "noteId") VALUES (?, ?)',
      );
      for (const attachmentId of attachmentIds) {
        try {
          insertOne.run(attachmentId, noteId);
        } catch {
          // 跳过不存在或违反外键约束的脏引用。
        }
      }
    },

    removeReferences(noteId: string, attachmentIds: string[]): number {
      if (!attachmentIds.length) return 0;
      const placeholders = attachmentIds.map(() => "?").join(",");
      const result = getDb()
        .prepare(
          `DELETE FROM attachment_references
            WHERE "noteId" = ? AND "attachmentId" IN (${placeholders})`,
        )
        .run(noteId, ...attachmentIds);
      return Number(result.changes || 0);
    },

    isReferencedByNote(attachmentId: string, noteId: string): boolean {
      return Boolean(getDb()
        .prepare('SELECT 1 FROM attachment_references WHERE "attachmentId" = ? AND "noteId" = ?')
        .get(attachmentId, noteId));
    },

    isReferenced(attachmentId: string): boolean {
      return Boolean(getDb()
        .prepare('SELECT 1 FROM attachment_references WHERE "attachmentId" = ?')
        .get(attachmentId));
    },

    // ---- 异步方法（Runtime Adapter / SQLite + PostgreSQL） ----

    async listByNoteIdAsync(noteId: string): Promise<string[]> {
      const rows = await getAdapter().queryMany<{ attachmentId: string }>(
        'SELECT "attachmentId" FROM attachment_references WHERE "noteId" = ? ORDER BY "attachmentId"',
        [noteId],
      );
      return rows.map((row) => String(row.attachmentId));
    },

    async addReferencesAsync(noteId: string, attachmentIds: string[]): Promise<void> {
      if (!attachmentIds.length) return;
      const sql = getDialect() === "postgres"
        ? `INSERT INTO attachment_references ("attachmentId", "noteId")
             VALUES (?, ?)
             ON CONFLICT ("attachmentId", "noteId") DO NOTHING`
        : 'INSERT OR IGNORE INTO attachment_references ("attachmentId", "noteId") VALUES (?, ?)';
      for (const attachmentId of attachmentIds) {
        try {
          await getAdapter().execute(sql, [attachmentId, noteId]);
        } catch {
          // 与 SQLite 同步路径一致：单条脏引用不阻塞其他有效引用。
        }
      }
    },

    async removeReferencesAsync(noteId: string, attachmentIds: string[]): Promise<number> {
      if (!attachmentIds.length) return 0;
      const placeholders = attachmentIds.map(() => "?").join(",");
      const result = await getAdapter().execute(
        `DELETE FROM attachment_references
          WHERE "noteId" = ? AND "attachmentId" IN (${placeholders})`,
        [noteId, ...attachmentIds],
      );
      return Number(result.changes || 0);
    },

    async isReferencedByNoteAsync(attachmentId: string, noteId: string): Promise<boolean> {
      const row = await getAdapter().queryOne<{ exists: number }>(
        'SELECT 1 AS exists FROM attachment_references WHERE "attachmentId" = ? AND "noteId" = ?',
        [attachmentId, noteId],
      );
      return Boolean(row);
    },

    async isReferencedAsync(attachmentId: string): Promise<boolean> {
      const row = await getAdapter().queryOne<{ exists: number }>(
        'SELECT 1 AS exists FROM attachment_references WHERE "attachmentId" = ?',
        [attachmentId],
      );
      return Boolean(row);
    },

    async getNoteContentTextAsync(noteId: string): Promise<string | null> {
      const row = await getAdapter().queryOne<{ contentText: string | null }>(
        'SELECT "contentText" FROM notes WHERE id = ?',
        [noteId],
      );
      return row?.contentText ?? null;
    },

    async updateNoteContentTextAsync(noteId: string, contentText: string): Promise<void> {
      await getAdapter().execute(
        'UPDATE notes SET "contentText" = ? WHERE id = ?',
        [contentText, noteId],
      );
    },
  };
}

export const attachmentReferencesRepository = createAttachmentReferencesRepository();
