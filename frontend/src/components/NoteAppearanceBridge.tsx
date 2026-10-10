import { useCallback, useEffect, useRef } from "react";

import {
  getNoteAppearance,
  NOTE_APPEARANCE_CHANGED_EVENT,
  type NoteAppearanceState,
} from "@/lib/noteAppearance";
import { applyExplicitNoteTheme, clearExplicitNoteTheme } from "@/lib/noteAppearanceSurface";
import { PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, pluginApi } from "@/lib/pluginApi";
import { replacePluginNoteThemes, subscribePluginNoteThemes } from "@/lib/pluginNoteThemeRegistry";

const SURFACE_SELECTOR = ".note-theme-surface";

export default function NoteAppearanceBridge() {
  const appearancesRef = useRef(new Map<string, NoteAppearanceState>());
  const pendingRef = useRef(new Set<string>());

  const applySurface = useCallback((surface: HTMLElement) => {
    const noteId = surface.dataset.noteId;
    const appearance = noteId ? appearancesRef.current.get(noteId) : null;
    if (!appearance?.themeId) clearExplicitNoteTheme(surface);
    else applyExplicitNoteTheme(surface, appearance.themeId);
  }, []);

  const applyCurrent = useCallback(() => {
    document.querySelectorAll<HTMLElement>(SURFACE_SELECTOR).forEach(applySurface);
  }, [applySurface]);

  const applyNote = useCallback((noteId: string) => {
    document.querySelectorAll<HTMLElement>(SURFACE_SELECTOR).forEach((surface) => {
      if (surface.dataset.noteId === noteId) applySurface(surface);
    });
  }, [applySurface]);

  const loadAppearance = useCallback((surface: HTMLElement) => {
    const noteId = surface.dataset.noteId;
    if (!noteId) {
      clearExplicitNoteTheme(surface);
      return;
    }
    const cached = appearancesRef.current.get(noteId);
    if (cached) applySurface(surface);
    else clearExplicitNoteTheme(surface);
    if (pendingRef.current.has(noteId)) return;
    pendingRef.current.add(noteId);
    void getNoteAppearance(noteId).then((appearance) => {
      appearancesRef.current.set(noteId, appearance);
      applyNote(noteId);
    }).catch(() => {
      appearancesRef.current.delete(noteId);
      applyNote(noteId);
    }).finally(() => {
      pendingRef.current.delete(noteId);
    });
  }, [applyNote, applySurface]);

  useEffect(() => {
    const refresh = () => {
      void pluginApi.contributions()
        .then((records) => replacePluginNoteThemes(records))
        .catch(() => replacePluginNoteThemes([]));
    };
    refresh();
    window.addEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, refresh);
  }, []);

  useEffect(() => subscribePluginNoteThemes(applyCurrent), [applyCurrent]);

  useEffect(() => {
    const onAppearanceChanged = (event: Event) => {
      const appearance = (event as CustomEvent<NoteAppearanceState>).detail;
      if (!appearance?.noteId) return;
      appearancesRef.current.set(appearance.noteId, appearance);
      applyNote(appearance.noteId);
    };
    window.addEventListener(NOTE_APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
    return () => window.removeEventListener(NOTE_APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
  }, [applyNote]);

  useEffect(() => {
    document.querySelectorAll<HTMLElement>(SURFACE_SELECTOR).forEach(loadAppearance);

    const modeObserver = new MutationObserver(() => applyCurrent());
    modeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    const surfaceObserver = new MutationObserver((records) => {
      const affected = new Set<HTMLElement>();
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof HTMLElement) affected.add(record.target);
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches(SURFACE_SELECTOR)) affected.add(node);
          node.querySelectorAll<HTMLElement>(SURFACE_SELECTOR).forEach((surface) => affected.add(surface));
        }
      }
      affected.forEach(loadAppearance);
    });
    surfaceObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-note-id"],
      childList: true,
      subtree: true,
    });
    return () => {
      modeObserver.disconnect();
      surfaceObserver.disconnect();
    };
  }, [applyCurrent, loadAppearance]);

  return null;
}
