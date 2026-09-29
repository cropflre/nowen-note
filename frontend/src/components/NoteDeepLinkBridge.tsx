import { useEffect, useRef } from "react";

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

  const activeNoteRef = useRef(state.activeNote);
  const viewModeRef = useRef(state.viewMode);
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
          pendingRouteNoteIdRef.current = null;
          actions.setActiveNote(note);
          actions.setSelectedNotebook(note.notebookId);
          actions.setViewMode("notebook");
          actions.setMobileView("editor");
          if (prefs.enableNoteTabs) actions.openNoteTab(tabFromNote(note));
        },
      }).catch((error: unknown) => {
        if (disposed || sequence !== routeLoadSequenceRef.current) return;
        if (getCurrentNoteAppRoute().noteId !== noteId) return;

        console.error("[note-deep-link] failed to open routed note", { noteId, error });
        pendingRouteNoteIdRef.current = null;
        activeNoteRef.current = null;
        actions.setActiveNote(null);
        actions.setMobileView("list");
        actions.setViewMode("all");
        replaceAppPathState("/");
        toast.error(error instanceof Error ? error.message : "无法打开该笔记");
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
  }, [actions, cancelNoteLoad, loadNote, prefs.enableNoteTabs]);

  useEffect(() => {
    if (pendingRouteNoteIdRef.current) return;
    if (!NOTE_WORKSPACE_VIEWS.has(state.viewMode)) return;

    const pathname = resolveCurrentAppPathname();
    const currentRoute = parseNoteAppPath(pathname);

    if (state.activeNote?.id) {
      if (currentRoute.noteId === state.activeNote.id) return;
      // Do not hijack another module/public/unknown resource route. AppLayout will normalize
      // legacy module transitions back to "/" first, after which the next note-state transition
      // can publish its canonical resource URL.
      if (pathname !== "/" && !currentRoute.matched) return;
      pushNoteAppPath(state.activeNote.id);
      return;
    }

    if (currentRoute.matched) {
      replaceAppPathState("/");
    }
  }, [state.activeNote?.id, state.viewMode]);

  return null;
}
