/**
 * Share Comments Repository
 *
 * 同步方法保留 SQLite 行为；异步方法通过 Database Runtime Provider
 * 支持 SQLite / PostgreSQL，并规范化 BOOLEAN 与 TIMESTAMPTZ 返回值。
 */

import { getDb } from "../db/schema";
import { getDatabaseAdapter } from "../db/runtime";

function getAdapter() {
  return getDatabaseAdapter();
}

function booleanNumber(value: unknown): number {
  return value === true || value === 1 || value === "1" ? 1 : 0;
}

function timestampString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeCommentRow<T = any>(row: any | undefined): T | undefined {
  if (!row) return undefined;
  const normalized = { ...row };
  if ("isResolved" in normalized) normalized.isResolved = booleanNumber(normalized.isResolved);
  if ("isGuest" in normalized) normalized.isGuest = booleanNumber(normalized.isGuest);
  if ("createdAt" in normalized) normalized.createdAt = timestampString(normalized.createdAt);
  if ("updatedAt" in normalized) normalized.updatedAt = timestampString(normalized.updatedAt);
  return normalized as T;
}

function normalizeCommentRows<T = any>(rows: any[]): T[] {
  return rows.map((row) => normalizeCommentRow<T>(row)!);
}

export const shareCommentsRepository = {
  getById(commentId: string): { id: string; userId: string | null } | undefined {
    const db = getDb();
    return db.prepare('SELECT id, "userId" FROM share_comments WHERE id = ?').get(commentId) as any;
  },

  getResolved(commentId: string): { isResolved: number } | undefined {
    const db = getDb();
    return db.prepare('SELECT "isResolved" FROM share_comments WHERE id = ?').get(commentId) as any;
  },

  updateResolved(commentId: string, isResolved: number): void {
    const db = getDb();
    db.prepare('UPDATE share_comments SET "isResolved" = ?, "updatedAt" = datetime(\'now\') WHERE id = ?')
      .run(isResolved, commentId);
  },

  delete(commentId: string): void {
    getDb().prepare("DELETE FROM share_comments WHERE id = ?").run(commentId);
  },

  countByUser(userId: string): number {
    const row = getDb().prepare('SELECT COUNT(*) as c FROM share_comments WHERE "userId" = ?').get(userId) as { c: number };
    return row.c;
  },

  transferOwnership(fromUserId: string, toUserId: string): number {
    return getDb().prepare('UPDATE share_comments SET "userId" = ? WHERE "userId" = ?').run(toUserId, fromUserId).changes;
  },

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
        `INSERT INTO share_comments (id, "noteId", "userId", "parentId", content, "anchorData")
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.parentId || null, input.content, input.anchorData || null);
    } else {
      db.prepare(
        `INSERT INTO share_comments (id, "noteId", "userId", "guestName", "guestIpHash", "parentId", content, "anchorData")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, null, input.guestName || null, input.guestIpHash || null, input.parentId || null, input.content, input.anchorData || null);
    }
  },

  listByNoteIdWithUser(noteId: string): any[] {
    return getDb().prepare(
      `SELECT sc.*, u.username, u."avatarUrl"
       FROM share_comments sc
       LEFT JOIN users u ON sc."userId" = u.id
       WHERE sc."noteId" = ?
       ORDER BY sc."createdAt" ASC`,
    ).all(noteId) as any[];
  },

  getByIdWithUser(id: string): any | undefined {
    return getDb().prepare(
      `SELECT sc.*, u.username, u."avatarUrl"
       FROM share_comments sc
       LEFT JOIN users u ON sc."userId" = u.id
       WHERE sc.id = ?`,
    ).get(id) as any;
  },

  listByNoteIdWithUserForPublic(noteId: string): any[] {
    return getDb().prepare(
      `SELECT sc.id, sc."noteId", sc."userId", sc."guestName", sc."parentId", sc.content, sc."anchorData",
              sc."isResolved", sc."createdAt", sc."updatedAt",
              u.username, u."avatarUrl",
              COALESCE(NULLIF(sc."guestName", ''), u.username, '匿名') AS "displayName",
              CASE WHEN sc."userId" IS NULL THEN 1 ELSE 0 END AS "isGuest"
       FROM share_comments sc
       LEFT JOIN users u ON sc."userId" = u.id
       WHERE sc."noteId" = ?
       ORDER BY sc."createdAt" ASC`,
    ).all(noteId) as any[];
  },

  getByIdWithUserForPublic(id: string): any | undefined {
    return getDb().prepare(
      `SELECT sc.id, sc."noteId", sc."userId", sc."guestName", sc."parentId", sc.content, sc."anchorData",
              sc."isResolved", sc."createdAt", sc."updatedAt",
              u.username, u."avatarUrl",
              COALESCE(NULLIF(sc."guestName", ''), u.username, '匿名') AS "displayName",
              CASE WHEN sc."userId" IS NULL THEN 1 ELSE 0 END AS "isGuest"
       FROM share_comments sc
       LEFT JOIN users u ON sc."userId" = u.id
       WHERE sc.id = ?`,
    ).get(id) as any;
  },

  async getByIdAsync(commentId: string): Promise<{ id: string; userId: string | null } | undefined> {
    return getAdapter().queryOne('SELECT id, "userId" FROM share_comments WHERE id = ?', [commentId]);
  },

  async getResolvedAsync(commentId: string): Promise<{ isResolved: number } | undefined> {
    const row = await getAdapter().queryOne<{ isResolved: unknown }>(
      'SELECT "isResolved" FROM share_comments WHERE id = ?',
      [commentId],
    );
    return row ? { isResolved: booleanNumber(row.isResolved) } : undefined;
  },

  async updateResolvedAsync(commentId: string, isResolved: number): Promise<void> {
    await getAdapter().execute(
      `UPDATE share_comments
       SET "isResolved" = CASE WHEN ? = 1 THEN TRUE ELSE FALSE END,
           "updatedAt" = datetime('now')
       WHERE id = ?`,
      [isResolved, commentId],
    );
  },

  async deleteAsync(commentId: string): Promise<void> {
    await getAdapter().execute("DELETE FROM share_comments WHERE id = ?", [commentId]);
  },

  async countByUserAsync(userId: string): Promise<number> {
    const row = await getAdapter().queryOne<{ c: number | string }>(
      'SELECT COUNT(*) as c FROM share_comments WHERE "userId" = ?',
      [userId],
    );
    return Number(row?.c ?? 0);
  },

  async transferOwnershipAsync(fromUserId: string, toUserId: string): Promise<number> {
    const result = await getAdapter().execute(
      'UPDATE share_comments SET "userId" = ? WHERE "userId" = ?',
      [toUserId, fromUserId],
    );
    return result.changes;
  },

  async createAsync(input: {
    id: string;
    noteId: string;
    userId: string | null;
    guestName?: string;
    guestIpHash?: string;
    parentId?: string | null;
    content: string;
    anchorData?: string | null;
  }): Promise<void> {
    if (input.userId) {
      await getAdapter().execute(
        `INSERT INTO share_comments (id, "noteId", "userId", "parentId", content, "anchorData")
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.id, input.noteId, input.userId, input.parentId || null, input.content, input.anchorData || null],
      );
    } else {
      await getAdapter().execute(
        `INSERT INTO share_comments (id, "noteId", "userId", "guestName", "guestIpHash", "parentId", content, "anchorData")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.noteId, null, input.guestName || null, input.guestIpHash || null, input.parentId || null, input.content, input.anchorData || null],
      );
    }
  },

  async listByNoteIdWithUserAsync(noteId: string): Promise<any[]> {
    const rows = await getAdapter().queryMany<any>(
      `SELECT sc.*, u.username, u."avatarUrl"
       FROM share_comments sc
       LEFT JOIN users u ON sc."userId" = u.id
       WHERE sc."noteId" = ?
       ORDER BY sc."createdAt" ASC`,
      [noteId],
    );
    return normalizeCommentRows(rows);
  },

  async getByIdWithUserAsync(id: string): Promise<any | undefined> {
    const row = await getAdapter().queryOne<any>(
      `SELECT sc.*, u.username, u."avatarUrl"
       FROM share_comments sc
       LEFT JOIN users u ON sc."userId" = u.id
       WHERE sc.id = ?`,
      [id],
    );
    return normalizeCommentRow(row);
  },

  async listByNoteIdWithUserForPublicAsync(noteId: string): Promise<any[]> {
    const rows = await getAdapter().queryMany<any>(
      `SELECT sc.id, sc."noteId", sc."userId", sc."guestName", sc."parentId", sc.content, sc."anchorData",
              sc."isResolved", sc."createdAt", sc."updatedAt",
              u.username, u."avatarUrl",
              COALESCE(NULLIF(sc."guestName", ''), u.username, '匿名') AS "displayName",
              CASE WHEN sc."userId" IS NULL THEN 1 ELSE 0 END AS "isGuest"
       FROM share_comments sc
       LEFT JOIN users u ON sc."userId" = u.id
       WHERE sc."noteId" = ?
       ORDER BY sc."createdAt" ASC`,
      [noteId],
    );
    return normalizeCommentRows(rows);
  },

  async getByIdWithUserForPublicAsync(id: string): Promise<any | undefined> {
    const row = await getAdapter().queryOne<any>(
      `SELECT sc.id, sc."noteId", sc."userId", sc."guestName", sc."parentId", sc.content, sc."anchorData",
              sc."isResolved", sc."createdAt", sc."updatedAt",
              u.username, u."avatarUrl",
              COALESCE(NULLIF(sc."guestName", ''), u.username, '匿名') AS "displayName",
              CASE WHEN sc."userId" IS NULL THEN 1 ELSE 0 END AS "isGuest"
       FROM share_comments sc
       LEFT JOIN users u ON sc."userId" = u.id
       WHERE sc.id = ?`,
      [id],
    );
    return normalizeCommentRow(row);
  },
};
