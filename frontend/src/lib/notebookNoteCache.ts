import type { NoteListItem } from "@/types";

export function directNotebookNotes(notes: NoteListItem[], notebookId: string): NoteListItem[] {
  return notes.filter((note) => note.notebookId === notebookId);
}

export function moveNoteInNotebookCache(
  cache: Map<string, NoteListItem[]>,
  noteId: string,
  targetNotebookId: string,
  movedNote: NoteListItem,
): Map<string, NoteListItem[]> {
  const next = new Map<string, NoteListItem[]>();

  cache.forEach((notes, notebookId) => {
    next.set(notebookId, notes.filter((note) => note.id !== noteId));
  });

  const targetNotes = next.get(targetNotebookId);
  if (targetNotes) {
    next.set(targetNotebookId, [movedNote, ...targetNotes]);
  }

  return next;
}

export function addNoteToNotebookCache(
  cache: Map<string, NoteListItem[]>,
  notebookId: string,
  note: NoteListItem,
): Map<string, NoteListItem[]> {
  const next = new Map(cache);
  const existing = next.get(notebookId) || [];
  next.set(notebookId, [note, ...existing.filter((item) => item.id !== note.id)]);
  return next;
}

export function upsertNoteInNotebookCache(
  cache: Map<string, NoteListItem[]>,
  notebookId: string,
  note: NoteListItem,
): Map<string, NoteListItem[]> {
  const existing = cache.get(notebookId);
  if (!existing) return addNoteToNotebookCache(cache, notebookId, note);

  const index = existing.findIndex((item) => item.id === note.id);
  if (index === -1) return addNoteToNotebookCache(cache, notebookId, note);

  const next = new Map(cache);
  const notes = [...existing];
  notes[index] = note;
  next.set(notebookId, notes);
  return next;
}
