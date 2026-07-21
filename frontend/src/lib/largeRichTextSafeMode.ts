import type { Note } from "@/types";
import { shouldUseLargeMarkdownSafeMode } from "@/lib/largeMarkdownSafety";

/**
 * Runtime-only marker used when a large non-Markdown note must not enter Tiptap.
 *
 * The original content is kept untouched in memory. Only contentFormat is overridden so
 * EditorPane selects the Markdown adapter, which then renders LargeRichTextSafeViewer.
 * Nothing here is persisted to the server.
 */
export interface RuntimeLargeRichTextSafeNote extends Note {
  __nowenLargeRichTextSafeMode: true;
  __nowenOriginalContentFormat: string;
}

const collaborationBlockedNoteIds = new Set<string>();

export function isLargeRichTextSafeNote(
  note: Note | null | undefined,
): note is RuntimeLargeRichTextSafeNote {
  return !!note && (note as RuntimeLargeRichTextSafeNote).__nowenLargeRichTextSafeMode === true;
}

export function prepareLargeRichTextNoteForDisplay(note: Note): Note {
  if (isLargeRichTextSafeNote(note)) {
    collaborationBlockedNoteIds.add(note.id);
    return note;
  }

  const originalFormat = note.contentFormat || "tiptap-json";
  const shouldProtect =
    originalFormat !== "markdown"
    && shouldUseLargeMarkdownSafeMode(note.content || note.contentText);

  if (!shouldProtect) {
    collaborationBlockedNoteIds.delete(note.id);
    return note;
  }

  collaborationBlockedNoteIds.add(note.id);
  return {
    ...note,
    // Runtime routing override only. The raw Tiptap/HTML payload remains in `content`.
    contentFormat: "markdown",
    __nowenLargeRichTextSafeMode: true,
    __nowenOriginalContentFormat: originalFormat,
  } satisfies RuntimeLargeRichTextSafeNote;
}

export function isLargeDocumentCollaborationBlocked(
  noteId: string | null | undefined,
): boolean {
  return !!noteId && collaborationBlockedNoteIds.has(noteId);
}

export function getLargeDocumentOriginalFormat(note: Note): string | undefined {
  return isLargeRichTextSafeNote(note)
    ? note.__nowenOriginalContentFormat
    : note.contentFormat;
}
