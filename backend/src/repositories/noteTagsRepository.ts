import { getDb } from "../db/schema";
import type { DatabaseAdapter } from "../db/adapters/types";
import type { DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import type { Tag } from "./types";

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function resolveDialect(): DatabaseDialect {
  try {
    return getDatabaseDialect();
  } catch {
    return "sqlite";
  }
}

function resolveAsyncInsertOptions(insertPrefix?: string, conflictClause?: string) {
  const dialect = resolveDialect();
  return {
    insertPrefix: insertPrefix ?? (dialect === "postgres" ? "INSERT" : "INSERT OR IGNORE"),
    conflictClause: conflictClause
      ?? (dialect === "postgres" ? 'ON CONFLICT ("noteId", "tagId") DO NOTHING' : ""),
  };
}

/**
 * 创建 noteTagsRepository 实例。
 *
 * 未显式注入 adapter 时，异步方法从统一数据库运行时获取 Adapter；
 * 同步方法继续仅支持 SQLite，以保持现有调用兼容。
 */
export function createNoteTagsRepository(
  adapter?: DatabaseAdapter,
  insertPrefix?: string,
  conflictClause?: string,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const syncInsertPrefix = insertPrefix ?? "INSERT OR IGNORE";
  const syncConflictClause = conflictClause ?? "";
  const getAsyncInsertOptions = () => resolveAsyncInsertOptions(insertPrefix, conflictClause);

  return {
    // ---- 同步方法（仅 SQLite） ----

    addTagToNote(noteId: string, tagId: string): void {
      const db = getDb();
      db.prepare(
        `${syncInsertPrefix} INTO note_tags ("noteId", "tagId") VALUES (?, ?) ${syncConflictClause}`,
      ).run(noteId, tagId);
    },

    removeTagFromNote(noteId: string, tagId: string): void {
      const db = getDb();
      db.prepare('DELETE FROM note_tags WHERE "noteId" = ? AND "tagId" = ?').run(noteId, tagId);
    },

    listTagsByNoteId(noteId: string): Tag[] {
      const db = getDb();
      return db
        .prepare(
          `SELECT t.* FROM tags t
           JOIN note_tags nt ON t.id = nt."tagId"
           WHERE nt."noteId" = ?`,
        )
        .all(noteId) as Tag[];
    },

    listNoteIdsByTagFilter(tagIds: string[], mode: "and" | "or" = "and"): string[] {
      if (tagIds.length === 0) return [];
      const db = getDb();

      if (mode === "and" && tagIds.length > 1) {
        const placeholders = tagIds.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT "noteId" FROM note_tags
             WHERE "tagId" IN (${placeholders})
             GROUP BY "noteId"
             HAVING COUNT(DISTINCT "tagId") >= ?`,
          )
          .all(...tagIds, tagIds.length) as { noteId: string }[];
        return rows.map((r) => r.noteId);
      }

      const placeholders = tagIds.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT DISTINCT "noteId" FROM note_tags WHERE "tagId" IN (${placeholders})`)
        .all(...tagIds) as { noteId: string }[];
      return rows.map((r) => r.noteId);
    },

    // ---- Async 方法（支持运行时 Adapter / 显式注入） ----

    async addTagToNoteAsync(noteId: string, tagId: string): Promise<void> {
      const sql = getAsyncInsertOptions();
      await getAdapter().execute(
        `${sql.insertPrefix} INTO note_tags ("noteId", "tagId") VALUES (?, ?) ${sql.conflictClause}`,
        [noteId, tagId],
      );
    },

    async removeTagFromNoteAsync(noteId: string, tagId: string): Promise<void> {
      await getAdapter().execute(
        'DELETE FROM note_tags WHERE "noteId" = ? AND "tagId" = ?',
        [noteId, tagId],
      );
    },

    async listTagsByNoteIdAsync(noteId: string): Promise<Tag[]> {
      return getAdapter().queryMany<Tag>(
        `SELECT t.* FROM tags t
         JOIN note_tags nt ON t.id = nt."tagId"
         WHERE nt."noteId" = ?`,
        [noteId],
      );
    },

    async listNoteIdsByTagFilterAsync(tagIds: string[], mode: "and" | "or" = "and"): Promise<string[]> {
      if (tagIds.length === 0) return [];

      if (mode === "and" && tagIds.length > 1) {
        const placeholders = tagIds.map(() => "?").join(",");
        const rows = await getAdapter().queryMany<{ noteId: string }>(
          `SELECT "noteId" FROM note_tags
           WHERE "tagId" IN (${placeholders})
           GROUP BY "noteId"
           HAVING COUNT(DISTINCT "tagId") >= ?`,
          [...tagIds, tagIds.length],
        );
        return rows.map((r) => r.noteId);
      }

      const placeholders = tagIds.map(() => "?").join(",");
      const rows = await getAdapter().queryMany<{ noteId: string }>(
        `SELECT DISTINCT "noteId" FROM note_tags WHERE "tagId" IN (${placeholders})`,
        tagIds,
      );
      return rows.map((r) => r.noteId);
    },
  };
}

/** 默认实例：同步方法仍为 SQLite；异步方法使用统一运行时 Adapter。 */
export const noteTagsRepository = createNoteTagsRepository();
