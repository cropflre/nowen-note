import type { Migration } from "./migrations.impl.js";

/** A private exact-target permit, inserted and consumed by one synchronous transaction. */
export const encryptedNoteConversionMigration: Migration = {
  version: 119,
  name: "encrypted-note-conversion-guards",
  up(db) {
    db.exec(`
      CREATE TABLE encrypted_note_conversion_permits (
        noteId TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
        sourceVersion INTEGER NOT NULL,
        sourceFormat TEXT NOT NULL CHECK (sourceFormat IN ('markdown', 'tiptap-json')),
        content TEXT NOT NULL
      );
    `);
    // Retain every v117 validation/identity rule; only replace the unconditional
    // ordinary-to-encrypted rejection with the exact conversion target check.
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'encrypted_notes_update'").get() as { sql: string };
    const previous = "OR (OLD.contentFormat NOT LIKE 'encrypted-%' AND NEW.contentFormat LIKE 'encrypted-%')";
    if (!row?.sql.includes(previous)) throw new Error("ENCRYPTED_NOTE_GUARD_MIGRATION_MISMATCH");
    const next = `OR (OLD.contentFormat NOT LIKE 'encrypted-%' AND NEW.contentFormat LIKE 'encrypted-%'
      AND NOT EXISTS (SELECT 1 FROM encrypted_note_conversion_permits p WHERE p.noteId = OLD.id
        AND p.sourceVersion IS OLD.version AND p.sourceFormat IS OLD.contentFormat
        AND p.content IS NEW.content AND NEW.contentFormat IS 'encrypted-note-v1'
        AND NEW.contentText IS '' AND NEW.version IS OLD.version + 1
        AND NEW.id IS OLD.id AND NEW.userId IS OLD.userId AND NEW.workspaceId IS OLD.workspaceId
        AND OLD.workspaceId IS NULL AND OLD.isLocked = 0 AND OLD.isTrashed = 0
        AND CASE WHEN json_valid(NEW.content) THEN
          json_extract(NEW.content, '$.originalFormat') IS OLD.contentFormat
          AND json_extract(NEW.content, '$.kind') IS 'note' ELSE 0 END))`;
    db.exec(`DROP TRIGGER encrypted_notes_update; ${row.sql.replace(previous, next)};`);
    // The original v117 trigger validates NEW for already encrypted notes. Ensure
    // a permitted transition gets those same envelope checks as well.
    const insert = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'encrypted_notes_insert'").get() as { sql: string };
    if (!insert?.sql.includes("BEFORE INSERT ON notes")) throw new Error("ENCRYPTED_NOTE_GUARD_MIGRATION_MISMATCH");
    db.exec(insert.sql.replace("encrypted_notes_insert", "encrypted_notes_conversion_validate")
      .replace("BEFORE INSERT ON notes", "BEFORE UPDATE ON notes"));

    for (const name of ["notes_embed_ai", "notes_embed_au"]) {
      const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string };
      if (!trigger?.sql.includes("new.isTrashed = 0")) throw new Error("ENCRYPTED_EMBEDDING_GUARD_MIGRATION_MISMATCH");
      db.exec(`DROP TRIGGER ${name}; ${trigger.sql.replace("new.isTrashed = 0", "new.isTrashed = 0 AND new.contentFormat NOT LIKE 'encrypted-%'")};`);
    }
    // Late block, collaboration receipt, import and embedding writers cannot
    // recreate derived plaintext after an authorized conversion.
    for (const table of ["note_block_operations", "block_operations", "note_block_attachment_refs", "yjs_operation_receipts", "embedding_queue", "note_import_origins"]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
      for (const operation of ["INSERT", "UPDATE"]) db.exec(`
        CREATE TRIGGER encrypted_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
        WHEN EXISTS (SELECT 1 FROM notes WHERE id = NEW.noteId AND contentFormat LIKE 'encrypted-%')
        BEGIN SELECT RAISE(ABORT, 'ENCRYPTED_NOTE_DERIVED_CONTENT_FORBIDDEN'); END;
      `);
    }
  },
};
