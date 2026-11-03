import { useEffect, useRef } from "react";

import { api, getCurrentWorkspace } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { useApp, useAppActions } from "@/store/AppContext";

/** The server grants the welcome opening once per account. */
export default function OnboardingOpenBridge() {
  const { state } = useApp();
  const actions = useAppActions();
  const activeNoteRef = useRef(state.activeNote);

  useEffect(() => {
    activeNoteRef.current = state.activeNote;
  }, [state.activeNote]);

  useEffect(() => {
    if (activeNoteRef.current || getCurrentWorkspace() !== "personal") return;

    let cancelled = false;
    const accountScope = getOfflineQueueStorageKey();
    const canOpen = () => !cancelled
      && !activeNoteRef.current
      && getCurrentWorkspace() === "personal"
      && getOfflineQueueStorageKey() === accountScope;

    void (async () => {
      // Let StrictMode's first effect cleanup run before making a one-time claim.
      await Promise.resolve();
      if (!canOpen()) return;

      try {
        const { noteId } = await api.claimOnboardingWelcome();
        if (!noteId || !canOpen()) return;

        const note = await api.getNote(noteId);
        if (!canOpen() || note.isTrashed || note.workspaceId) return;

        actions.setActiveNote(note);
        actions.setSelectedNotebook(note.notebookId);
        actions.setViewMode("notebook");
        actions.setMobileView("editor");
        actions.refreshNotebooks();
        actions.refreshNotes();
      } catch {
        // Older servers and offline clients can continue without an automatic welcome.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [actions]);

  return null;
}
