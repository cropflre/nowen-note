/**
 * Note Links Repository
 *
 * 职责：
 * - 封装 note_links 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 *
 * 注意：
 * - C1: getBacklinks 只读查询
 * - C2: syncNoteLinks 写入操作（保持现有事务边界）
 * - routes/notes.ts 中的删除清理暂不迁移
 */

import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import type { BacklinkItem, NoteLinkEntry } from "./types";

export const noteLinksRepository = {
  /**
   * 获取目标笔记的所有反向链接（来源笔记）。
   *
   * 返回结构：
   *   - sourceNoteId: 来源笔记 ID
   *   - title: 来源笔记标题
   *   - updatedAt: 来源笔记更新时间
   *   - linkText: 引用时的显示文本（可选）
   *   - linkType: 'note' 或 'block'
   *   - targetBlockId: 被引用的块 ID（可选）
   *   - excerpt: 块级引用摘要（可选）
   *
   * 排除规则：
   *   - isTrashed = 1 的来源笔记
   *   - 无权限的来源笔记（调用方应已做过权限校验）
   */
  getBacklinks(
    userId: string,
    targetNoteId: string,
    limit: number = 50,
  ): BacklinkItem[] {
    try {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT
            nl.sourceNoteId,
            n.title,
            n.updatedAt,
            nl.linkText,
            nl.linkType,
            nl.targetBlockId,
            nl.excerpt
          FROM note_links nl
          JOIN notes n ON n.id = nl.sourceNoteId
          WHERE nl.userId = ?
            AND nl.targetNoteId = ?
            AND n.isTrashed = 0
          ORDER BY n.updatedAt DESC
          LIMIT ?`,
        )
        .all(userId, targetNoteId, limit) as BacklinkItem[];

      return rows;
    } catch (e) {
      console.warn("[noteLinksRepository.getBacklinks] failed:", e instanceof Error ? e.message : e);
      return [];
    }
  },

  /**
   * 全量替换 sourceNoteId 的引用关系。
   *
   * 行为保持现有 syncNoteLinks 的数据库行为：
   *   1. 先 DELETE 旧引用
   *   2. 如果 links 为空，直接 return
   *   3. 对每个 link 执行 target note 存在性校验
   *   4. 过滤掉不存在的 target note
   *   5. 如果 validEntries 为空，直接 return
   *   6. 使用 db.transaction() 包裹批量 INSERT
   *
   * 注意：DELETE 和 INSERT 不在同一个事务中，保持现有行为。
   */
  replaceLinksForSource(
    userId: string,
    sourceNoteId: string,
    links: NoteLinkEntry[],
  ): void {
    const db = getDb();

    // 1. 清除旧的引用关系
    db.prepare(
      "DELETE FROM note_links WHERE userId = ? AND sourceNoteId = ?",
    ).run(userId, sourceNoteId);

    // 2. 如果 links 为空，直接 return
    if (links.length === 0) return;

    // 3. 过滤掉不存在的 target note
    const validEntries: NoteLinkEntry[] = [];
    const checkStmt = db.prepare("SELECT id FROM notes WHERE id = ?");
    for (const link of links) {
      const exists = checkStmt.get(link.targetNoteId);
      if (exists) validEntries.push(link);
    }

    // 4. 如果 validEntries 为空，直接 return
    if (validEntries.length === 0) return;

    // 5. 批量插入新的引用关系（使用事务）
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO note_links (id, userId, sourceNoteId, targetNoteId, targetBlockId, linkType, linkText, excerpt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    const insertMany = db.transaction((entries: NoteLinkEntry[]) => {
      for (const link of entries) {
        insertStmt.run(
          uuid(),
          userId,
          sourceNoteId,
          link.targetNoteId,
          link.targetBlockId,
          link.linkType,
          link.linkText,
          link.excerpt,
        );
      }
    });

    insertMany(validEntries);
  },
};
