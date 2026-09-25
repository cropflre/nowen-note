// Only the next editor opening of this newly created note bypasses lockOnOpen.
// The marker is intentionally session-only and never changes note.isLocked.
let pendingNoteId: string | null = null;

export function markNewNoteForImmediateEdit(noteId: string): void {
  pendingNoteId = noteId;
}

export function consumeNewNoteImmediateEdit(noteId: string): boolean {
  const matched = pendingNoteId === noteId;
  pendingNoteId = null;
  return matched;
}

export function shouldApplyDefaultViewLock(noteId: string, lockOnOpen: boolean): boolean {
  const newlyCreated = consumeNewNoteImmediateEdit(noteId);
  return lockOnOpen && !newlyCreated;
}
