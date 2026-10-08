import type { Migration } from "./migrations.impl.js";

// API/sync validate the full envelope. These persistent guards also stop older writers,
// repair jobs and derived-content paths, including clients that bypass those entry points.
export const encryptedNotesMigration: Migration = {
  version: 117,
  name: "encrypted-note-storage-guards",
  up(db) {
    const invalidEnvelope = `CASE WHEN json_valid(NEW.content) = 0 THEN 1 ELSE
      NEW.contentFormat <> 'encrypted-note-v1' OR COALESCE(NEW.contentText, '') <> ''
      OR length(NEW.content) > 5594476
      OR json_extract(NEW.content, '$.version') IS NOT 1
      OR json_extract(NEW.content, '$.algorithm') IS NOT 'AES-256-GCM'
      OR json_extract(NEW.content, '$.kind') IS NOT 'note'
      OR (json_extract(NEW.content, '$.originalFormat') IS NOT 'markdown' AND json_extract(NEW.content, '$.originalFormat') IS NOT 'tiptap-json')
      OR json_type(NEW.content, '$.objectId') IS NOT 'text'
      OR json_type(NEW.content, '$.payload.ciphertext') IS NOT 'text'
      OR json_type(NEW.content, '$.wrappedKey.ciphertext') IS NOT 'text'
      OR json_extract(NEW.content, '$.kdf.algorithm') IS NOT 'argon2id'
      OR json_extract(NEW.content, '$.kdf.version') IS NOT 19
      OR json_extract(NEW.content, '$.kdf.memoryKiB') IS NOT 65536
      OR json_extract(NEW.content, '$.kdf.iterations') IS NOT 3
      OR json_extract(NEW.content, '$.kdf.parallelism') IS NOT 4 END`;
    db.exec(`
      CREATE TRIGGER encrypted_notes_insert BEFORE INSERT ON notes
      WHEN NEW.contentFormat LIKE 'encrypted-%' AND (${invalidEnvelope})
      BEGIN SELECT RAISE(ABORT, 'INVALID_ENCRYPTED_NOTE'); END;
      CREATE TRIGGER encrypted_notes_update BEFORE UPDATE ON notes
      WHEN (OLD.contentFormat LIKE 'encrypted-%' AND (
        NEW.contentFormat IS NOT OLD.contentFormat OR (${invalidEnvelope})
        OR json_extract(NEW.content, '$.objectId') IS NOT json_extract(OLD.content, '$.objectId')
        OR json_extract(NEW.content, '$.originalFormat') IS NOT json_extract(OLD.content, '$.originalFormat')
      )) OR (OLD.contentFormat NOT LIKE 'encrypted-%' AND NEW.contentFormat LIKE 'encrypted-%')
      BEGIN SELECT RAISE(ABORT, 'INVALID_ENCRYPTED_NOTE'); END;
    `);
    for (const table of ["attachments", "shares", "note_blocks_index", "note_block_documents", "note_block_records", "note_yupdates", "note_ysnapshots", "note_y_subdocuments", "note_y_subdocument_updates", "note_y_subdocument_manifests", "note_embeddings"]) {
      // Some optional tables are created lazily; the shared entry points guard them too.
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
      for (const operation of ["INSERT", "UPDATE"] as const) {
        db.exec(`CREATE TRIGGER encrypted_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
          WHEN EXISTS (SELECT 1 FROM notes WHERE id = NEW.noteId AND contentFormat LIKE 'encrypted-%')
          BEGIN SELECT RAISE(ABORT, 'ENCRYPTED_NOTE_DERIVED_CONTENT_FORBIDDEN'); END;`);
      }
    }
    for (const operation of ["INSERT", "UPDATE"] as const) db.exec(`CREATE TRIGGER encrypted_note_versions_${operation.toLowerCase()} BEFORE ${operation} ON note_versions
      WHEN EXISTS (SELECT 1 FROM notes WHERE id = NEW.noteId AND contentFormat LIKE 'encrypted-%')
        AND (${invalidEnvelope})
      BEGIN SELECT RAISE(ABORT, 'INVALID_ENCRYPTED_NOTE_HISTORY'); END;`);
  },
};
