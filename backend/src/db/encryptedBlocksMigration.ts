import type { Migration } from "./migrations.impl.js";

export const encryptedBlocksMigration: Migration = {
  version: 118,
  name: "encrypted-block-write-guards",
  up(db) {
    // Current writers grant an exact target inside the same synchronous transaction.
    // No permit survives commit; old connections need no custom SQLite functions.
    db.exec(`
      CREATE TABLE encrypted_block_write_permits (
        noteId TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        contentFormat TEXT NOT NULL
      );
      CREATE TRIGGER encrypted_blocks_update BEFORE UPDATE OF content, contentFormat ON notes
      WHEN (NEW.content IS NOT OLD.content OR NEW.contentFormat IS NOT OLD.contentFormat)
        AND (instr(lower(OLD.content), 'nowen-encrypted') > 0 OR instr(lower(NEW.content), 'nowen-encrypted') > 0)
        AND NOT EXISTS (SELECT 1 FROM encrypted_block_write_permits
          WHERE noteId = NEW.id AND content IS NEW.content AND contentFormat IS NEW.contentFormat)
      BEGIN SELECT RAISE(ABORT, 'ENCRYPTED_BLOCK_WRITE_FORBIDDEN'); END;
    `);
  },
};
