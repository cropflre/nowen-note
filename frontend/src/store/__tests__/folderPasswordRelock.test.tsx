import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Note } from "@/types";
import { KNOWLEDGE_TREE_PASSWORD_NOTES_LOCKED_EVENT } from "@/lib/knowledgeTreePassword";
vi.mock("@/lib/api", () => ({ api: { getNotebooks: vi.fn(async () => []) } }));
import { AppProvider, useApp } from "../AppContext";

it("removes relocked bodies, previews, tabs and split panes even if an editor prevents leaving", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  let context!: ReturnType<typeof useApp>;
  function Grabber() { context = useApp(); return null; }
  const block = (event: Event) => event.preventDefault();
  try {
    act(() => root.render(<AppProvider><Grabber /></AppProvider>));
    act(() => {
      context.dispatch({ type: "SET_ACTIVE_NOTE", payload: { id: "private" } as Note });
      context.dispatch({ type: "SET_NOTES", payload: [{ id: "private" }, { id: "ordinary" }] as never });
      context.dispatch({ type: "SET_NOTE_TABS", payload: [{ id: "private" }, { id: "ordinary" }] as never });
      context.dispatch({ type: "SPLIT_EDITOR", payload: { noteId: "private", direction: "horizontal", readOnly: false } as never });
    });
    window.addEventListener("nowen:encrypted-note-before-leave", block);
    act(() => window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_PASSWORD_NOTES_LOCKED_EVENT, {
      detail: { noteIds: ["private"] },
    })));
    expect(context.state.activeNote).toBeNull();
    expect(context.state.notes.map((note) => note.id)).toEqual(["ordinary"]);
    expect(context.state.openNoteTabs.map((tab) => tab.id)).toEqual(["ordinary"]);
    expect(context.state.editorSplit).toBeNull();
  } finally {
    window.removeEventListener("nowen:encrypted-note-before-leave", block);
    act(() => root.unmount());
  }
});
