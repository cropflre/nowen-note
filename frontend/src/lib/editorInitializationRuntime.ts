import type { EditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  escalateActiveEditorRuntimeMode,
  getActiveEditorRuntimeState,
} from "@/lib/editorRuntimeStore";

/**
 * Normal documents should become interactive quickly. When a normal editor has not reported ready
 * within this budget, the current session drops expensive whole-document work and heavy-node eager
 * rendering before the user is left staring at an unresponsive editor.
 */
export const EDITOR_INITIALIZATION_TIMEOUT_MS = 1_500;

export type EditorInitializationEngine = "markdown" | "tiptap";

/** Only the active normal-mode note may be downgraded by an initialization timeout. */
export function shouldWatchEditorInitialization(noteId: string): boolean {
  const current = getActiveEditorRuntimeState();
  return current.noteId === noteId && current.decision.mode === "normal";
}

/**
 * Escalate one active normal session to viewport optimization.
 *
 * The active-note and current-mode checks deliberately happen again at timeout time, so a stale
 * timer from a previous note or a Long Task escalation cannot mutate the new editor session.
 */
export function escalateEditorInitializationTimeout(
  noteId: string,
): EditorRuntimeDecision | null {
  if (!shouldWatchEditorInitialization(noteId)) return null;
  return escalateActiveEditorRuntimeMode(
    "viewport-optimized",
    "initialization-timeout",
  );
}
