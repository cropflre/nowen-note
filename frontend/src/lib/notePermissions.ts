import type { Note } from "@/types";

type NoteWithPermission = Pick<Note, "permission"> | null | undefined;

/**
 * Whether the current user may modify a note.
 *
 * `permission` was added after personal notes already existed. Treating an
 * absent value as writable preserves compatibility, while explicit shared
 * `read` / `comment` permissions must remain read-only.
 */
export function canWriteNote(note: NoteWithPermission): boolean {
  const permission = note?.permission;
  return permission == null || permission === "write" || permission === "manage";
}
