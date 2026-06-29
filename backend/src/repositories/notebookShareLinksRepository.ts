/**
 * Notebook Share Links Repository
 *
 * 职责：
 * - 封装 notebook_share_links 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

function getAdapter() {
  return new SqliteAdapter(getDb());
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

export const notebookShareLinksRepository = {
  /**
   * 根据 token 获取分享链接详情（含笔记本和用户信息，检查启用和过期）。
   *
   * @param token 分享 token
   * @returns 分享链接信息，或 undefined
   */
  getByTokenWithDetails(token: string): {
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
  } | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT l.id, l.notebookId, l.role, l.enabled, l.expiresAt, l.createdAt,
                nb.name, nb.icon, nb.color,
                u.username AS ownerUsername, u.displayName AS ownerDisplayName
         FROM notebook_share_links l
         JOIN notebooks nb ON nb.id = l.notebookId
         JOIN users u ON u.id = nb.userId
         WHERE l.token = ?
           AND l.enabled = 1
           AND nb.isDeleted = 0
           AND (l.expiresAt IS NULL OR l.expiresAt > datetime('now'))`
      )
      .get(token) as any;
  },

  /**
   * 根据 token 获取启用的分享链接（检查启用和过期）。
   *
   * @param token 分享 token
   * @returns 分享链接信息，或 undefined
   */
  getEnabledByToken(token: string): {
    notebookId: string;
    role: string;
    createdBy: string;
    ownerId: string;
  } | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT l.notebookId, l.role, l.createdBy, nb.userId AS ownerId
         FROM notebook_share_links l
         JOIN notebooks nb ON nb.id = l.notebookId
         WHERE l.token = ?
           AND l.enabled = 1
           AND nb.isDeleted = 0
           AND (l.expiresAt IS NULL OR l.expiresAt > datetime('now'))`
      )
      .get(token) as any;
  },

  /**
   * 获取笔记本的最新启用分享链接。
   *
   * @param notebookId 笔记本 ID
   * @returns 分享链接记录，或 undefined
   */
  getLatestEnabledByNotebook(notebookId: string): NotebookShareLinkRecord | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, notebookId, token, role, enabled, expiresAt, createdBy, createdAt, updatedAt
         FROM notebook_share_links
         WHERE notebookId = ? AND enabled = 1
         ORDER BY createdAt DESC
         LIMIT 1`
      )
      .get(notebookId) as NotebookShareLinkRecord | undefined;
  },

  /**
   * 禁用笔记本的所有分享链接。
   *
   * @param notebookId 笔记本 ID
   */
  disableAllByNotebook(notebookId: string): void {
    const db = getDb();
    db.prepare(
      `UPDATE notebook_share_links
       SET enabled = 0, updatedAt = datetime('now')
       WHERE notebookId = ? AND enabled = 1`
    ).run(notebookId);
  },

  /**
   * 创建分享链接。
   *
   * @param input 分享链接数据
   */
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
      `INSERT INTO notebook_share_links (id, notebookId, token, role, enabled, expiresAt, createdBy)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    ).run(input.id, input.notebookId, input.token, input.role, input.expiresAt, input.createdBy);
  },

  /**
   * 获取分享链接详情。
   *
   * @param linkId 分享链接 ID
   * @returns 分享链接记录，或 undefined
   */
  getById(linkId: string): NotebookShareLinkRecord | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, notebookId, token, role, enabled, expiresAt, createdBy, createdAt, updatedAt
         FROM notebook_share_links
         WHERE id = ?`
      )
      .get(linkId) as NotebookShareLinkRecord | undefined;
  },

  /**
   * 更新分享链接。
   *
   * @param linkId 分享链接 ID
   * @param input 更新数据
   */
  update(linkId: string, input: {
    role?: string;
    enabled?: number;
    expiresAt?: string | null;
  }): void {
    const db = getDb();
    const updates: string[] = [];
    const params: any[] = [];

    if (input.role !== undefined) {
      updates.push("role = ?");
      params.push(input.role);
    }
    if (input.enabled !== undefined) {
      updates.push("enabled = ?");
      params.push(input.enabled);
    }
    if (input.expiresAt !== undefined) {
      updates.push("expiresAt = ?");
      params.push(input.expiresAt);
    }

    if (updates.length === 0) return;

    updates.push("updatedAt = datetime('now')");
    params.push(linkId);

    db.prepare(`UPDATE notebook_share_links SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  },

  async getByTokenWithDetailsAsync(token: string): Promise<{
    id: string; notebookId: string; role: string; enabled: number; expiresAt: string | null; createdAt: string;
    name: string; icon: string; color: string; ownerUsername: string; ownerDisplayName: string | null;
  } | undefined> {
    return getAdapter().queryOne(
      `SELECT l.id, l.notebookId, l.role, l.enabled, l.expiresAt, l.createdAt,
              nb.name, nb.icon, nb.color,
              u.username AS ownerUsername, u.displayName AS ownerDisplayName
       FROM notebook_share_links l
       JOIN notebooks nb ON nb.id = l.notebookId
       JOIN users u ON u.id = nb.userId
       WHERE l.token = ?
         AND l.enabled = 1
         AND nb.isDeleted = 0
         AND (l.expiresAt IS NULL OR l.expiresAt > datetime('now'))`,
      [token],
    );
  },

  async getEnabledByTokenAsync(token: string): Promise<{
    notebookId: string; role: string; createdBy: string; ownerId: string;
  } | undefined> {
    return getAdapter().queryOne(
      `SELECT l.notebookId, l.role, l.createdBy, nb.userId AS ownerId
       FROM notebook_share_links l
       JOIN notebooks nb ON nb.id = l.notebookId
       WHERE l.token = ?
         AND l.enabled = 1
         AND nb.isDeleted = 0
         AND (l.expiresAt IS NULL OR l.expiresAt > datetime('now'))`,
      [token],
    );
  },

  async getLatestEnabledByNotebookAsync(notebookId: string): Promise<NotebookShareLinkRecord | undefined> {
    return getAdapter().queryOne<NotebookShareLinkRecord>(
      `SELECT id, notebookId, token, role, enabled, expiresAt, createdBy, createdAt, updatedAt
       FROM notebook_share_links
       WHERE notebookId = ? AND enabled = 1
       ORDER BY createdAt DESC
       LIMIT 1`,
      [notebookId],
    );
  },

  async disableAllByNotebookAsync(notebookId: string): Promise<void> {
    await getAdapter().execute(
      `UPDATE notebook_share_links
       SET enabled = 0, updatedAt = datetime('now')
       WHERE notebookId = ? AND enabled = 1`,
      [notebookId],
    );
  },

  async createAsync(input: { id: string; notebookId: string; token: string; role: string; expiresAt: string | null; createdBy: string }): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO notebook_share_links (id, notebookId, token, role, enabled, expiresAt, createdBy)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [input.id, input.notebookId, input.token, input.role, input.expiresAt, input.createdBy],
    );
  },

  async getByIdAsync(linkId: string): Promise<NotebookShareLinkRecord | undefined> {
    return getAdapter().queryOne<NotebookShareLinkRecord>(
      `SELECT id, notebookId, token, role, enabled, expiresAt, createdBy, createdAt, updatedAt
       FROM notebook_share_links WHERE id = ?`,
      [linkId],
    );
  },

  async updateAsync(linkId: string, input: { role?: string; enabled?: number; expiresAt?: string | null }): Promise<void> {
    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.role !== undefined) { updates.push("role = ?"); params.push(input.role); }
    if (input.enabled !== undefined) { updates.push("enabled = ?"); params.push(input.enabled); }
    if (input.expiresAt !== undefined) { updates.push("expiresAt = ?"); params.push(input.expiresAt); }

    if (updates.length === 0) return;
    updates.push("updatedAt = datetime('now')");
    params.push(linkId);
    await getAdapter().execute(`UPDATE notebook_share_links SET ${updates.join(", ")} WHERE id = ?`, params);
  },
};
