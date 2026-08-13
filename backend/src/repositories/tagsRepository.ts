/**
 * Tags Repository
 *
 * 同步方法继续仅服务 SQLite 旧路由；异步方法通过统一 Runtime Adapter
 * 在 SQLite / PostgreSQL 下复用同一业务接口。
 */

import { getDb } from "../db/schema";
import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import type { Tag, TagWithCount } from "./types";

export interface ScopedTagRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  color: string;
  createdAt: string | Date;
}

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

export function createTagsRepository(adapter?: DatabaseAdapter) {
  const getAdapter = () => resolveAdapter(adapter);

  return {
    // ---- 同步方法（仅 SQLite） ----

    listByUser(
      userId: string,
      workspaceId: string | null = null,
      includeEmpty: boolean = false,
    ): TagWithCount[] {
      const db = getDb();
      const havingClause = includeEmpty ? "" : 'HAVING COUNT(nt."noteId") > 0';

      if (workspaceId) {
        return db.prepare(`
          SELECT t.*, COUNT(nt."noteId") AS noteCount
          FROM tags t
          LEFT JOIN note_tags nt ON nt."tagId" = t.id
          LEFT JOIN notes n ON n.id = nt."noteId" AND n."workspaceId" = ? AND n."isTrashed" = 0
          WHERE t."workspaceId" = ?
          GROUP BY t.id
          ${havingClause}
          ORDER BY t.name ASC
        `).all(workspaceId, workspaceId) as TagWithCount[];
      }

      return db.prepare(`
        SELECT t.*, COUNT(nt."noteId") AS noteCount
        FROM tags t
        LEFT JOIN note_tags nt ON nt."tagId" = t.id
        LEFT JOIN notes n ON n.id = nt."noteId"
                          AND n."workspaceId" IS NULL
                          AND n."userId" = ?
                          AND n."isTrashed" = 0
        WHERE t."userId" = ? AND t."workspaceId" IS NULL
        GROUP BY t.id
        ${havingClause}
        ORDER BY t.name ASC
      `).all(userId, userId) as TagWithCount[];
    },

    getOwner(tagId: string): { userId: string; workspaceId: string | null } | undefined {
      return getDb().prepare(
        'SELECT "userId", "workspaceId" FROM tags WHERE id = ?',
      ).get(tagId) as { userId: string; workspaceId: string | null } | undefined;
    },

    getById(tagId: string): Tag | undefined {
      return getDb().prepare("SELECT * FROM tags WHERE id = ?").get(tagId) as Tag | undefined;
    },

    getByIdWithCount(tagId: string): TagWithCount | undefined {
      return getDb().prepare(`
        SELECT t.*, COUNT(nt."noteId") AS noteCount
        FROM tags t LEFT JOIN note_tags nt ON t.id = nt."tagId"
        WHERE t.id = ? GROUP BY t.id
      `).get(tagId) as TagWithCount | undefined;
    },

    create(input: {
      id: string;
      userId: string;
      workspaceId: string | null;
      name: string;
      color: string;
    }): void {
      getDb().prepare(
        'INSERT INTO tags (id, "userId", "workspaceId", name, color) VALUES (?, ?, ?, ?, ?)',
      ).run(input.id, input.userId, input.workspaceId, input.name, input.color);
    },

    updateById(tagId: string, patch: { name?: string; color?: string }): void {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (patch.name !== undefined) {
        fields.push("name = ?");
        values.push(patch.name);
      }
      if (patch.color !== undefined) {
        fields.push("color = ?");
        values.push(patch.color);
      }
      if (fields.length === 0) return;
      values.push(tagId);
      getDb().prepare(`UPDATE tags SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    },

    deleteTagLinks(tagId: string): void {
      getDb().prepare('DELETE FROM note_tags WHERE "tagId" = ?').run(tagId);
    },

    deleteById(tagId: string): void {
      getDb().prepare("DELETE FROM tags WHERE id = ?").run(tagId);
    },

    // ---- Async 方法（Runtime Adapter） ----

    async listByUserAsync(
      userId: string,
      workspaceId: string | null = null,
      includeEmpty: boolean = false,
    ): Promise<TagWithCount[]> {
      const havingClause = includeEmpty ? "" : 'HAVING COUNT(nt."noteId") > 0';
      if (workspaceId) {
        return getAdapter().queryMany<TagWithCount>(`
          SELECT t.*, COUNT(nt."noteId") AS "noteCount"
          FROM tags t
          LEFT JOIN note_tags nt ON nt."tagId" = t.id
          LEFT JOIN notes n ON n.id = nt."noteId" AND n."workspaceId" = ? AND n."isTrashed" = false
          WHERE t."workspaceId" = ?
          GROUP BY t.id
          ${havingClause}
          ORDER BY t.name ASC
        `, [workspaceId, workspaceId]);
      }

      return getAdapter().queryMany<TagWithCount>(`
        SELECT t.*, COUNT(nt."noteId") AS "noteCount"
        FROM tags t
        LEFT JOIN note_tags nt ON nt."tagId" = t.id
        LEFT JOIN notes n ON n.id = nt."noteId"
                          AND n."workspaceId" IS NULL
                          AND n."userId" = ?
                          AND n."isTrashed" = false
        WHERE t."userId" = ? AND t."workspaceId" IS NULL
        GROUP BY t.id
        ${havingClause}
        ORDER BY t.name ASC
      `, [userId, userId]);
    },

    async getOwnerAsync(tagId: string): Promise<{ userId: string; workspaceId: string | null } | undefined> {
      return getAdapter().queryOne(
        'SELECT "userId", "workspaceId" FROM tags WHERE id = ?',
        [tagId],
      );
    },

    async getByIdAsync(tagId: string): Promise<Tag | undefined> {
      return getAdapter().queryOne<Tag>("SELECT * FROM tags WHERE id = ?", [tagId]);
    },

    async getByIdWithCountAsync(tagId: string): Promise<TagWithCount | undefined> {
      return getAdapter().queryOne<TagWithCount>(`
        SELECT t.*, COUNT(nt."noteId") AS "noteCount"
        FROM tags t LEFT JOIN note_tags nt ON t.id = nt."tagId"
        WHERE t.id = ? GROUP BY t.id
      `, [tagId]);
    },

    async findByScopedNameAsync(
      userId: string,
      workspaceId: string | null,
      name: string,
    ): Promise<ScopedTagRecord | undefined> {
      const normalized = String(name ?? "").trim();
      if (!normalized) return undefined;

      if (workspaceId) {
        return getAdapter().queryOne<ScopedTagRecord>(`
          SELECT id, "userId", "workspaceId", name, color, "createdAt"
          FROM tags
          WHERE "workspaceId" = ? AND lower(trim(name)) = lower(?)
          ORDER BY "createdAt" ASC, id ASC
          LIMIT 1
        `, [workspaceId, normalized]);
      }

      return getAdapter().queryOne<ScopedTagRecord>(`
        SELECT id, "userId", "workspaceId", name, color, "createdAt"
        FROM tags
        WHERE "userId" = ? AND "workspaceId" IS NULL
          AND lower(trim(name)) = lower(?)
        ORDER BY "createdAt" ASC, id ASC
        LIMIT 1
      `, [userId, normalized]);
    },

    async createAsync(input: {
      id: string;
      userId: string;
      workspaceId: string | null;
      name: string;
      color: string;
    }): Promise<void> {
      await getAdapter().execute(
        'INSERT INTO tags (id, "userId", "workspaceId", name, color) VALUES (?, ?, ?, ?, ?)',
        [input.id, input.userId, input.workspaceId, input.name, input.color],
      );
    },

    async updateByIdAsync(tagId: string, patch: { name?: string; color?: string }): Promise<void> {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (patch.name !== undefined) {
        fields.push("name = ?");
        values.push(patch.name);
      }
      if (patch.color !== undefined) {
        fields.push("color = ?");
        values.push(patch.color);
      }
      if (fields.length === 0) return;
      values.push(tagId);
      await getAdapter().execute(`UPDATE tags SET ${fields.join(", ")} WHERE id = ?`, values);
    },

    async deleteTagLinksAsync(tagId: string): Promise<void> {
      await getAdapter().execute('DELETE FROM note_tags WHERE "tagId" = ?', [tagId]);
    },

    async deleteByIdAsync(tagId: string): Promise<void> {
      await getAdapter().execute("DELETE FROM tags WHERE id = ?", [tagId]);
    },
  };
}

export const tagsRepository = createTagsRepository();
