import type { Note } from "@/types";
import type { NoteEditorUpdatePayload } from "@/components/editors/types";

export const PREPARE_EDITOR_SPLIT_CLOSE_EVENT = "nowen:prepare-editor-split-close";

export function applyEditorUpdateToNote(
  note: Note,
  update: NoteEditorUpdatePayload,
): Note {
  const content = update.content ?? note.content;
  const contentText = update.contentText ?? note.contentText;
  if (
    update.title === note.title
    && content === note.content
    && contentText === note.contentText
  ) {
    return note;
  }
  return {
    ...note,
    title: update.title,
    content,
    contentText,
  };
}

export function prepareEditorSplitClose(noteId?: string): void {
  window.dispatchEvent(new CustomEvent(PREPARE_EDITOR_SPLIT_CLOSE_EVENT, {
    detail: { noteId },
  }));
}

export function readEditorSplitCloseNoteId(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const noteId = event.detail?.noteId;
  return typeof noteId === "string" && noteId ? noteId : null;
}
