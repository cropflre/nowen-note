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
        `SELECT nv.id, nv.noteId, nv.userId, nv.title, nv.version, nv.changeType, nv.changeSummary, nv.createdAt,
                u.username
         FROM note_versions nv
         LEFT JOIN users u ON nv.userId = u.id
         WHERE nv.noteId = ?
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
      .prepare("SELECT COUNT(*) as count FROM note_versions WHERE noteId = ?")
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
      .prepare("SELECT * FROM note_versions WHERE id = ? AND noteId = ?")
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
        `SELECT createdAt FROM note_versions
         WHERE noteId = ? AND changeType = 'edit'
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
  }): void {
    const db = getDb();
    if (input.changeSummary !== undefined) {
      db.prepare(
        `INSERT INTO note_versions (id, noteId, userId, title, content, contentText, version, changeType, changeSummary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.title, input.content, input.contentText, input.version, input.changeType, input.changeSummary);
    } else {
      db.prepare(
        `INSERT INTO note_versions (id, noteId, userId, title, content, contentText, version, changeType)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.title, input.content, input.contentText, input.version, input.changeType);
    }
  },
};
