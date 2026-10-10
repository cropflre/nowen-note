// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteLoadCoordinator, type NoteLoadOptions, type NoteLoadSink } from "@/lib/noteLoadCoordinator";
import type { Note } from "@/types";

const NOTE_A = "123e4567-e89b-42d3-a456-426614174216";
const NOTE_B = "223e4567-e89b-42d3-a456-426614174217";
const MARKDOWN_ONBOARDING_ID = "onboarding-v1-user-42-zh-welcome";

const mocks = vi.hoisted(() => ({
  state: {
    activeNote: null as unknown,
    viewMode: "all" as unknown,
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
  toast: { error: vi.fn(), info: vi.fn() },
  t: (key: string) => key,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
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
  toast: mocks.toast,
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
  let loading: boolean;
  let sink: NoteLoadSink;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.activeNote = null;
    mocks.state.viewMode = "all";
    window.history.replaceState(null, "", "/");
    loading = false;
    sink = {
      begin: vi.fn(),
      show: vi.fn(() => { loading = true; }),
      markSlow: vi.fn(),
      finish: vi.fn(() => { loading = false; }),
      fail: vi.fn(() => { loading = true; }),
    };
    const coordinator = new NoteLoadCoordinator();
    mocks.api.getNote.mockImplementation(async (id: string) => note(id));
    mocks.loadNote.mockImplementation((options: Omit<NoteLoadOptions<Note>, "sink">) => (
      coordinator.run({ ...options, sink })
    ));
    mocks.cancelNoteLoad.mockImplementation(() => coordinator.cancel());
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
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

  it.each([
    ["web", 404],
    ["web", 403],
    ["native", 404],
  ])("returns %s entry to the list after an inaccessible note (%s)", async (runtime, status) => {
    if (runtime === "native") {
      vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    }
    window.history.replaceState(null, "", runtime === "native"
      ? `/?nowenAppPath=${encodeURIComponent(`/notes/${NOTE_A}`)}`
      : `/notes/${NOTE_A}`);
    mocks.api.getNote.mockRejectedValue(Object.assign(new Error("资源不存在"), { status }));

    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
    });

    expect(sink.fail).toHaveBeenCalled();
    expect(mocks.cancelNoteLoad).toHaveBeenCalledTimes(1);
    expect(sink.finish).toHaveBeenCalled();
    expect(loading).toBe(false);
    expect(mocks.actions.setActiveNote).toHaveBeenCalledWith(null);
    expect(mocks.actions.setMobileView).toHaveBeenLastCalledWith("list");
    expect(mocks.actions.setViewMode).toHaveBeenCalledWith("all");
    expect(window.location.pathname).toBe("/");
    expect(new URL(window.location.href).searchParams.has("nowenAppPath")).toBe(false);
    expect(mocks.toast.info).toHaveBeenCalledTimes(1);
    expect(mocks.toast.info).toHaveBeenCalledWith("noteList.routeUnavailableHint");
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("clears the error surface and keeps the cause of a network failure", async () => {
    window.history.replaceState(null, "", `/notes/${NOTE_A}`);
    mocks.api.getNote.mockRejectedValue(new Error("网络连接失败"));

    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
    });

    expect(loading).toBe(false);
    expect(sink.finish).toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
    expect(mocks.actions.setMobileView).toHaveBeenLastCalledWith("list");
    expect(mocks.toast.error).toHaveBeenCalledWith("网络连接失败");
    expect(mocks.toast.info).not.toHaveBeenCalled();
  });

  it("does not let an older failed request dismiss a newer routed note", async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<Note>((_resolve, reject) => { rejectFirst = reject; });
    mocks.api.getNote.mockImplementation((id: string) => (
      id === NOTE_A ? first : Promise.resolve(note(id))
    ));
    window.history.replaceState(null, "", `/notes/${NOTE_A}`);
    await act(async () => root.render(<NoteDeepLinkBridge />));

    window.history.replaceState(null, "", `/notes/${NOTE_B}`);
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await act(async () => rejectFirst(Object.assign(new Error("资源不存在"), { status: 404 })));

    expect(window.location.pathname).toBe(`/notes/${NOTE_B}`);
    expect(mocks.actions.setActiveNote).toHaveBeenLastCalledWith(expect.objectContaining({ id: NOTE_B }));
    expect(mocks.cancelNoteLoad).not.toHaveBeenCalled();
    expect(mocks.toast.info).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
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

  it("does not hijack a sheet route from stale active-note state on mount", async () => {
    mocks.state.activeNote = note(NOTE_A);
    mocks.state.viewMode = "all";
    window.history.replaceState(null, "", `/sheets/${NOTE_B}`);

    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe(`/sheets/${NOTE_B}`);
  });

  it("switches Sheet -> Note when the user activates a new note", async () => {
    mocks.state.activeNote = null;
    mocks.state.viewMode = "all";
    window.history.replaceState(null, "", `/sheets/${NOTE_A}`);

    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
    });

    mocks.state.activeNote = note(NOTE_B);
    mocks.state.viewMode = "notebook";
    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe(`/notes/${NOTE_B}`);
    expect(mocks.loadNote).not.toHaveBeenCalled();
  });

  it("switches Sheet -> onboarding Markdown note with a non-UUID id", async () => {
    mocks.state.activeNote = null;
    mocks.state.viewMode = "all";
    window.history.replaceState(null, "", `/sheets/${NOTE_A}`);

    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
    });

    mocks.state.activeNote = {
      ...note(NOTE_B),
      id: MARKDOWN_ONBOARDING_ID,
      title: "欢迎使用 Nowen Note",
      contentFormat: "markdown",
    };
    mocks.state.viewMode = "notebook";
    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe(`/notes/${MARKDOWN_ONBOARDING_ID}`);
    expect(mocks.loadNote).not.toHaveBeenCalled();
  });

  it("switches MindMap -> the same active Note when entering the note workspace", async () => {
    mocks.state.activeNote = note(NOTE_A);
    mocks.state.viewMode = "mindmaps";
    window.history.replaceState(null, "", `/mindmaps/${NOTE_B}`);

    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
    });

    mocks.state.viewMode = "notebook";
    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe(`/notes/${NOTE_A}`);
  });

  it("restores the active note resource URL when a legacy module returns to root", async () => {
    mocks.state.activeNote = note(NOTE_A);
    mocks.state.viewMode = "all";

    await act(async () => {
      root.render(<NoteDeepLinkBridge />);
    });

    // Simulate AppLayout normalizing a legacy module route back to root.
    window.history.replaceState(null, "", "/");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("nowen:app-path-changed", {
        detail: { appPath: "/", replace: true },
      }));
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe(`/notes/${NOTE_A}`);
  });
});
