import type { Note } from "@/types";
import {
  EDITOR_RUNTIME_THRESHOLDS,
  resolveEditorRuntimeDecision,
  type EditorRuntimeDecision,
} from "@/lib/editorRuntimePolicy";
import { setActiveEditorRuntimeDecision } from "@/lib/editorRuntimeStore";

/** Compatibility export retained for tests and callers of the previous emergency-only policy. */
export const LARGE_RICH_TEXT_THRESHOLDS = {
  serializedCharacters: EDITOR_RUNTIME_THRESHOLDS.richText.emergency.characters,
  approximateNodes: EDITOR_RUNTIME_THRESHOLDS.richText.emergency.nodes,
} as const;

/**
 * Runtime-only metadata attached to non-normal editor sessions.
 *
 * The fields are never persisted. They let the editor, diagnostics and emergency viewer consume
 * the same policy decision without recalculating or mutating the server payload.
 */
export interface RuntimeEditorPolicyNote extends Note {
  __nowenEditorRuntimeDecision: EditorRuntimeDecision;
}

/**
 * Runtime-only marker used when a pathological non-Markdown note must not enter Tiptap.
 *
 * The original content is kept untouched in memory. Only contentFormat is overridden so
 * EditorPane selects the Markdown adapter, which then renders LargeRichTextSafeViewer.
 * Nothing here is persisted to the server.
 */
export interface RuntimeLargeRichTextSafeNote extends RuntimeEditorPolicyNote {
  __nowenLargeRichTextSafeMode: true;
  __nowenOriginalContentFormat: string;
}

const collaborationBlockedNoteIds = new Set<string>();

export function isLargeRichTextSafeNote(
  note: Note | null | undefined,
): note is RuntimeLargeRichTextSafeNote {
  return !!note && (note as RuntimeLargeRichTextSafeNote).__nowenLargeRichTextSafeMode === true;
}

export function getEditorRuntimeDecisionForNote(
  note: Note | null | undefined,
): EditorRuntimeDecision | null {
  if (!note) return null;
  const runtime = (note as RuntimeEditorPolicyNote).__nowenEditorRuntimeDecision;
  if (runtime) return runtime;
  return resolveEditorRuntimeDecision({
    content: note.content,
    contentText: note.contentText,
    contentFormat: note.contentFormat,
  });
}

export function prepareLargeRichTextNoteForDisplay(note: Note): Note {
  const originalFormat = isLargeRichTextSafeNote(note)
    ? note.__nowenOriginalContentFormat
    : (note.contentFormat || "tiptap-json");

  const decision = resolveEditorRuntimeDecision({
    content: note.content,
    contentText: note.contentText,
    contentFormat: originalFormat,
  });
  setActiveEditorRuntimeDecision(note.id, decision);

  const shouldProtect = originalFormat !== "markdown" && decision.mode === "emergency-readonly";
  if (!shouldProtect) {
    collaborationBlockedNoteIds.delete(note.id);

    // Remove stale emergency routing when a previously pathological note becomes smaller again.
    if (isLargeRichTextSafeNote(note)) {
      return {
        ...note,
        contentFormat: originalFormat,
        __nowenLargeRichTextSafeMode: undefined,
        __nowenOriginalContentFormat: undefined,
        __nowenEditorRuntimeDecision: decision,
      } as unknown as RuntimeEditorPolicyNote;
    }

    if (decision.mode === "normal") return note;
    return {
      ...note,
      __nowenEditorRuntimeDecision: decision,
    } satisfies RuntimeEditorPolicyNote;
  }

  collaborationBlockedNoteIds.add(note.id);
  return {
    ...note,
    // Runtime routing override only. The raw Tiptap/HTML payload remains in `content`.
    contentFormat: "markdown",
    __nowenLargeRichTextSafeMode: true,
    __nowenOriginalContentFormat: originalFormat,
    __nowenEditorRuntimeDecision: decision,
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
