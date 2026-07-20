import { useCallback, useMemo } from "react";
import { useAppActions } from "@/store/AppContext";
import type { Note } from "@/types";
import {
  primaryNoteLoadCoordinator,
  type NoteLoadOptions,
  type NoteLoadSink,
} from "@/lib/noteLoadCoordinator";

type UseNoteLoaderOptions = Omit<NoteLoadOptions<Note>, "sink">;

export function useNoteLoader() {
  const actions = useAppActions();
  const sink = useMemo<NoteLoadSink>(() => ({
    begin: (payload) => actions.beginNoteLoad(payload),
    show: (requestId) => actions.showNoteLoad(requestId),
    markSlow: (requestId) => actions.markNoteLoadSlow(requestId),
    finish: (requestId) => actions.finishNoteLoad(requestId),
    fail: (requestId, error) => actions.failNoteLoad(requestId, error),
  }), [actions]);

  const loadNote = useCallback((options: UseNoteLoaderOptions) => (
    primaryNoteLoadCoordinator.run({ ...options, sink })
  ), [sink]);

  const retryNoteLoad = useCallback(() => primaryNoteLoadCoordinator.retry(), []);
  const cancelNoteLoad = useCallback(() => primaryNoteLoadCoordinator.cancel(), []);

  return { loadNote, retryNoteLoad, cancelNoteLoad };
}
