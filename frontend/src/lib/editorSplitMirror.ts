import type { Note } from "@/types";
import type { NoteEditorUpdatePayload } from "@/components/editors/types";

export const PREPARE_EDITOR_SPLIT_CLOSE_EVENT = "nowen:prepare-editor-split-close";
export const REQUEST_EDITOR_SPLIT_MIRROR_EVENT = "nowen:request-editor-split-mirror";
export const UPDATE_EDITOR_SPLIT_MIRROR_EVENT = "nowen:update-editor-split-mirror";

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

export function requestEditorSplitMirror(noteId: string): void {
  window.dispatchEvent(new CustomEvent(REQUEST_EDITOR_SPLIT_MIRROR_EVENT, {
    detail: { noteId },
  }));
}

export function publishEditorSplitMirrorUpdate(
  noteId: string,
  update: NoteEditorUpdatePayload,
): void {
  window.dispatchEvent(new CustomEvent(UPDATE_EDITOR_SPLIT_MIRROR_EVENT, {
    detail: { noteId, update },
  }));
}

export function readEditorSplitMirrorUpdate(event: Event): {
  noteId: string;
  update: NoteEditorUpdatePayload;
} | null {
  if (!(event instanceof CustomEvent)) return null;
  const noteId = event.detail?.noteId;
  const update = event.detail?.update;
  if (
    typeof noteId !== "string"
    || !noteId
    || !update
    || typeof update !== "object"
    || typeof update.title !== "string"
  ) return null;
  return { noteId, update };
}
