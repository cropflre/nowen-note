import type { Migration } from "./migrations.impl.js";

/** Only the owner conversion transaction can authorize an exact plaintext target. */
export const encryptedNoteDecryptionMigration: Migration = {
  version: 135,
  name: "encrypted-note-decryption-guards",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS encrypted_note_decryption_permits (
      noteId TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      sourceVersion INTEGER NOT NULL, sourceContent TEXT NOT NULL,
      content TEXT NOT NULL, contentFormat TEXT NOT NULL, contentText TEXT NOT NULL
    )`);
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='encrypted_notes_update'").get() as { sql: string };
    if (!row?.sql.includes("ON notes WHEN") || !row.sql.includes("BEGIN SELECT RAISE")) throw new Error("ENCRYPTED_DECRYPTION_GUARD_MIGRATION_MISMATCH");
    const permit = `NOT EXISTS (SELECT 1 FROM encrypted_note_decryption_permits p WHERE p.noteId IS OLD.id
      AND p.sourceVersion IS OLD.version AND p.sourceContent IS OLD.content
      AND p.content IS NEW.content AND p.contentFormat IS NEW.contentFormat AND p.contentText IS NEW.contentText
      AND OLD.contentFormat IN ('encrypted-note-v1','encrypted-note-v2') AND NEW.contentFormat IN ('markdown','tiptap-json')
      AND json_extract(OLD.content,'$.originalFormat') IS NEW.contentFormat
      AND NEW.version IS OLD.version + 1 AND NEW.id IS OLD.id AND NEW.userId IS OLD.userId
      AND NEW.notebookId IS OLD.notebookId AND NEW.workspaceId IS OLD.workspaceId
      AND OLD.workspaceId IS NULL AND OLD.isLocked = 0 AND OLD.isTrashed = 0)`;
    db.exec(`DROP TRIGGER encrypted_notes_update; ${row.sql.replace("ON notes WHEN", `ON notes WHEN ${permit} AND (`).replace("BEGIN SELECT RAISE", ") BEGIN SELECT RAISE")}`);
  },
};
