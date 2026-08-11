// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  activeNote: null as null | { id: string },
  mobileSidebarOpen: false,
  mobileView: "editor" as "list" | "editor",
  noteListCollapsed: false,
  viewMode: "all",
}));

const actions = vi.hoisted(() => ({
  toggleNoteListCollapsed: vi.fn(),
  setMobileView: vi.fn((value: "list" | "editor") => {
    state.mobileView = value;
  }),
  setMobileSidebar: vi.fn((value: boolean) => {
    state.mobileSidebarOpen = value;
  }),
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state }),
  useAppActions: () => actions,
}));
vi.mock("@/components/KnowledgeTreeDrawer", () => ({ default: () => null }));
vi.mock("@/components/ShortcutHelpCenter", () => ({ default: () => null }));
vi.mock("@/components/ShortcutRuntimeBridge", () => ({ default: () => null }));

import MobileDrawerUxBridge from "@/components/MobileDrawerUxBridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("MobileDrawerUxBridge layout ownership", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    document.body.innerHTML = "";
    state.mobileSidebarOpen = false;
    state.mobileView = "editor";
    state.activeNote = null;
    state.noteListCollapsed = false;
    state.viewMode = "all";
    actions.toggleNoteListCollapsed.mockClear();
    actions.setMobileView.mockClear();
    actions.setMobileSidebar.mockClear();

    class StaticMutationObserver {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    }
    vi.stubGlobal("MutationObserver", StaticMutationObserver);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("does not collapse an ordinary Web three-column workspace", () => {
    act(() => root.render(<MobileDrawerUxBridge />));

    expect(actions.toggleNoteListCollapsed).not.toHaveBeenCalled();
    expect(state.noteListCollapsed).toBe(false);
  });

  it("keeps mobile progressive navigation for functional result views without changing desktop layout", () => {
    act(() => root.render(<MobileDrawerUxBridge />));
    state.viewMode = "favorites";
    act(() => root.render(<MobileDrawerUxBridge />));

    expect(actions.setMobileView).toHaveBeenCalledWith("list");
    expect(actions.toggleNoteListCollapsed).not.toHaveBeenCalled();
  });

  it("shows the note list when mobile starts without an active note", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });

    act(() => root.render(<MobileDrawerUxBridge />));

    expect(actions.setMobileView).toHaveBeenCalledWith("list");
    expect(actions.setMobileSidebar).not.toHaveBeenCalled();
  });
});
