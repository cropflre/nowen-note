import type { NoteListItem } from "@/types";
import {
  resolveInheritedNotebookSortPref,
  type NotebookSortPref,
} from "@/lib/notebookSort";

export function directNotebookNotes(notes: NoteListItem[], notebookId: string): NoteListItem[] {
  return notes.filter((note) => note.notebookId === notebookId);
}

export function sortNotebookNotes(notes: NoteListItem[], pref: NotebookSortPref): NoteListItem[] {
  const effectivePref = resolveInheritedNotebookSortPref(pref);
  if (effectivePref.by === "manual") return notes;

  const dir = effectivePref.dir === "asc" ? 1 : -1;
  return [...notes].sort((a, b) => {
    if ((a.isPinned || 0) !== (b.isPinned || 0)) {
      return (b.isPinned || 0) - (a.isPinned || 0);
    }
    if (effectivePref.by === "name") {
      const cmp = (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
      return cmp * dir || a.id.localeCompare(b.id);
    }
    const field = effectivePref.by as "updatedAt" | "createdAt";
    const av = a[field] || "";
    const bv = b[field] || "";
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return cmp * dir || a.id.localeCompare(b.id);
  });
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
