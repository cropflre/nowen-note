import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useApp, useAppActions } from "@/store/AppContext";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { useNoteLoader } from "@/hooks/useNoteLoader";
import { api } from "@/lib/api";
import {
  APP_PATH_CHANGED_EVENT,
  replaceAppPathState,
  resolveCurrentAppPathname,
} from "@/lib/appPathNavigation";
import {
  getCurrentNoteAppRoute,
  parseNoteAppPath,
  pushNoteAppPath,
} from "@/lib/noteDeepLink";
import { toast } from "@/lib/toast";
import type { Note, ViewMode } from "@/types";

const NOTE_WORKSPACE_VIEWS = new Set<ViewMode>([
  "notebook",
  "favorites",
  "trash",
  "all",
  "search",
  "tag",
]);

function tabFromNote(note: Note) {
  return {
    id: note.id,
    title: note.title,
    notebookId: note.notebookId,
    workspaceId: note.workspaceId,
    contentFormat: note.contentFormat,
    isLocked: note.isLocked,
    isTrashed: note.isTrashed,
    updatedAt: note.updatedAt,
  };
}

/**
 * Canonical note-resource routing.
 *
 * URL expresses navigation intent (/notes/:id); AppContext remains the runtime/editor state.
 * Existing note-open entry points only need to update activeNote: this bridge publishes the URL.
 * Browser reload/back/forward does the inverse and resolves the resource back into activeNote.
 */
export default function NoteDeepLinkBridge() {
  const { state } = useApp();
  const actions = useAppActions();
  const { prefs } = useUserPreferences();
  const { loadNote, cancelNoteLoad } = useNoteLoader();
  const { t } = useTranslation();

  const activeNoteRef = useRef(state.activeNote);
  const viewModeRef = useRef(state.viewMode);
  const previousActiveNoteIdRef = useRef<string | null>(state.activeNote?.id ?? null);
  const previousViewModeRef = useRef<ViewMode>(state.viewMode);
  const pendingRouteNoteIdRef = useRef<string | null>(null);
  const routeLoadSequenceRef = useRef(0);

  activeNoteRef.current = state.activeNote;
  viewModeRef.current = state.viewMode;

  useEffect(() => {
    let disposed = false;

    const applyRoute = (event?: Event) => {
      const pathname = resolveCurrentAppPathname();
      const route = parseNoteAppPath(pathname);

      if (!route.matched || !route.noteId) {
        routeLoadSequenceRef.current += 1;
        pendingRouteNoteIdRef.current = null;

        if (event?.type === "popstate" && pathname === "/") {
          cancelNoteLoad();
          activeNoteRef.current = null;
          actions.setActiveNote(null);
          actions.setMobileView("list");
          actions.setViewMode("all");
          return;
        }

        // AppLayout still has a few legacy module transitions that canonicalize back to "/"
        // with replaceState. If a note remains active when that happens (for example leaving
        // Mind Map), immediately restore the resource URL so address bar and editor never diverge.
        if (
          event?.type === APP_PATH_CHANGED_EVENT
          && pathname === "/"
          && activeNoteRef.current?.id
          && NOTE_WORKSPACE_VIEWS.has(viewModeRef.current)
        ) {
          pushNoteAppPath(activeNoteRef.current.id);
        }
        return;
      }

      const noteId = route.noteId;
      if (activeNoteRef.current?.id === noteId) {
        pendingRouteNoteIdRef.current = null;
        actions.setMobileView("editor");
        return;
      }

      pendingRouteNoteIdRef.current = noteId;
      const sequence = ++routeLoadSequenceRef.current;
      actions.setMobileView("editor");

      void loadNote({
        noteId,
        summary: { title: "…", notebookId: "" },
        request: () => api.getNote(noteId),
        onSuccess: (note) => {
          if (disposed || sequence !== routeLoadSequenceRef.current) return;
          if (getCurrentNoteAppRoute().noteId !== noteId) return;

          activeNoteRef.current = note;
          actions.setActiveNote(note);
          actions.setSelectedNotebook(note.notebookId);
          actions.setViewMode("notebook");
          actions.setMobileView("editor");
          if (prefs.enableNoteTabs) actions.openNoteTab(tabFromNote(note));
        },
        onError: (error) => {
          if (disposed || sequence !== routeLoadSequenceRef.current) return;
          if (getCurrentNoteAppRoute().noteId !== noteId) return;

          console.error("[note-deep-link] failed to open routed note", { noteId, error });
          // The coordinator resolves failures and keeps their error surface visible.
          // Dismiss that surface before returning to the list.
          cancelNoteLoad();
          pendingRouteNoteIdRef.current = null;
          activeNoteRef.current = null;
          actions.setActiveNote(null);
          actions.setMobileView("list");
          actions.setViewMode("all");
          replaceAppPathState("/");
          const status = (error as { status?: number })?.status;
          if (status === 404 || status === 403) {
            // A 404 also hides inaccessible notes and password-protected folders.
            toast.info(t("noteList.routeUnavailableHint"));
          } else {
            toast.error(error instanceof Error ? error.message : t("noteList.loadErrorTitle"));
          }
        },
      });
    };

    applyRoute();
    const onPopState = (event: PopStateEvent) => applyRoute(event);
    const onAppPathChanged = (event: Event) => applyRoute(event);
    window.addEventListener("popstate", onPopState);
    window.addEventListener(APP_PATH_CHANGED_EVENT, onAppPathChanged);

    return () => {
      disposed = true;
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(APP_PATH_CHANGED_EVENT, onAppPathChanged);
    };
  }, [actions, cancelNoteLoad, loadNote, prefs.enableNoteTabs, t]);

  useEffect(() => {
    const activeNoteId = state.activeNote?.id ?? null;
    const previousActiveNoteId = previousActiveNoteIdRef.current;
    const previousViewMode = previousViewModeRef.current;
    const activeNoteChanged = activeNoteId !== previousActiveNoteId;
    const enteredNoteWorkspace = (
      !NOTE_WORKSPACE_VIEWS.has(previousViewMode)
      && NOTE_WORKSPACE_VIEWS.has(state.viewMode)
    );

    // Record what this render observed before any early return. On initial mount the refs
    // already contain the same values, so a stale activeNote cannot hijack /sheets or /mindmaps.
    previousActiveNoteIdRef.current = activeNoteId;
    previousViewModeRef.current = state.viewMode;

    if (!NOTE_WORKSPACE_VIEWS.has(state.viewMode)) return;

    const pathname = resolveCurrentAppPathname();
    const currentRoute = parseNoteAppPath(pathname);
    const pendingRouteNoteId = pendingRouteNoteIdRef.current;
    if (pendingRouteNoteId) {
      // Keep route ownership until the AppContext render actually reflects the routed note.
      // Clearing this in onSuccess is too early: React may not have committed setActiveNote yet,
      // causing the same effect pass to see activeNote=null and canonicalize back to "/".
      if (
        state.activeNote?.id === pendingRouteNoteId
        && currentRoute.noteId === pendingRouteNoteId
      ) {
        pendingRouteNoteIdRef.current = null;
      } else {
        return;
      }
    }

    if (state.activeNote?.id) {
      if (currentRoute.noteId === state.activeNote.id) return;
      // A different resource route may coexist with a stale activeNote in AppContext.
      // Only take over that route when this render represents explicit note navigation:
      // either the active note itself changed (Sheet -> Note), or the app entered a note
      // workspace from a non-note workspace (MindMap -> the same previously active Note).
      const explicitNoteNavigation = activeNoteChanged || enteredNoteWorkspace;
      if (pathname !== "/" && !currentRoute.matched && !explicitNoteNavigation) return;
      pushNoteAppPath(state.activeNote.id);
      return;
    }

    if (currentRoute.matched) {
      replaceAppPathState("/");
    }
  }, [state.activeNote?.id, state.viewMode]);

  return null;
}
