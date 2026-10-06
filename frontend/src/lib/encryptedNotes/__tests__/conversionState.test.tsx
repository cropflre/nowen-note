import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ api: { getNotebooks: vi.fn(async () => []) } }));
import { AppProvider, useApp } from "@/store/AppContext";
import { markConvertedNote } from "../conversionBarrier";
import { getOfflineQueueStorageKey } from "../../offlineScope";
import vector from "./fixtures/envelope-v1.json";

beforeEach(() => { localStorage.clear(); });
it("drops converted body, summary, tab, split and pending activation, rejecting late ordinary state updates", () => {
  const root = createRoot(document.createElement("div"));
  let context!: ReturnType<typeof useApp>;
  function Grabber() { context = useApp(); return null; }
  const original = { id: "note", version: 1, content: "private source", contentText: "private source", contentFormat: "markdown", title: "title" } as import("@/types").Note;
  const other = { ...original, id: "other" };
  try {
    act(() => root.render(<AppProvider><Grabber /></AppProvider>));
    act(() => {
      context.dispatch({ type: "SET_ACTIVE_NOTE", payload: original });
      context.dispatch({ type: "SET_NOTES", payload: [original, other] });
      context.dispatch({ type: "OPEN_NOTE_TAB", payload: original });
      context.dispatch({ type: "OPEN_NOTE_TAB", payload: other });
      context.dispatch({ type: "SPLIT_EDITOR", payload: { noteId: "note", direction: "right" } });
      context.dispatch({ type: "BEGIN_NOTE_LOAD", payload: { noteId: "note", requestId: 10, startedAt: 1, summary: original } });
    });
    const refresh = context.state.notesRefreshToken;
    act(() => markConvertedNote("note", 2, getOfflineQueueStorageKey()));
    expect(context.state.activeNote).toBeNull(); expect(context.state.editorSplit).toBeNull();
    expect(context.state.notes.map((note) => note.id)).toEqual(["other"]);
    expect(context.state.openNoteTabs.map((tab) => tab.id)).toEqual(["other"]);
    expect(context.state.noteLoadingState.pendingSummary).toBeNull();
    expect(context.state.notesRefreshToken).toBe(refresh + 1);
    act(() => {
      context.dispatch({ type: "SET_ACTIVE_NOTE", payload: original });
      context.dispatch({ type: "SET_NOTES", payload: [original, other] });
      context.dispatch({ type: "ADD_NOTE_TO_LIST", payload: original });
      context.dispatch({ type: "OPEN_NOTE_TAB", payload: original });
      context.dispatch({ type: "BEGIN_NOTE_LOAD", payload: { noteId: "note", requestId: 11, startedAt: 2, summary: original } });
    });
    expect(context.state.activeNote).toBeNull();
    expect(context.state.noteLoadingState.pendingSummary).toBeNull();
    expect(context.state.openNoteTabs.map((tab) => tab.id)).toEqual(["other"]);
    expect(context.state.notes.map((note) => note.id)).toEqual(["other"]);
    const encrypted = { ...original, version: 2, contentFormat: "encrypted-note-v1", contentText: "", content: JSON.stringify(vector.envelope) };
    act(() => context.dispatch({ type: "SET_ACTIVE_NOTE", payload: encrypted }));
    expect(context.state.activeNote).toEqual(encrypted);
    act(() => context.dispatch({ type: "SET_NOTES", payload: [encrypted, other] }));
    act(() => context.dispatch({ type: "UPDATE_NOTE_IN_LIST", payload: original }));
    expect(context.state.notes[0]).toEqual(encrypted);
  } finally { act(() => root.unmount()); }
});
