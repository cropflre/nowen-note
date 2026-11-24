import { useCallback, useEffect, useRef } from "react";
import type { EditorActionAdapter } from "@/lib/editorActions/types";

/** Why the assistant's result was not written. In every case the note is unchanged. */
export type AIApplyFailure = "conflict" | "encrypted" | "tooLarge";
export type AIApplyOutcome = "applied" | AIApplyFailure;
export type AIApplyMode = "insert" | "replace";
export interface AIApplyRange { from: number; to: number }

export interface AIAssistantAnchor {
  /** Runs `write` with the followed range, but only while the captured note, editor and text still match. */
  apply(mode: AIApplyMode, write: (range: AIApplyRange) => void): AIApplyOutcome;
  release(): void;
}

/**
 * Pins the assistant to the text it was opened on, the same way editor actions do: the range follows later
 * edits (typing, collaboration, undo), replacing compares the original text, and the current selection is
 * never used as a fallback. A selection that cannot be anchored (encrypted region, too large) never writes.
 */
export function captureAIAssistantAnchor(adapter: EditorActionAdapter): AIAssistantAnchor {
  const captured = adapter.capture();
  if ("error" in captured) {
    const failure: AIApplyFailure = captured.error === "ENCRYPTED_REGION" ? "encrypted" : captured.error === "TOO_LARGE" ? "tooLarge" : "conflict";
    return { apply: () => failure, release: () => undefined };
  }
  return {
    apply(mode, write) {
      const range = captured.resolve(mode);
      if (!range) return "conflict";
      write(range);
      return "applied";
    },
    release: () => captured.release(),
  };
}

/**
 * The anchor lives as long as the assistant is open: captured when it opens, released when it closes or the
 * editor goes away. Without an anchor nothing is ever written.
 */
export function useAIAssistantAnchor(open: boolean, noteId: string) {
  const anchor = useRef<AIAssistantAnchor | null>(null);
  const latestNoteId = useRef(noteId); latestNoteId.current = noteId;
  const release = useCallback(() => { anchor.current?.release(); anchor.current = null; }, []);
  useEffect(() => { if (!open) release(); }, [open, release]);
  useEffect(() => release, [release]);
  const capture = useCallback((createAdapter: (getNoteId: () => string) => EditorActionAdapter) => {
    release();
    anchor.current = captureAIAssistantAnchor(createAdapter(() => latestNoteId.current));
  }, [release]);
  const apply = useCallback(
    (mode: AIApplyMode, write: (range: AIApplyRange) => void): AIApplyOutcome => anchor.current?.apply(mode, write) ?? "conflict",
    [],
  );
  return { capture, apply };
}
