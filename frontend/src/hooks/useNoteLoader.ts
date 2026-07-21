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
  getLargeDocumentOriginalFormat,
  prepareLargeRichTextNoteForDisplay,
} from "@/lib/largeRichTextSafeMode";

type UseNoteLoaderOptions = Omit<NoteLoadOptions<Note>, "sink">;

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
      request: async () => prepareLargeRichTextNoteForDisplay(
        await loadNoteCacheFirst({
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

            const displayNote = prepareLargeRichTextNoteForDisplay(remote);
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
              // Keep tab metadata truthful even though activeNote uses a runtime routing
              // override to select the safe viewer.
              contentFormat: getLargeDocumentOriginalFormat(displayNote),
              isLocked: remote.isLocked,
              isTrashed: remote.isTrashed,
              updatedAt: remote.updatedAt,
            });
          },
        }),
      ),
    });
  }, [actions, sink]);

  const retryNoteLoad = useCallback(() => primaryNoteLoadCoordinator.retry(), []);
  const cancelNoteLoad = useCallback(() => primaryNoteLoadCoordinator.cancel(), []);

  return { loadNote, retryNoteLoad, cancelNoteLoad };
}
