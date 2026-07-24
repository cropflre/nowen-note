/**
 * Notebook Share Links Repository
 *
 * 同步方法保留 SQLite 行为；异步方法通过 Database Runtime Provider，
 * 并完整支持主线的 maxUses/useCount 分享限制。
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

export interface NotebookShareLinkRecord {
  id: string;
  notebookId: string;
  token: string;
  role: string;
  enabled: number;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotebookShareLinkDetails extends NotebookShareLinkRecord {
  name: string;
  icon: string;
  color: string | null;
  ownerUsername: string;
  ownerDisplayName: string | null;
}

export interface EnabledNotebookShareLink extends NotebookShareLinkRecord {
  ownerId: string;
}

const RECORD_COLUMNS =
  `id, "notebookId", token, role, enabled, "expiresAt", "maxUses", "useCount", "createdBy", "createdAt", "updatedAt"`;

function normalizeRecord(row: any | undefined): NotebookShareLinkRecord | undefined {
  if (!row) return undefined;
  return {
    ...row,
    enabled: booleanNumber(row.enabled),
    maxUses: row.maxUses == null ? null : Number(row.maxUses),
    useCount: Number(row.useCount ?? 0),
    expiresAt: timestampString(row.expiresAt),
    createdAt: timestampString(row.createdAt) ?? "",
    updatedAt: timestampString(row.updatedAt) ?? "",
  };
}

function normalizeDetails(row: any | undefined): NotebookShareLinkDetails | undefined {
  const record = normalizeRecord(row);
  if (!record) return undefined;
  return {
    ...record,
    name: String(row.name),
    icon: String(row.icon ?? ""),
    color: row.color ?? null,
    ownerUsername: String(row.ownerUsername),
    ownerDisplayName: row.ownerDisplayName ?? null,
  };
}

function normalizeEnabled(row: any | undefined): EnabledNotebookShareLink | undefined {
  const record = normalizeRecord(row);
  if (!record) return undefined;
  return { ...record, ownerId: String(row.ownerId) };
}

export const notebookShareLinksRepository = {
  getByTokenWithDetails(token: string): NotebookShareLinkDetails | undefined {
    const row = getDb().prepare(
      `SELECT l.id, l."notebookId", l.token, l.role, l.enabled, l."expiresAt",
              l."maxUses", l."useCount", l."createdBy", l."createdAt", l."updatedAt",
              nb.name, nb.icon, nb.color,
              u.username AS "ownerUsername", u."displayName" AS "ownerDisplayName"
       FROM notebook_share_links l
       JOIN notebooks nb ON nb.id = l."notebookId"
       JOIN users u ON u.id = nb."userId"
       WHERE l.token = ? AND l.enabled = 1 AND nb."isDeleted" = 0
         AND (l."expiresAt" IS NULL OR l."expiresAt" > datetime('now'))`,
    ).get(token);
    return normalizeDetails(row);
  },

  getEnabledByToken(token: string): EnabledNotebookShareLink | undefined {
    const row = getDb().prepare(
      `SELECT l.id, l."notebookId", l.token, l.role, l.enabled, l."expiresAt",
              l."maxUses", l."useCount", l."createdBy", l."createdAt", l."updatedAt",
              nb."userId" AS "ownerId"
       FROM notebook_share_links l
       JOIN notebooks nb ON nb.id = l."notebookId"
       WHERE l.token = ? AND l.enabled = 1 AND nb."isDeleted" = 0
         AND (l."expiresAt" IS NULL OR l."expiresAt" > datetime('now'))`,
    ).get(token);
    return normalizeEnabled(row);
  },

  getLatestEnabledByNotebook(notebookId: string): NotebookShareLinkRecord | undefined {
    return normalizeRecord(
      getDb().prepare(
        `SELECT ${RECORD_COLUMNS}
         FROM notebook_share_links
         WHERE "notebookId" = ? AND enabled = 1
         ORDER BY "createdAt" DESC LIMIT 1`,
      ).get(notebookId),
    );
  },

  getById(linkId: string): NotebookShareLinkRecord | undefined {
    return normalizeRecord(
      getDb().prepare(`SELECT ${RECORD_COLUMNS} FROM notebook_share_links WHERE id = ?`)
        .get(linkId),
    );
  },

  disableAllByNotebook(notebookId: string): void {
    getDb().prepare(
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
    maxUses?: number | null;
    createdBy: string;
  }): void {
    getDb().prepare(
      `INSERT INTO notebook_share_links
         (id, "notebookId", token, role, enabled, "expiresAt", "maxUses", "useCount", "createdBy")
       VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?)`,
    ).run(
      input.id,
      input.notebookId,
      input.token,
      input.role,
      input.expiresAt,
      input.maxUses ?? null,
      input.createdBy,
    );
  },

  update(linkId: string, input: {
    token?: string;
    role?: string;
    enabled?: number;
    expiresAt?: string | null;
    maxUses?: number | null;
    useCount?: number;
  }): void {
    const updates: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      updates.push(sql);
      params.push(value);
    };

    if (input.token !== undefined) add("token = ?", input.token);
    if (input.role !== undefined) add("role = ?", input.role);
    if (input.enabled !== undefined) add("enabled = ?", input.enabled);
    if (input.expiresAt !== undefined) add('"expiresAt" = ?', input.expiresAt);
    if (input.maxUses !== undefined) add('"maxUses" = ?', input.maxUses);
    if (input.useCount !== undefined) add('"useCount" = ?', input.useCount);
    if (updates.length === 0) return;

    updates.push('"updatedAt" = datetime(\'now\')');
    params.push(linkId);
    getDb().prepare(
      `UPDATE notebook_share_links SET ${updates.join(", ")} WHERE id = ?`,
    ).run(...params);
  },

  async getByTokenWithDetailsAsync(token: string): Promise<NotebookShareLinkDetails | undefined> {
    const row = await getAdapter().queryOne<any>(
      `SELECT l.id, l."notebookId", l.token, l.role, l.enabled, l."expiresAt",
              l."maxUses", l."useCount", l."createdBy", l."createdAt", l."updatedAt",
              nb.name, nb.icon, nb.color,
              u.username AS "ownerUsername", u."displayName" AS "ownerDisplayName"
       FROM notebook_share_links l
       JOIN notebooks nb ON nb.id = l."notebookId"
       JOIN users u ON u.id = nb."userId"
       WHERE l.token = ? AND l.enabled = 1 AND nb."isDeleted" = 0
         AND (l."expiresAt" IS NULL OR l."expiresAt" > datetime('now'))`,
      [token],
    );
    return normalizeDetails(row);
  },

  async getEnabledByTokenAsync(token: string): Promise<EnabledNotebookShareLink | undefined> {
    const row = await getAdapter().queryOne<any>(
      `SELECT l.id, l."notebookId", l.token, l.role, l.enabled, l."expiresAt",
              l."maxUses", l."useCount", l."createdBy", l."createdAt", l."updatedAt",
              nb."userId" AS "ownerId"
       FROM notebook_share_links l
       JOIN notebooks nb ON nb.id = l."notebookId"
       WHERE l.token = ? AND l.enabled = 1 AND nb."isDeleted" = 0
         AND (l."expiresAt" IS NULL OR l."expiresAt" > datetime('now'))`,
      [token],
    );
    return normalizeEnabled(row);
  },

  async getLatestEnabledByNotebookAsync(notebookId: string): Promise<NotebookShareLinkRecord | undefined> {
    const row = await getAdapter().queryOne<any>(
      `SELECT ${RECORD_COLUMNS}
       FROM notebook_share_links
       WHERE "notebookId" = ? AND enabled = 1
       ORDER BY "createdAt" DESC LIMIT 1`,
      [notebookId],
    );
    return normalizeRecord(row);
  },

  async getByIdAsync(linkId: string): Promise<NotebookShareLinkRecord | undefined> {
    const row = await getAdapter().queryOne<any>(
      `SELECT ${RECORD_COLUMNS} FROM notebook_share_links WHERE id = ?`,
      [linkId],
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
    maxUses?: number | null;
    createdBy: string;
  }): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO notebook_share_links
         (id, "notebookId", token, role, enabled, "expiresAt", "maxUses", "useCount", "createdBy")
       VALUES (?, ?, ?, ?, TRUE, ?, ?, 0, ?)`,
      [
        input.id,
        input.notebookId,
        input.token,
        input.role,
        input.expiresAt,
        input.maxUses ?? null,
        input.createdBy,
      ],
    );
  },

  async updateAsync(linkId: string, input: {
    token?: string;
    role?: string;
    enabled?: number;
    expiresAt?: string | null;
    maxUses?: number | null;
    useCount?: number;
  }): Promise<void> {
    const updates: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      updates.push(sql);
      params.push(value);
    };

    if (input.token !== undefined) add("token = ?", input.token);
    if (input.role !== undefined) add("role = ?", input.role);
    if (input.enabled !== undefined) {
      add("enabled = CASE WHEN ? = 1 THEN TRUE ELSE FALSE END", input.enabled);
    }
    if (input.expiresAt !== undefined) add('"expiresAt" = ?', input.expiresAt);
    if (input.maxUses !== undefined) add('"maxUses" = ?', input.maxUses);
    if (input.useCount !== undefined) add('"useCount" = ?', input.useCount);
    if (updates.length === 0) return;

    updates.push('"updatedAt" = datetime(\'now\')');
    params.push(linkId);
    await getAdapter().execute(
      `UPDATE notebook_share_links SET ${updates.join(", ")} WHERE id = ?`,
      params,
    );
  },
};
