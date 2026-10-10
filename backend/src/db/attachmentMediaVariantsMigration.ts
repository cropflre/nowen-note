import type { Migration } from "./migrations.impl.js";

export const attachmentMediaVariantsMigration: Migration = {
  version: 113,
  name: "attachment-media-variants",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachment_media_variants (
        sourceAttachmentId TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        variantAttachmentId TEXT REFERENCES attachments(id) ON DELETE SET NULL,
        storagePath TEXT,
        mimeType TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (sourceAttachmentId, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_attachment_media_companion
        ON attachment_media_variants(variantAttachmentId);
    `);
  },
};
