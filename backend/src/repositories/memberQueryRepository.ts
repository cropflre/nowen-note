import { getDb } from "../db/schema";

export interface NotebookMemberAccessRow {
  role: string;
  sourceNotebookId: string;
  depth: number;
  source: "override" | "member";
  allowDownload?: number;
  allowReshare?: number;
}

export function ensureNotebookAclOverridesTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS notebook_acl_overrides (
      notebookId TEXT NOT NULL,
      userId TEXT NOT NULL,
      permission TEXT NOT NULL CHECK(permission IN ('none', 'read', 'comment', 'write', 'manage')),
      allowDownload INTEGER NOT NULL DEFAULT 1,
      allowReshare INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (notebookId, userId),
      FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notebook_acl_user
      ON notebook_acl_overrides(userId, notebookId);
  `);
}

function getNotebookMemberAccess(
  notebookId: string,
  userId: string,
): NotebookMemberAccessRow | undefined {
  ensureNotebookAclOverridesTable();
  return getDb().prepare(`
    WITH RECURSIVE ancestors(id, parentId, depth) AS (
      SELECT id, parentId, 0
      FROM notebooks
      WHERE id = ? AND isDeleted = 0
      UNION ALL
      SELECT parent.id, parent.parentId, ancestors.depth + 1
      FROM notebooks parent
      JOIN ancestors ON parent.id = ancestors.parentId
      WHERE parent.isDeleted = 0
    ), candidates AS (
      SELECT
        acl.permission AS role,
        ancestors.id AS sourceNotebookId,
        ancestors.depth AS depth,
        'override' AS source,
        acl.allowDownload AS allowDownload,
        acl.allowReshare AS allowReshare,
        0 AS sourcePriority
      FROM ancestors
      JOIN notebook_acl_overrides acl
        ON acl.notebookId = ancestors.id AND acl.userId = ?

      UNION ALL

      SELECT
        nm.role AS role,
        ancestors.id AS sourceNotebookId,
        ancestors.depth AS depth,
        'member' AS source,
        1 AS allowDownload,
        CASE WHEN nm.role = 'owner' THEN 1 ELSE 0 END AS allowReshare,
        1 AS sourcePriority
      FROM ancestors
      JOIN notebook_members nm
        ON nm.notebookId = ancestors.id
       AND nm.userId = ?
       AND nm.status = 'active'
    )
    SELECT role, sourceNotebookId, depth, source, allowDownload, allowReshare
    FROM candidates
    ORDER BY depth ASC, sourcePriority ASC
    LIMIT 1
  `).get(notebookId, userId, userId) as NotebookMemberAccessRow | undefined;
}

export const memberQueryRepository = {
  getNotebookMemberAccess,

  getNotebookMemberRole(
    notebookId: string,
    userId: string,
  ): { role: string } | undefined {
    const access = getNotebookMemberAccess(notebookId, userId);
    return access ? { role: access.role } : undefined;
  },

  getNoteNotebookMemberAccess(
    noteId: string,
    userId: string,
  ): NotebookMemberAccessRow | undefined {
    const note = getDb()
      .prepare("SELECT notebookId FROM notes WHERE id = ? AND isTrashed = 0")
      .get(noteId) as { notebookId: string } | undefined;
    if (!note?.notebookId) return undefined;
    return getNotebookMemberAccess(note.notebookId, userId);
  },

  getNoteNotebookMemberRole(
    noteId: string,
    userId: string,
  ): { role: string } | undefined {
    const access = this.getNoteNotebookMemberAccess(noteId, userId);
    return access ? { role: access.role } : undefined;
  },

  listSharedNotebookIds(userId: string): string[] {
    const rows = getDb()
      .prepare(
        `SELECT nm.notebookId
           FROM notebook_members nm
           JOIN notebooks nb ON nb.id = nm.notebookId
          WHERE nm.userId = ?
            AND nm.status = 'active'
            AND nb.userId <> ?
            AND nb.isDeleted = 0
          ORDER BY nb.updatedAt DESC, nb.id ASC`,
      )
      .all(userId, userId) as { notebookId: string }[];
    return rows.map((row) => row.notebookId);
  },
};
