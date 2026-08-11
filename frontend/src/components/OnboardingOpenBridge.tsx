import { useEffect, useRef } from "react";

import { api, getCurrentWorkspace, getServerUrl } from "@/lib/api";
import { useApp, useAppActions } from "@/store/AppContext";

const ONBOARDING_VERSION = 1;
const MARKER_PREFIX = `nowen:onboarding-welcome-opened:v${ONBOARDING_VERSION}`;

type MarkerResult = "opened" | "not-seeded" | "skipped-active";

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

function writeMarker(key: string, result: MarkerResult): void {
  try {
    localStorage.setItem(key, JSON.stringify({ result, at: Date.now() }));
  } catch {
    // Private browsing or disabled storage should not block the application.
  }
}

/**
 * Opens the seeded Chinese welcome note on the first successful login in a client.
 *
 * The backend only creates the guide for accounts created after onboarding v1 and
 * marks every old account as already handled. A missing deterministic note produces
 * one harmless 404 probe, remembered per server and user. The live active-note ref
 * prevents a slow onboarding request from overriding a note the user opened first.
 */
export default function OnboardingOpenBridge() {
  const { state } = useApp();
  const actions = useAppActions();
  const startedRef = useRef(false);
  const activeNoteRef = useRef(state.activeNote);

  useEffect(() => {
    activeNoteRef.current = state.activeNote;
  }, [state.activeNote]);

  useEffect(() => {
    if (startedRef.current || activeNoteRef.current || getCurrentWorkspace() !== "personal") return;

    let cancelled = false;
    startedRef.current = true;

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
        if (cancelled) return;

        if (activeNoteRef.current || getCurrentWorkspace() !== "personal") {
          writeMarker(key, "skipped-active");
          return;
        }

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
        // Do not write a marker for transient failures; remounting after a future
        // login or reload can safely retry.
        startedRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [actions]);

  return null;
}
