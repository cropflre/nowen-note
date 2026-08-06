import { getDb } from "../db/schema";

export interface AttachmentSignedNoteRecord {
  noteId: string;
}

export interface AttachmentSignedShareRecord {
  noteId: string;
  isActive: number;
  expiresAt: string | null;
}

export interface AttachmentSignedPublicationRecord {
  isActive: number;
  expiresAt: string | null;
  allowDownload: number;
}

/**
 * SQLite compatibility boundary for synchronous signed attachment verification.
 * The public signing helpers remain synchronous so existing attachment routes do
 * not change their response or streaming contracts during #248.
 */
export const attachmentSignedAccessRepository = {
  findAttachmentNote(attachmentId: string): AttachmentSignedNoteRecord | undefined {
    return getDb()
      .prepare('SELECT "noteId" FROM attachments WHERE id = ?')
      .get(attachmentId) as AttachmentSignedNoteRecord | undefined;
  },

  findShare(shareId: string): AttachmentSignedShareRecord | undefined {
    return getDb()
      .prepare(
        'SELECT "noteId", "isActive", "expiresAt" FROM shares WHERE id = ?',
      )
      .get(shareId) as AttachmentSignedShareRecord | undefined;
  },

  findPublication(
    publicationId: string,
    noteId: string,
  ): AttachmentSignedPublicationRecord | undefined {
    return getDb().prepare(`
      WITH RECURSIVE published_tree(id) AS (
        SELECT p."notebookId"
        FROM notebook_publications p
        JOIN notebooks root ON root.id = p."notebookId"
        WHERE p.id = ? AND root."isDeleted" = 0
        UNION ALL
        SELECT child.id
        FROM notebooks child
        JOIN published_tree tree ON child."parentId" = tree.id
        WHERE child."isDeleted" = 0
      )
      SELECT p."isActive", p."expiresAt", p."allowDownload"
      FROM notebook_publications p
      JOIN notes n ON n.id = ?
      WHERE p.id = ?
        AND n."notebookId" IN (SELECT id FROM published_tree)
        AND n."isTrashed" = 0
        AND n."isLocked" = 0
    `).get(publicationId, noteId, publicationId) as
      | AttachmentSignedPublicationRecord
      | undefined;
  },
};
