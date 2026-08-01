import { useEffect, useRef } from "react";

import { api, getCurrentWorkspace, getServerUrl } from "@/lib/api";
import { useApp, useAppActions } from "@/store/AppContext";

const ONBOARDING_VERSION = 1;
const MARKER_PREFIX = `nowen:onboarding-welcome-opened:v${ONBOARDING_VERSION}`;

export function onboardingWelcomeNoteId(userId: string): string {
  return `onboarding-v${ONBOARDING_VERSION}-${userId}-zh-welcome`;
}

function markerKey(userId: string): string {
  let server = getServerUrl();
  if (!server && typeof window !== "undefined") {
    server = window.location.origin || "same-origin";
  }
  const normalizedServer = (server || "same-origin").replace(/\/+$/, "").toLowerCase();
  return `${MARKER_PREFIX}:${encodeURIComponent(normalizedServer)}:${userId}`;
}

function readMarker(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function writeMarker(key: string, result: "opened" | "not-seeded"): void {
  try {
    localStorage.setItem(key, JSON.stringify({ result, at: Date.now() }));
  } catch {
    // Private browsing or disabled storage should not block the application.
  }
}

/**
 * Opens the seeded Chinese welcome note on the first successful login in a client.
 *
 * The backend only creates the guide for accounts inserted after onboarding v1. Old
 * accounts receive one harmless 404 probe, which is remembered locally. The marker
 * is scoped by server and user so switching accounts or servers cannot suppress the
 * correct welcome document.
 */
export default function OnboardingOpenBridge() {
  const { state } = useApp();
  const actions = useAppActions();
  const runningRef = useRef(false);

  useEffect(() => {
    if (runningRef.current || state.activeNote || getCurrentWorkspace() !== "personal") return;

    let cancelled = false;
    runningRef.current = true;

    void (async () => {
      let key: string | null = null;
      try {
        const user = await api.getMe();
        if (cancelled) return;

        key = markerKey(user.id);
        if (readMarker(key)) return;

        const noteId = onboardingWelcomeNoteId(user.id);
        // getNoteSlim does not use the offline fallback, so a real 404 remains
        // distinguishable from a transient network failure.
        await api.getNoteSlim(noteId);
        const note = await api.getNote(noteId);
        if (cancelled || state.activeNote) return;

        actions.setActiveNote(note);
        actions.setSelectedNotebook(note.notebookId);
        actions.setViewMode("notebook");
        actions.setMobileView("editor");
        actions.refreshNotebooks();
        actions.refreshNotes();
        writeMarker(key, "opened");
      } catch (error) {
        if (cancelled) return;
        const status = (error as { status?: number })?.status;
        if (status === 404 && key) {
          // Existing accounts are deliberately not backfilled. Remember the miss
          // so every login does not repeat the same request.
          writeMarker(key, "not-seeded");
          return;
        }
        // A transient network failure may be retried when the normal notebook
        // bootstrap changes the dependency below or the component remounts.
        runningRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [actions, state.activeNote, state.notebooks.length]);

  return null;
}
