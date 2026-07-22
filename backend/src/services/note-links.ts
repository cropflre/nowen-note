import { getDb } from "../db/schema.js";
import { syncNoteLinks } from "../lib/noteLinks.js";

/**
 * Rebuild backlinks for a newly transferred note. The target note owner is read
 * from the inserted row so callers cannot accidentally index it under the source
 * workspace owner.
 */
export function syncNoteLinksForNote(noteId: string, content: string): void {
  const db = getDb();
  const note = db.prepare("SELECT userId FROM notes WHERE id = ?").get(noteId) as
    | { userId: string }
    | undefined;
  if (!note) return;
  syncNoteLinks(db, note.userId, noteId, content);
}
