/**
 * Tags Repository
 *
 * 职责：
 * - 封装 tags 表的只读查询操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 *
 * 注意：
 * - D1-A 阶段只迁移 GET /tags 列表查询
 * - 创建/更新/删除标签暂不迁移
 * - note_tags 绑定/解绑暂不迁移
 * - 导入导出/用户迁移暂不迁移
 */

import { getDb } from "../db/schema";
import type { Tag, TagWithCount } from "./types";

export const tagsRepository = {
  /**
   * 列出当前空间的标签 + 笔记数。
   *
   * 笔记数采用空间内口径：只统计与该 tag 关联、且笔记同样落在该空间的笔记。
   *
   * @param userId 用户 ID
   * @param workspaceId 工作区 ID（null = 个人空间）
   * @param includeEmpty 是否包含未使用的标签
   */
  listByUser(
    userId: string,
    workspaceId: string | null = null,
    includeEmpty: boolean = false,
  ): TagWithCount[] {
    const db = getDb();
    const havingClause = includeEmpty ? "" : "HAVING COUNT(nt.noteId) > 0";

    if (workspaceId) {
      // 工作区视角
      return db
        .prepare(
          `
          SELECT t.*, COUNT(nt.noteId) AS noteCount
          FROM tags t
          LEFT JOIN note_tags nt ON nt.tagId = t.id
          LEFT JOIN notes n ON n.id = nt.noteId AND n.workspaceId = ? AND n.isTrashed = 0
          WHERE t.workspaceId = ?
          GROUP BY t.id
          ${havingClause}
          ORDER BY t.name ASC
          `,
        )
        .all(workspaceId, workspaceId) as TagWithCount[];
    } else {
      // 个人空间：仅看自己的、且 workspaceId IS NULL 的标签
      return db
        .prepare(
          `
          SELECT t.*, COUNT(nt.noteId) AS noteCount
          FROM tags t
          LEFT JOIN note_tags nt ON nt.tagId = t.id
          LEFT JOIN notes n ON n.id = nt.noteId
                            AND (n.workspaceId IS NULL)
                            AND n.userId = ?
                            AND n.isTrashed = 0
          WHERE t.userId = ? AND t.workspaceId IS NULL
          GROUP BY t.id
          ${havingClause}
          ORDER BY t.name ASC
          `,
        )
        .all(userId, userId) as TagWithCount[];
    }
  },

  /**
   * 获取单个标签的所有者信息（用于 ACL 校验）。
   *
   * @param tagId 标签 ID
   * @returns 标签所有者信息，或 undefined（标签不存在）
   */
  getOwner(tagId: string): { userId: string; workspaceId: string | null } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT userId, workspaceId FROM tags WHERE id = ?")
      .get(tagId) as { userId: string; workspaceId: string | null } | undefined;
  },

  /**
   * 获取单个标签（按 ID）。
   *
   * @param tagId 标签 ID
   * @returns 标签信息，或 undefined（标签不存在）
   */
  getById(tagId: string): Tag | undefined {
    const db = getDb();
    return db
      .prepare("SELECT * FROM tags WHERE id = ?")
      .get(tagId) as Tag | undefined;
  },

  /**
   * 获取单个标签（按 ID，含笔记数）。
   *
   * @param tagId 标签 ID
   * @returns 标签信息（含笔记数），或 undefined（标签不存在）
   */
  getByIdWithCount(tagId: string): TagWithCount | undefined {
    const db = getDb();
    return db
      .prepare(
        `
        SELECT t.*, COUNT(nt.noteId) AS noteCount
        FROM tags t LEFT JOIN note_tags nt ON t.id = nt.tagId
        WHERE t.id = ? GROUP BY t.id
        `,
      )
      .get(tagId) as TagWithCount | undefined;
  },
};
