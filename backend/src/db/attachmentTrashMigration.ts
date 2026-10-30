import type { Migration } from "./migrations.impl.js";

export const attachmentTrashMigration: Migration = {
  version: 128,
  name: "attachment-recycle-bin",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(attachments)").all() as { name: string }[];
    for (const name of ["trashedAt", "trashedBy", "originalFolderId"]) {
      if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE attachments ADD COLUMN ${name} TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_trash ON attachments(userId,workspaceId,trashedAt);
      CREATE TRIGGER IF NOT EXISTS attachments_trash_retention BEFORE DELETE ON attachments
      WHEN OLD.trashedAt IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'ATTACHMENT_TRASH_RETAINED'); END;`);
  },
};
