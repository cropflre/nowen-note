/**
 * Note Versions Repository
 *
 * 职责：
 * - 封装 note_versions 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 *
 * 注意：
 * - 已迁移：查询类 SQL（B2-B1）、创建版本 INSERT（B2-B2）
 * - 未迁移：删除版本 DELETE / pruneOldVersions / 恢复版本事务
 * - 不涉及 notes 主表 CRUD
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

function getAdapter() {
  return new SqliteAdapter(getDb());
}

/** note_versions 记录（列表视图，不含 content/contentText） */
export interface NoteVersionListItem {
  id: string;
  noteId: string;
  userId: string;
  title: string | null;
  version: number;
  changeType: string;
  changeSummary: string | null;
  createdAt: string;
  username: string | null;
}

/** note_versions 完整记录 */
export interface NoteVersionRecord {
  id: string;
  noteId: string;
  userId: string;
  title: string | null;
  content: string | null;
  contentText: string | null;
  version: number;
  changeType: string;
  changeSummary: string | null;
  createdAt: string;
}

export const noteVersionsRepository = {
  /**
   * 列出某笔记的版本历史（分页）。
   *
   * 保持原 SQL：JOIN users 获取 username，按 version DESC 排序。
   *
   * @param noteId 笔记 ID
   * @param limit 每页条数
   * @param offset 偏移量
   * @returns 版本列表
   */
  listByNoteId(noteId: string, limit: number, offset: number): NoteVersionListItem[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT nv.id, nv."noteId", nv."userId", nv.title, nv.version, nv."changeType", nv."changeSummary", nv."createdAt",
                u.username
         FROM note_versions nv
         LEFT JOIN users u ON nv."userId" = u.id
         WHERE nv."noteId" = ?
         ORDER BY nv.version DESC
         LIMIT ? OFFSET ?`,
      )
      .all(noteId, limit, offset) as NoteVersionListItem[];
  },

  /**
   * 统计某笔记的版本总数。
   *
   * @param noteId 笔记 ID
   * @returns 版本总数
   */
  countByNoteId(noteId: string): number {
    const db = getDb();
    const row = db
      .prepare('SELECT COUNT(*) as count FROM note_versions WHERE "noteId" = ?')
      .get(noteId) as { count: number };
    return row.count;
  },

  /**
   * 获取单个版本（按 id + noteId）。
   *
   * 用于查看单个版本和恢复前读取版本。
   *
   * @param id 版本 ID
   * @param noteId 笔记 ID
   * @returns 版本记录，或 undefined
   */
  getByIdAndNoteId(id: string, noteId: string): NoteVersionRecord | undefined {
    const db = getDb();
    return db
      .prepare('SELECT * FROM note_versions WHERE id = ? AND "noteId" = ?')
      .get(id, noteId) as NoteVersionRecord | undefined;
  },

  /**
   * 获取某笔记最近一条 edit 类型版本的 createdAt。
   *
   * 用于 notes.ts 中 5 分钟窗口判断。只迁移 SELECT 查询，
   * 5 分钟窗口判断逻辑仍留在 route。
   *
   * @param noteId 笔记 ID
   * @returns 最近 edit 版本的 createdAt，或 undefined
   */
  getLastEditByNoteId(noteId: string): { createdAt: string } | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT "createdAt" FROM note_versions
         WHERE "noteId" = ? AND "changeType" = 'edit'
         ORDER BY version DESC
         LIMIT 1`,
      )
      .get(noteId) as { createdAt: string } | undefined;
  },

  /**
   * 创建版本记录。
   *
   * 用于：
   * - 编辑保存时记录修改前状态（changeType='edit'）
   * - 访客编辑时记录修改前状态（changeType='guest_edit'）
   * - 恢复版本前备份当前状态（changeType='restore'）
   *
   * @param input 版本数据
   */
  create(input: {
    id: string;
    noteId: string;
    userId: string;
    title: string;
    content: string;
    contentText: string;
    version: number;
    changeType: 'edit' | 'guest_edit' | 'restore';
    changeSummary?: string;
    /** 仅在用户迁移导入时传入，保留原始时间戳；不传则由 DB 默认值决定 */
    createdAt?: string;
  }): void {
    const db = getDb();
    const hasChangeSummary = input.changeSummary !== undefined;
    const hasCreatedAt = input.createdAt !== undefined;

    if (hasChangeSummary && hasCreatedAt) {
      db.prepare(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", version, "changeType", "changeSummary", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.title, input.content, input.contentText, input.version, input.changeType, input.changeSummary, input.createdAt);
    } else if (hasChangeSummary) {
      db.prepare(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", version, "changeType", "changeSummary")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.title, input.content, input.contentText, input.version, input.changeType, input.changeSummary);
    } else if (hasCreatedAt) {
      db.prepare(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", version, "changeType", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.title, input.content, input.contentText, input.version, input.changeType, input.createdAt);
    } else {
      db.prepare(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", version, "changeType")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.title, input.content, input.contentText, input.version, input.changeType);
    }
  },

  /**
   * 删除某笔记的全部版本历史。
   *
   * 用于清空某笔记的版本历史。
   *
   * @param noteId 笔记 ID
   * @returns 删除的行数
   */
  deleteByNoteId(noteId: string): number {
    const db = getDb();
    const result = db.prepare('DELETE FROM note_versions WHERE "noteId" = ?').run(noteId);
    return result.changes;
  },

  /**
   * 清理旧版本（保留最近 N 条 + M 天内的全部条目）。
   *
   * 策略：
   * - 只删 changeType = 'edit' 的版本
   * - 保留最近 keepRecent 条
   * - 保留 createdAt 在 keepDays 天内的全部条目
   * - 使用关联子查询定位每篇笔记的 top-N
   *
   * @param keepRecent 保留最近条数
   * @param keepDays 保留天数
   * @returns 删除的行数
   */
  pruneOldVersions(keepRecent: number, keepDays: number): number {
    const db = getDb();
    const cutoff = `datetime('now', '-${keepDays} days')`;
    const result = db.prepare(`
      DELETE FROM note_versions
      WHERE "changeType" = 'edit'
        AND "createdAt" < ${cutoff}
        AND id NOT IN (
          SELECT id FROM note_versions v2
          WHERE v2."noteId" = note_versions."noteId"
            AND v2."changeType" = 'edit'
          ORDER BY v2.version DESC
          LIMIT ?
        )
    `).run(keepRecent);
    return result.changes;
  },

  /**
   * 按 noteIds 批量查询版本记录。
   *
   * 用于用户迁移导出（export-light），按 noteId 集合一次性拉出所有版本。
   * 空集合返回空数组（调用方短路）。
   *
   * @param noteIds 笔记 ID 列表
   * @returns 版本记录列表
   */
  listByNoteIds(noteIds: string[]): NoteVersionRecord[] {
    if (noteIds.length === 0) return [];
    const db = getDb();
    const placeholders = noteIds.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, "noteId", "userId", title, content, "contentText", version,
                "changeType", "changeSummary", "createdAt"
         FROM note_versions
         WHERE "noteId" IN (${placeholders})`,
      )
      .all(...noteIds) as NoteVersionRecord[];
  },

  /**
   * 统计用户的版本数量。
   *
   * @param userId 用户 ID
   * @returns 版本数量
   */
  countByUser(userId: string): number {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as c FROM note_versions WHERE "userId" = ?').get(userId) as { c: number };
    return row.c;
  },

  /**
   * 转移用户（用户迁移时使用）。
   *
   * @param fromUserId 源用户 ID
   * @param toUserId 目标用户 ID
   * @returns 更新的行数
   */
  transferOwnership(fromUserId: string, toUserId: string): number {
    const db = getDb();
    const result = db.prepare('UPDATE note_versions SET "userId" = ? WHERE "userId" = ?').run(toUserId, fromUserId);
    return result.changes;
  },

  async listByNoteIdAsync(noteId: string, limit: number, offset: number): Promise<NoteVersionListItem[]> {
    return getAdapter().queryMany<NoteVersionListItem>(
      `SELECT nv.id, nv."noteId", nv."userId", nv.title, nv.version, nv."changeType", nv."changeSummary", nv."createdAt",
              u.username
       FROM note_versions nv
       LEFT JOIN users u ON nv."userId" = u.id
       WHERE nv."noteId" = ?
       ORDER BY nv.version DESC
       LIMIT ? OFFSET ?`,
      [noteId, limit, offset],
    );
  },

  async countByNoteIdAsync(noteId: string): Promise<number> {
    const row = await getAdapter().queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM note_versions WHERE "noteId" = ?',
      [noteId],
    );
    return row?.count ?? 0;
  },

  async getByIdAndNoteIdAsync(id: string, noteId: string): Promise<NoteVersionRecord | undefined> {
    return getAdapter().queryOne<NoteVersionRecord>(
      'SELECT * FROM note_versions WHERE id = ? AND "noteId" = ?',
      [id, noteId],
    );
  },

  async getLastEditByNoteIdAsync(noteId: string): Promise<{ createdAt: string } | undefined> {
    return getAdapter().queryOne<{ createdAt: string }>(
      `SELECT "createdAt" FROM note_versions
       WHERE "noteId" = ? AND "changeType" = 'edit'
       ORDER BY version DESC
       LIMIT 1`,
      [noteId],
    );
  },

  async createAsync(input: {
    id: string;
    noteId: string;
    userId: string;
    title: string;
    content: string;
    contentText: string;
    version: number;
    changeType: 'edit' | 'guest_edit' | 'restore';
    changeSummary?: string;
    createdAt?: string;
  }): Promise<void> {
    const hasChangeSummary = input.changeSummary !== undefined;
    const hasCreatedAt = input.createdAt !== undefined;

    if (hasChangeSummary && hasCreatedAt) {
      await getAdapter().execute(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", version, "changeType", "changeSummary", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.noteId, input.userId, input.title, input.content, input.contentText, input.version, input.changeType, input.changeSummary, input.createdAt],
      );
    } else if (hasChangeSummary) {
      await getAdapter().execute(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", version, "changeType", "changeSummary")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.noteId, input.userId, input.title, input.content, input.contentText, input.version, input.changeType, input.changeSummary],
      );
    } else if (hasCreatedAt) {
      await getAdapter().execute(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", version, "changeType", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.noteId, input.userId, input.title, input.content, input.contentText, input.version, input.changeType, input.createdAt],
      );
    } else {
      await getAdapter().execute(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", version, "changeType")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.noteId, input.userId, input.title, input.content, input.contentText, input.version, input.changeType],
      );
    }
  },

  async deleteByNoteIdAsync(noteId: string): Promise<number> {
    const result = await getAdapter().execute(
      'DELETE FROM note_versions WHERE "noteId" = ?',
      [noteId],
    );
    return result.changes;
  },

  async pruneOldVersionsAsync(keepRecent: number, keepDays: number): Promise<number> {
    const cutoff = `datetime('now', '-${keepDays} days')`;
    const result = await getAdapter().execute(
      `DELETE FROM note_versions
       WHERE "changeType" = 'edit'
         AND "createdAt" < ${cutoff}
         AND id NOT IN (
           SELECT id FROM note_versions v2
           WHERE v2."noteId" = note_versions."noteId"
             AND v2."changeType" = 'edit'
           ORDER BY v2.version DESC
           LIMIT ?
         )`,
      [keepRecent],
    );
    return result.changes;
  },

  async listByNoteIdsAsync(noteIds: string[]): Promise<NoteVersionRecord[]> {
    if (noteIds.length === 0) return [];
    const placeholders = noteIds.map(() => "?").join(",");
    return getAdapter().queryMany<NoteVersionRecord>(
      `SELECT id, "noteId", "userId", title, content, "contentText", version,
              "changeType", "changeSummary", "createdAt"
       FROM note_versions
       WHERE "noteId" IN (${placeholders})`,
      noteIds,
    );
  },

  async countByUserAsync(userId: string): Promise<number> {
    const row = await getAdapter().queryOne<{ c: number }>(
      'SELECT COUNT(*) as c FROM note_versions WHERE "userId" = ?',
      [userId],
    );
    return row?.c ?? 0;
  },

  async transferOwnershipAsync(fromUserId: string, toUserId: string): Promise<number> {
    const result = await getAdapter().execute(
      'UPDATE note_versions SET "userId" = ? WHERE "userId" = ?',
      [toUserId, fromUserId],
    );
    return result.changes;
  },
};
