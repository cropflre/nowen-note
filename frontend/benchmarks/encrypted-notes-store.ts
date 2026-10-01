import { useSyncExternalStore } from "react";
import type { Note } from "../src/types";
let state: { activeNote: Note | null; tags: any[] } = { activeNote: null, tags: [] };
const listeners = new Set<() => void>();
export const actions = {
  setActiveNote(note: Note | null) {
    if (state.activeNote && state.activeNote.id !== note?.id && !window.dispatchEvent(new Event("nowen:encrypted-note-before-leave", { cancelable: true }))) return;
    state = { ...state, activeNote: note }; for (const listener of listeners) listener();
  },
  updateNoteInList() {}, openNoteTab() {}, refreshNotes() {}, refreshNotebooks() {}, setMobileView() {},
};
export const useAppActions = () => actions;
export const useApp = () => ({ state: useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state) });
declare global { interface Window { encryptedFixtureState: () => typeof state } }
window.encryptedFixtureState = () => state;
