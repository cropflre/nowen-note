/**
 * Notebook Share Links Repository
 *
 * 同步方法保留 SQLite 行为；异步方法通过 Database Runtime Provider
 * 在 SQLite 与 PostgreSQL 上共享同一业务接口。
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

/** notebook_share_links 记录 */
export interface NotebookShareLinkRecord {
  id: string;
  notebookId: string;
  token: string;
  role: string;
  enabled: number;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface NotebookShareLinkDetails {
  id: string;
  notebookId: string;
  role: string;
  enabled: number;
  expiresAt: string | null;
  createdAt: string;
  name: string;
  icon: string;
  color: string;
  ownerUsername: string;
  ownerDisplayName: string | null;
}

function normalizeRecord(row: any | undefined): NotebookShareLinkRecord | undefined {
  if (!row) return undefined;
  return {
    ...row,
    enabled: booleanNumber(row.enabled),
    expiresAt: timestampString(row.expiresAt),
    createdAt: timestampString(row.createdAt) ?? "",
    updatedAt: timestampString(row.updatedAt) ?? "",
  };
}

function normalizeDetails(row: any | undefined): NotebookShareLinkDetails | undefined {
  if (!row) return undefined;
  return {
    ...row,
    enabled: booleanNumber(row.enabled),
    expiresAt: timestampString(row.expiresAt),
    createdAt: timestampString(row.createdAt) ?? "",
  };
}

export const notebookShareLinksRepository = {
  getByTokenWithDetails(token: string): NotebookShareLinkDetails | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT l.id, l."notebookId", l.role, l.enabled, l."expiresAt", l."createdAt",
                nb.name, nb.icon, nb.color,
                u.username AS "ownerUsername", u."displayName" AS "ownerDisplayName"
         FROM notebook_share_links l
         JOIN notebooks nb ON nb.id = l."notebookId"
         JOIN users u ON u.id = nb."userId"
         WHERE l.token = ?
           AND l.enabled = 1
           AND nb."isDeleted" = 0
           AND (l."expiresAt" IS NULL OR l."expiresAt" > datetime('now'))`,
      )
      .get(token) as NotebookShareLinkDetails | undefined;
  },

  getEnabledByToken(token: string): {
    notebookId: string;
    role: string;
    createdBy: string;
    ownerId: string;
  } | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT l."notebookId", l.role, l."createdBy", nb."userId" AS "ownerId"
         FROM notebook_share_links l
         JOIN notebooks nb ON nb.id = l."notebookId"
         WHERE l.token = ?
           AND l.enabled = 1
           AND nb."isDeleted" = 0
           AND (l."expiresAt" IS NULL OR l."expiresAt" > datetime('now'))`,
      )
      .get(token) as any;
  },

  getLatestEnabledByNotebook(notebookId: string): NotebookShareLinkRecord | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, "notebookId", token, role, enabled, "expiresAt", "createdBy", "createdAt", "updatedAt"
         FROM notebook_share_links
         WHERE "notebookId" = ? AND enabled = 1
         ORDER BY "createdAt" DESC
         LIMIT 1`,
      )
      .get(notebookId) as NotebookShareLinkRecord | undefined;
  },

  disableAllByNotebook(notebookId: string): void {
    const db = getDb();
    db.prepare(
      `UPDATE notebook_share_links
       SET enabled = 0, "updatedAt" = datetime('now')
       WHERE "notebookId" = ? AND enabled = 1`,
    ).run(notebookId);
  },

  create(input: {
    id: string;
    notebookId: string;
    token: string;
    role: string;
    expiresAt: string | null;
    createdBy: string;
  }): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO notebook_share_links (id, "notebookId", token, role, enabled, "expiresAt", "createdBy")
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(input.id, input.notebookId, input.token, input.role, input.expiresAt, input.createdBy);
  },

  getById(linkId: string): NotebookShareLinkRecord | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, "notebookId", token, role, enabled, "expiresAt", "createdBy", "createdAt", "updatedAt"
         FROM notebook_share_links WHERE id = ?`,
      )
      .get(linkId) as NotebookShareLinkRecord | undefined;
  },

  update(linkId: string, input: {
    role?: string;
    enabled?: number;
    expiresAt?: string | null;
  }): void {
    const db = getDb();
    const updates: string[] = [];
    const params: any[] = [];

    if (input.role !== undefined) { updates.push("role = ?"); params.push(input.role); }
    if (input.enabled !== undefined) { updates.push("enabled = ?"); params.push(input.enabled); }
    if (input.expiresAt !== undefined) { updates.push('"expiresAt" = ?'); params.push(input.expiresAt); }
    if (updates.length === 0) return;

    updates.push('"updatedAt" = datetime(\'now\')');
    params.push(linkId);
    db.prepare(`UPDATE notebook_share_links SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  },

  async getByTokenWithDetailsAsync(token: string): Promise<NotebookShareLinkDetails | undefined> {
    const row = await getAdapter().queryOne<any>(
      `SELECT l.id, l."notebookId", l.role, l.enabled, l."expiresAt", l."createdAt",
              nb.name, nb.icon, nb.color,
              u.username AS "ownerUsername", u."displayName" AS "ownerDisplayName"
       FROM notebook_share_links l
       JOIN notebooks nb ON nb.id = l."notebookId"
       JOIN users u ON u.id = nb."userId"
       WHERE l.token = ?
         AND l.enabled = 1
         AND nb."isDeleted" = 0
         AND (l."expiresAt" IS NULL OR l."expiresAt" > datetime('now'))`,
      [token],
    );
    return normalizeDetails(row);
  },

  async getEnabledByTokenAsync(token: string): Promise<{
    notebookId: string;
    role: string;
    createdBy: string;
    ownerId: string;
  } | undefined> {
    return getAdapter().queryOne(
      `SELECT l."notebookId", l.role, l."createdBy", nb."userId" AS "ownerId"
       FROM notebook_share_links l
       JOIN notebooks nb ON nb.id = l."notebookId"
       WHERE l.token = ?
         AND l.enabled = 1
         AND nb."isDeleted" = 0
         AND (l."expiresAt" IS NULL OR l."expiresAt" > datetime('now'))`,
      [token],
    );
  },

  async getLatestEnabledByNotebookAsync(notebookId: string): Promise<NotebookShareLinkRecord | undefined> {
    const row = await getAdapter().queryOne<any>(
      `SELECT id, "notebookId", token, role, enabled, "expiresAt", "createdBy", "createdAt", "updatedAt"
       FROM notebook_share_links
       WHERE "notebookId" = ? AND enabled = 1
       ORDER BY "createdAt" DESC
       LIMIT 1`,
      [notebookId],
    );
    return normalizeRecord(row);
  },

  async disableAllByNotebookAsync(notebookId: string): Promise<void> {
    await getAdapter().execute(
      `UPDATE notebook_share_links
       SET enabled = FALSE, "updatedAt" = datetime('now')
       WHERE "notebookId" = ? AND enabled = 1`,
      [notebookId],
    );
  },

  async createAsync(input: {
    id: string;
    notebookId: string;
    token: string;
    role: string;
    expiresAt: string | null;
    createdBy: string;
  }): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO notebook_share_links (id, "notebookId", token, role, enabled, "expiresAt", "createdBy")
       VALUES (?, ?, ?, ?, TRUE, ?, ?)`,
      [input.id, input.notebookId, input.token, input.role, input.expiresAt, input.createdBy],
    );
  },

  async getByIdAsync(linkId: string): Promise<NotebookShareLinkRecord | undefined> {
    const row = await getAdapter().queryOne<any>(
      `SELECT id, "notebookId", token, role, enabled, "expiresAt", "createdBy", "createdAt", "updatedAt"
       FROM notebook_share_links WHERE id = ?`,
      [linkId],
    );
    return normalizeRecord(row);
  },

  async updateAsync(linkId: string, input: {
    role?: string;
    enabled?: number;
    expiresAt?: string | null;
  }): Promise<void> {
    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.role !== undefined) { updates.push("role = ?"); params.push(input.role); }
    if (input.enabled !== undefined) {
      updates.push("enabled = CASE WHEN ? = 1 THEN TRUE ELSE FALSE END");
      params.push(input.enabled);
    }
    if (input.expiresAt !== undefined) { updates.push('"expiresAt" = ?'); params.push(input.expiresAt); }
    if (updates.length === 0) return;

    updates.push('"updatedAt" = datetime(\'now\')');
    params.push(linkId);
    await getAdapter().execute(`UPDATE notebook_share_links SET ${updates.join(", ")} WHERE id = ?`, params);
  },
};
