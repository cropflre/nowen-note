/**
 * Attachment Query Service
 *
 * 职责：
 * - 承接附件域跨表复杂查询（UNION ALL / EXISTS / 多表 JOIN）
 * - 不处理 HTTP / 鉴权 / 文件删除 / 对象存储
 * - 使用 getDb() 获取数据库实例
 * - 返回与原 SQL 一致的数据结构
 *
 * 设计原则：
 * - 单表 CRUD 仍由各 Repository 负责
 * - 跨表查询、复杂搜索、统计归 QueryService
 * - 未来 PostgreSQL 接入时，只需为 QueryService 提供 pg 实现
 */

import { getDb } from "../db/schema";

export interface AttachmentPathEntry {
  path: string;
  size: number;
  refs: number;
}

export interface NoteReference {
  id: string;
  title: string;
  notebookId: string | null;
  isTrashed: number;
  updatedAt: string;
  notebookName: string | null;
  notebookIcon: string | null;
}

export interface MyUploadsSummary {
  total: number;
  referenced: number;
  unreferenced: number;
}

export const attachmentQueryService = {
  /**
   * 获取所有已注册附件的唯一路径列表（含引用计数）。
   *
   * 跨 attachments / diary_attachments / task_attachments 三表 UNION ALL。
   * 用于存储管理页面展示磁盘占用。
   *
   * @param limit 返回条数上限
   * @returns 路径列表，每条包含 path、size、refs
   */
  getUniqueAttachmentPaths(limit: number): AttachmentPathEntry[] {
    const db = getDb();
    return db
      .prepare(
        `WITH all_paths AS (
           SELECT path, size FROM attachments
           UNION ALL
           SELECT path, size FROM diary_attachments
           UNION ALL
           SELECT path, size FROM task_attachments
         )
         SELECT path, MAX(size) AS size, COUNT(*) AS refs
         FROM all_paths
         WHERE path IS NOT NULL AND path <> ''
         GROUP BY path
         ORDER BY path
         LIMIT ?`,
      )
      .all(limit) as AttachmentPathEntry[];
  },

  /**
   * 统计所有已注册附件的唯一路径数量。
   *
   * 跨 attachments / diary_attachments / task_attachments 三表 UNION ALL。
   * 用于存储管理页面展示总数。
   *
   * @returns 唯一路径数量
   */
  countUniqueAttachmentPaths(): number {
    const db = getDb();
    const row = db
      .prepare(
        `WITH all_paths AS (
           SELECT path FROM attachments
           UNION ALL
           SELECT path FROM diary_attachments
           UNION ALL
           SELECT path FROM task_attachments
         )
         SELECT COUNT(DISTINCT path) AS count
         FROM all_paths
         WHERE path IS NOT NULL AND path <> ''`,
      )
      .get() as { count: number } | undefined;
    return row?.count || 0;
  },

  /**
   * 统计"我的上传"的引用状态摘要。
   *
   * 跨 attachments + attachment_references，使用 EXISTS 子查询。
   * 用于文件管理页面展示"我的上传"统计。
   *
   * @param scope 可见范围：personal（userId）或 workspace（workspaceId）
   * @param userId 用户 ID
   * @param workspaceId 工作区 ID（scope=workspace 时必填）
   * @returns total / referenced / unreferenced
   */
  getMyUploadsSummary(
    scope: "personal" | "workspace",
    userId: string,
    workspaceId?: string,
  ): MyUploadsSummary {
    const db = getDb();
    const { sql, args } =
      scope === "workspace"
        ? {
            sql: `SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN EXISTS(
                      SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id
                    ) THEN 1 ELSE 0 END) AS referenced
                  FROM attachments a
                  WHERE a.workspaceId = ? AND a.uploadSource = 'file_manager'`,
            args: [workspaceId!] as (string | number)[],
          }
        : {
            sql: `SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN EXISTS(
                      SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id
                    ) THEN 1 ELSE 0 END) AS referenced
                  FROM attachments a
                  WHERE a.userId = ? AND a.workspaceId IS NULL AND a.uploadSource = 'file_manager'`,
            args: [userId] as (string | number)[],
          };
    const sumRow = db.prepare(sql).get(...args) as
      | { total: number; referenced: number }
      | undefined;
    const total = sumRow?.total ?? 0;
    const referenced = sumRow?.referenced ?? 0;
    return { total, referenced, unreferenced: total - referenced };
  },

  /**
   * 获取引用指定附件的笔记列表（含笔记本信息）。
   *
   * 跨 attachment_references + notes + notebooks 三表 JOIN。
   * 用于文件管理页面展示"谁在用这个附件"。
   *
   * @param attachmentId 附件 ID
   * @param scope 可见范围：personal（userId）或 workspace（workspaceId）
   * @param userId 用户 ID
   * @param workspaceId 工作区 ID（scope=workspace 时必填）
   * @returns 笔记列表
   */
  getNotesReferencingAttachment(
    attachmentId: string,
    scope: "personal" | "workspace",
    userId: string,
    workspaceId?: string,
  ): NoteReference[] {
    const db = getDb();
    const sql =
      scope === "workspace"
        ? `SELECT n.id, n.title, n.notebookId, n.isTrashed, n.updatedAt,
                  nb.name AS notebookName, nb.icon AS notebookIcon
           FROM attachment_references ar
           INNER JOIN notes n ON n.id = ar.noteId
           LEFT JOIN notebooks nb ON nb.id = n.notebookId
          WHERE ar.attachmentId = ?
            AND n.workspaceId = ?
          ORDER BY n.updatedAt DESC`
        : `SELECT n.id, n.title, n.notebookId, n.isTrashed, n.updatedAt,
                  nb.name AS notebookName, nb.icon AS notebookIcon
           FROM attachment_references ar
           INNER JOIN notes n ON n.id = ar.noteId
           LEFT JOIN notebooks nb ON nb.id = n.notebookId
          WHERE ar.attachmentId = ?
            AND n.userId = ? AND n.workspaceId IS NULL
          ORDER BY n.updatedAt DESC`;
    return db.prepare(sql).all(attachmentId, workspaceId ?? userId) as NoteReference[];
  },
};
