import { useCallback, useEffect, useRef } from "react";

import type { NoteEditorProps } from "@/components/editors/types";
import {
  EDITOR_INITIALIZATION_TIMEOUT_MS,
  escalateEditorInitializationTimeout,
  shouldWatchEditorInitialization,
  type EditorInitializationEngine,
} from "@/lib/editorInitializationRuntime";

type EditorReadyCallback = NonNullable<NoteEditorProps["onEditorReady"]>;

interface UseEditorInitializationTimeoutOptions {
  noteId: string;
  engine: EditorInitializationEngine;
  onEditorReady?: NoteEditorProps["onEditorReady"];
  timeoutMs?: number;
}

interface InitializationLifecycle {
  noteId: string;
  ready: boolean;
  startedAt: number;
}

function clock(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Wrap an editor's existing ready callback with a session-only initialization watchdog.
 *
 * Ready may be reported before this hook's effect runs. The lifecycle ref is therefore updated in
 * render and checked before scheduling, preventing a fast editor from being downgraded by a timer
 * that was armed after it had already become interactive.
 */
export function useEditorInitializationTimeout({
  noteId,
  engine,
  onEditorReady,
  timeoutMs = EDITOR_INITIALIZATION_TIMEOUT_MS,
}: UseEditorInitializationTimeoutOptions): EditorReadyCallback {
  const lifecycleRef = useRef<InitializationLifecycle>({
    noteId,
    ready: false,
    startedAt: clock(),
  });
  const timerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

  if (lifecycleRef.current.noteId !== noteId) {
    lifecycleRef.current = { noteId, ready: false, startedAt: clock() };
  }

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    globalThis.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => {
    clearTimer();
    const lifecycle = lifecycleRef.current;
    if (
      lifecycle.noteId !== noteId
      || lifecycle.ready
      || !shouldWatchEditorInitialization(noteId)
    ) {
      return;
    }

    lifecycle.startedAt = clock();
    timerRef.current = globalThis.setTimeout(() => {
      timerRef.current = null;
      const current = lifecycleRef.current;
      if (current.noteId !== noteId || current.ready) return;

      const decision = escalateEditorInitializationTimeout(noteId);
      if (decision && import.meta.env.DEV) {
        console.warn("[EditorRuntime] initialization timeout", {
          noteId,
          engine,
          elapsedMs: Math.round(clock() - current.startedAt),
          mode: decision.mode,
          reasons: decision.reasons,
        });
      }
    }, Math.max(0, timeoutMs));

    return clearTimer;
  }, [clearTimer, engine, noteId, timeoutMs]);

  return useCallback<EditorReadyCallback>((scrollTo) => {
    const lifecycle = lifecycleRef.current;
    if (lifecycle.noteId === noteId) lifecycle.ready = true;
    clearTimer();
    onEditorReady?.(scrollTo);
  }, [clearTimer, noteId, onEditorReady]);
}
