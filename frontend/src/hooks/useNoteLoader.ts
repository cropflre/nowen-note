import { useCallback, useMemo, useRef } from "react";
import { useApp, useAppActions } from "@/store/AppContext";
import type { Note } from "@/types";
import {
  primaryNoteLoadCoordinator,
  type NoteLoadOptions,
  type NoteLoadSink,
} from "@/lib/noteLoadCoordinator";
import {
  canApplyRevalidatedNote,
  loadNoteCacheFirst,
} from "@/lib/noteLoadSource";
import { loadDraft } from "@/lib/draftStorage";
import {
  getEditorRuntimeDecisionForNote,
  getLargeDocumentOriginalFormat,
  prepareLargeRichTextNoteForDisplay,
} from "@/lib/largeRichTextSafeMode";

 type UseNoteLoaderOptions = Omit<NoteLoadOptions<Note>, "sink">;

function markStage(name: string): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  performance.mark(name);
}

function measureStage(name: string, start: string, end: string): void {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") return;
  try {
    performance.measure(name, start, end);
  } catch {
    // Older WebViews may drop marks under memory pressure. Metrics must never block note loading.
  } finally {
    performance.clearMarks?.(start);
    performance.clearMarks?.(end);
  }
}

function logRuntimeDecision(note: Note): void {
  if (!import.meta.env.DEV) return;
  const decision = getEditorRuntimeDecisionForNote(note);
  if (!decision || decision.mode === "normal") return;
  const { profile } = decision;
  console.debug("[EditorRuntime] decision", {
    noteId: note.id,
    mode: decision.mode,
    reasons: decision.reasons,
    bytes: profile.bytes,
    characters: profile.characters,
    lines: profile.lines,
    approximateNodes: profile.approximateNodes,
    images: profile.imageCount,
    attachments: profile.attachmentCount,
    embeds: profile.embedCount,
    tables: profile.tableCount,
    codeBlocks: profile.codeBlockCount,
    disabledCapabilities: decision.disabledCapabilities,
  });
}

export function useNoteLoader() {
  const { state } = useApp();
  const actions = useAppActions();
  const stateRef = useRef(state);
  stateRef.current = state;

  const sink = useMemo<NoteLoadSink>(() => ({
    begin: (payload) => actions.beginNoteLoad(payload),
    show: (requestId) => actions.showNoteLoad(requestId),
    markSlow: (requestId) => actions.markNoteLoadSlow(requestId),
    finish: (requestId) => actions.finishNoteLoad(requestId),
    fail: (requestId, error) => actions.failNoteLoad(requestId, error),
  }), [actions]);

  const loadNote = useCallback((options: UseNoteLoaderOptions) => {
    const fetchRemote = options.request;
    return primaryNoteLoadCoordinator.run({
      ...options,
      sink,
      request: async () => {
        const fetchStart = `nowen:note-fetch:start:${options.noteId}`;
        const fetchEnd = `nowen:note-fetch:end:${options.noteId}`;
        markStage(fetchStart);
        const loaded = await loadNoteCacheFirst({
          noteId: options.noteId,
          fetchRemote,
          onRevalidated: (remote, cached) => {
            const currentState = stateRef.current;
            const current = currentState.activeNote;
            if (!canApplyRevalidatedNote({
              current,
              cached,
              remote,
              hasDraft: !!loadDraft(options.noteId),
              pendingNoteId: currentState.noteLoadingState.pendingNoteId,
            })) return;

            const policyStart = `nowen:editor-policy:start:${remote.id}`;
            const policyEnd = `nowen:editor-policy:end:${remote.id}`;
            markStage(policyStart);
            const displayNote = prepareLargeRichTextNoteForDisplay(remote);
            markStage(policyEnd);
            measureStage("nowen:editor-policy", policyStart, policyEnd);
            logRuntimeDecision(displayNote);
            actions.setActiveNote(displayNote);
            actions.updateNoteInList({
              id: remote.id,
              title: remote.title,
              contentText: remote.contentText,
              version: remote.version,
              updatedAt: remote.updatedAt,
            });
            actions.updateNoteTab({
              id: remote.id,
              title: remote.title,
              // Keep tab metadata truthful even though activeNote may use a runtime routing override.
              contentFormat: getLargeDocumentOriginalFormat(displayNote),
              isLocked: remote.isLocked,
              isTrashed: remote.isTrashed,
              updatedAt: remote.updatedAt,
            });
          },
        });
        markStage(fetchEnd);
        measureStage("nowen:note-fetch", fetchStart, fetchEnd);

        const policyStart = `nowen:editor-policy:start:${loaded.id}`;
        const policyEnd = `nowen:editor-policy:end:${loaded.id}`;
        markStage(policyStart);
        const prepared = prepareLargeRichTextNoteForDisplay(loaded);
        markStage(policyEnd);
        measureStage("nowen:editor-policy", policyStart, policyEnd);
        logRuntimeDecision(prepared);
        return prepared;
      },
    });
  }, [actions, sink]);

  const retryNoteLoad = useCallback(() => primaryNoteLoadCoordinator.retry(), []);
  const cancelNoteLoad = useCallback(() => primaryNoteLoadCoordinator.cancel(), []);

  return { loadNote, retryNoteLoad, cancelNoteLoad };
}
