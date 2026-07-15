import { getDb } from "../db/schema";

export interface AttachmentSignedNoteRecord {
  noteId: string;
}

export interface AttachmentSignedShareRecord {
  noteId: string;
  isActive: number;
  expiresAt: string | null;
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
};
