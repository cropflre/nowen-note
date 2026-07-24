import { getDb } from "../db/schema";

export interface AttachmentPathEntryRecord {
  path: string;
  size: number;
  refs: number;
}

export interface AttachmentNoteReferenceRecord {
  id: string;
  title: string;
  notebookId: string | null;
  isTrashed: number;
  updatedAt: string;
  notebookName: string | null;
  notebookIcon: string | null;
}

export interface AttachmentUploadsSummaryRecord {
  total: number;
  referenced: number;
  unreferenced: number;
}

/** SQLite compatibility boundary for synchronous cross-table attachment queries. */
export const attachmentQueryRepository = {
  getUniqueAttachmentPaths(limit: number): AttachmentPathEntryRecord[] {
    return getDb()
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
      .all(limit) as AttachmentPathEntryRecord[];
  },

  countUniqueAttachmentPaths(): number {
    const row = getDb()
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

  getMyUploadsSummary(
    scope: "personal" | "workspace",
    userId: string,
    workspaceId?: string,
  ): AttachmentUploadsSummaryRecord {
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
    const row = getDb().prepare(sql).get(...args) as
      | { total: number; referenced: number }
      | undefined;
    const total = row?.total ?? 0;
    const referenced = row?.referenced ?? 0;
    return { total, referenced, unreferenced: total - referenced };
  },

  getNotesReferencingAttachment(
    attachmentId: string,
    scope: "personal" | "workspace",
    userId: string,
    workspaceId?: string,
  ): AttachmentNoteReferenceRecord[] {
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
    return getDb()
      .prepare(sql)
      .all(attachmentId, workspaceId ?? userId) as AttachmentNoteReferenceRecord[];
  },
};
