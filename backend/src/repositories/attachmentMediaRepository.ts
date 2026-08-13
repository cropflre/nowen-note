import { getDatabaseAdapter } from "../db/runtime";

export interface MediaAttachmentRecord {
  id: string;
  noteId: string;
  mimeType: string;
  path: string;
  filename: string;
  size: number;
}

/** Read and repair metadata required by audio/video range responses. */
export const attachmentMediaRepository = {
  async getByIdAsync(attachmentId: string): Promise<MediaAttachmentRecord | undefined> {
    return getDatabaseAdapter().queryOne<MediaAttachmentRecord>(
      'SELECT id, "noteId", "mimeType", path, filename, size FROM attachments WHERE id = ?',
      [attachmentId],
    );
  },

  async repairGenericMimeAsync(attachmentId: string, mimeType: string): Promise<void> {
    await getDatabaseAdapter().execute(
      `UPDATE attachments
       SET "mimeType" = ?
       WHERE id = ?
         AND ("mimeType" IS NULL OR "mimeType" = '' OR "mimeType" = 'application/octet-stream')`,
      [mimeType, attachmentId],
    );
  },
};
