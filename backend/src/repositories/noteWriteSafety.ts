import { getDb } from "../db/schema";

let installedFor: object | null = null;

/**
 * Last-resort data-loss protection.
 *
 * The notes route normally creates a version snapshot before content writes, but it merges
 * edits made inside a five-minute window. A stale mobile write arriving in that window
 * could therefore replace the newest body without leaving an immediately restorable
 * pre-image. This trigger fills only that gap: if the exact current revision is not already
 * in note_versions, SQLite snapshots OLD before applying the update.
 */
export function ensureNoteWriteSafetyTrigger(): void {
  const db = getDb();
  if (installedFor === db) return;

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS notes_preserve_revision_before_overwrite
    BEFORE UPDATE OF title, content, contentText, contentFormat ON notes
    WHEN
      COALESCE(OLD.title, '') <> COALESCE(NEW.title, '') OR
      COALESCE(OLD.content, '') <> COALESCE(NEW.content, '') OR
      COALESCE(OLD.contentText, '') <> COALESCE(NEW.contentText, '') OR
      COALESCE(OLD.contentFormat, '') <> COALESCE(NEW.contentFormat, '')
    BEGIN
      INSERT INTO note_versions (
        id, noteId, userId, title, content, contentText, contentFormat,
        version, changeType, changeSummary, createdAt
      )
      SELECT
        lower(hex(randomblob(16))),
        OLD.id,
        OLD.userId,
        OLD.title,
        OLD.content,
        OLD.contentText,
        COALESCE(OLD.contentFormat, 'tiptap-json'),
        OLD.version,
        'edit',
        'Automatic safety snapshot before overwrite',
        datetime('now')
      WHERE NOT EXISTS (
        SELECT 1
        FROM note_versions existing
        WHERE existing.noteId = OLD.id
          AND existing.version = OLD.version
          AND COALESCE(existing.title, '') = COALESCE(OLD.title, '')
          AND COALESCE(existing.content, '') = COALESCE(OLD.content, '')
          AND COALESCE(existing.contentText, '') = COALESCE(OLD.contentText, '')
          AND COALESCE(existing.contentFormat, '') = COALESCE(OLD.contentFormat, '')
      );
    END;
  `);

  installedFor = db;
}

// repositories/index.ts is imported by every note route. Install once for the current DB
// instance and repeat automatically after tests/factory reset replace the connection.
ensureNoteWriteSafetyTrigger();
