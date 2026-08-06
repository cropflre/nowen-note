import { syncNoteLinks } from "../lib/noteLinks.js";
import { noteLinksRepository } from "../repositories/noteLinksRepository.js";

/**
 * Rebuild backlinks for a newly transferred note. The target note owner is read
 * through the Repository boundary so business services do not depend on the
 * SQLite connection directly.
 */
export function syncNoteLinksForNote(noteId: string, content: string): void {
  const userId = noteLinksRepository.getSourceNoteUserId(noteId);
  if (!userId) return;
  syncNoteLinks(undefined, userId, noteId, content);
}
