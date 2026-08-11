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

interface RuntimeDecisionCacheEntry {
  fingerprint: string;
  decision: EditorRuntimeDecision;
}

const collaborationBlockedNoteIds = new Set<string>();
const runtimeDecisionCache = new Map<string, RuntimeDecisionCacheEntry>();
const MAX_RUNTIME_DECISION_CACHE_ENTRIES = 32;

function runtimeDecisionFingerprint(note: Note, contentFormat: string): string {
  const content = note.content || "";
  const contentText = note.contentText || "";
  return [
    note.version,
    note.updatedAt,
    contentFormat,
    content.length,
    contentText.length,
    content.slice(0, 64),
    content.length > 64 ? content.slice(-64) : "",
  ].join("|");
}

function rememberRuntimeDecision(noteId: string, entry: RuntimeDecisionCacheEntry): void {
  runtimeDecisionCache.delete(noteId);
  runtimeDecisionCache.set(noteId, entry);
  while (runtimeDecisionCache.size > MAX_RUNTIME_DECISION_CACHE_ENTRIES) {
    const oldest = runtimeDecisionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    runtimeDecisionCache.delete(oldest);
  }
}

function resolveCachedRuntimeDecision(note: Note, contentFormat: string): EditorRuntimeDecision {
  const fingerprint = runtimeDecisionFingerprint(note, contentFormat);
  const cached = runtimeDecisionCache.get(note.id);
  if (cached?.fingerprint === fingerprint) {
    rememberRuntimeDecision(note.id, cached);
    return cached.decision;
  }

  const decision = resolveEditorRuntimeDecision({
    content: note.content,
    contentText: note.contentText,
    contentFormat,
  });
  rememberRuntimeDecision(note.id, { fingerprint, decision });
  return decision;
}

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
  const originalFormat = isLargeRichTextSafeNote(note)
    ? note.__nowenOriginalContentFormat
    : (note.contentFormat || "tiptap-json");
  return resolveCachedRuntimeDecision(note, originalFormat);
}

export function prepareLargeRichTextNoteForDisplay(note: Note): Note {
  const originalFormat = isLargeRichTextSafeNote(note)
    ? note.__nowenOriginalContentFormat
    : (note.contentFormat || "tiptap-json");

  // Complexity profiling scans the complete serialized document. Cache by note version and a
  // lightweight content fingerprint so returning to A after A → B does not repeat the scan.
  const decision = resolveCachedRuntimeDecision(note, originalFormat);
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
    } as RuntimeEditorPolicyNote;
  }

  collaborationBlockedNoteIds.add(note.id);
  return {
    ...note,
    // Runtime routing override only. The raw Tiptap/HTML payload remains in `content`.
    contentFormat: "markdown",
    __nowenLargeRichTextSafeMode: true,
    __nowenOriginalContentFormat: originalFormat,
    __nowenEditorRuntimeDecision: decision,
  } as RuntimeLargeRichTextSafeNote;
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

export function clearEditorRuntimeDecisionCache(): void {
  runtimeDecisionCache.clear();
}
