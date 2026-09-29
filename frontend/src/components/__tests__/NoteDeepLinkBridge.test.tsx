// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOTE_A = "123e4567-e89b-42d3-a456-426614174216";
const NOTE_B = "223e4567-e89b-42d3-a456-426614174217";

const mocks = vi.hoisted(() => ({
  state: {
    activeNote: null as any,
    viewMode: "all" as any,
  },
  actions: {
    setActiveNote: vi.fn(),
    setMobileView: vi.fn(),
    setViewMode: vi.fn(),
    setSelectedNotebook: vi.fn(),
    openNoteTab: vi.fn(),
  },
  loadNote: vi.fn(),
  cancelNoteLoad: vi.fn(),
  api: {
    getNote: vi.fn(),
  },
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
  useAppActions: () => mocks.actions,
}));

vi.mock("@/hooks/useUserPreferences", () => ({
  useUserPreferences: () => ({ prefs: { enableNoteTabs: true } }),
}));

vi.mock("@/hooks/useNoteLoader", () => ({
  useNoteLoader: () => ({
    loadNote: mocks.loadNote,
    cancelNoteLoad: mocks.cancelNoteLoad,
  }),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.api,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn() },
}));

import NoteDeepLinkBridge from "@/components/NoteDeepLinkBridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function note(id: string) {
  return {
    id,
    title: id === NOTE_A ? "A" : "B",
    notebookId: "notebook-1",
    workspaceId: null,
    contentFormat: "tiptap-json",
    isLocked: 0,
    isTrashed: 0,
    updatedAt: "2026-09-29T00:00:00.000Z",
  };
}

describe("NoteDeepLinkBridge", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.activeNote = null;
    mocks.state.viewMode = "all";
    window.history.replaceState(null, "", "/");
    mocks.loadNote.mockImplementation(async (options: any) => {
      const loaded = note(options.noteId);
      options.onSuccess?.(loaded);
      return loaded;
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  it("restores a routed note on refresh/deep-link entry", async () => {
    window.history.replaceState(null, "", `/notes/${NOTE_A}`);

    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
      await Promise.resolve();
    });

    expect(mocks.loadNote).toHaveBeenCalledWith(expect.objectContaining({
      noteId: NOTE_A,
      request: expect.any(Function),
      onSuccess: expect.any(Function),
    }));
    expect(mocks.actions.setActiveNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: NOTE_A }),
    );
    expect(mocks.actions.setSelectedNotebook).toHaveBeenCalledWith("notebook-1");
    expect(mocks.actions.setViewMode).toHaveBeenCalledWith("notebook");
    expect(mocks.actions.setMobileView).toHaveBeenCalledWith("editor");
    expect(mocks.actions.openNoteTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: NOTE_A }),
    );
  });

  it("publishes /notes/:id whenever a normal note activation changes", async () => {
    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
    });

    mocks.state.activeNote = note(NOTE_B);
    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe(`/notes/${NOTE_B}`);
    // The path event sees the already active note and must not fetch it again.
    expect(mocks.loadNote).not.toHaveBeenCalled();
  });

  it("uses browser Back to root as navigation intent and closes the active resource", async () => {
    mocks.state.activeNote = note(NOTE_A);
    window.history.replaceState(null, "", `/notes/${NOTE_A}`);

    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
    });

    window.history.replaceState(null, "", "/");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve();
    });

    expect(mocks.cancelNoteLoad).toHaveBeenCalled();
    expect(mocks.actions.setActiveNote).toHaveBeenCalledWith(null);
    expect(mocks.actions.setMobileView).toHaveBeenCalledWith("list");
    expect(mocks.actions.setViewMode).toHaveBeenCalledWith("all");
  });

  it("does not overwrite another module route with a stale active note", async () => {
    mocks.state.activeNote = note(NOTE_A);
    mocks.state.viewMode = "mindmaps";
    window.history.replaceState(null, "", `/mindmaps/${NOTE_B}`);

    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe(`/mindmaps/${NOTE_B}`);
  });
});
