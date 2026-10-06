import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ api: { getNotebooks: vi.fn(async () => []) } }));
import { AppProvider, useApp } from "../AppContext";
it("an encrypted region in an ordinary note can prevent navigation without blocking unrelated state updates", () => {
  const container = document.createElement("div"); const root = createRoot(container);
  let context: ReturnType<typeof useApp>;
  function Grabber() { context = useApp(); return null; }
  const block = (event: Event) => event.preventDefault();
  try {
    act(() => root.render(<AppProvider><Grabber /></AppProvider>));
    act(() => context.dispatch({ type: "SET_ACTIVE_NOTE", payload: { id: "ordinary", contentFormat: "markdown" } as unknown as import("@/types/index").Note | null }));
    window.addEventListener("nowen:encrypted-note-before-leave", block);
    act(() => context.dispatch({ type: "SET_ACTIVE_NOTE", payload: null }));
    expect(context!.state.activeNote?.id).toBe("ordinary");
    act(() => context.dispatch({ type: "SET_NOTES", payload: [] }));
    expect(context!.state.notes).toEqual([]);
    window.removeEventListener("nowen:encrypted-note-before-leave", block);
    act(() => context.dispatch({ type: "SET_ACTIVE_NOTE", payload: null }));
    expect(context!.state.activeNote).toBeNull();
  } finally { window.removeEventListener("nowen:encrypted-note-before-leave", block); act(() => root.unmount()); container.remove(); }
});
