import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  noteListCollapsed: false,
  editorFullscreen: false,
  editorSplit: null as null | { noteId: string; direction: "right" | "down" },
}));

const actions = vi.hoisted(() => ({
  toggleNoteListCollapsed: vi.fn(() => {
    state.noteListCollapsed = !state.noteListCollapsed;
  }),
  setEditorFullscreen: vi.fn((value: boolean) => {
    state.editorFullscreen = value;
  }),
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state }),
  useAppActions: () => actions,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
}));

import NoteWorkspaceLayoutController from "@/components/NoteWorkspaceLayoutController";
import { NOTE_WORKSPACE_LAYOUT_STORAGE_KEY } from "@/lib/noteWorkspaceLayout";

function mountDesktopSidebarHeader() {
  const aside = document.createElement("aside");
  aside.dataset.unifiedSidebar = "";
  aside.dataset.sidebarVariant = "desktop";
  const header = document.createElement("header");
  aside.appendChild(header);
  document.body.appendChild(aside);
  return header;
}

describe("NoteWorkspaceLayoutController", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    state.noteListCollapsed = false;
    state.editorFullscreen = false;
    state.editorSplit = null;
    actions.toggleNoteListCollapsed.mockClear();
    actions.setEditorFullscreen.mockClear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
  });

  it("switches between standard, three-column and focus modes", async () => {
    mountDesktopSidebarHeader();
    const view = render(<NoteWorkspaceLayoutController />);

    fireEvent.click(screen.getByRole("button", { name: "布局模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /标准模式/ }));

    await waitFor(() => expect(actions.toggleNoteListCollapsed).toHaveBeenCalledTimes(1));
    expect(state.noteListCollapsed).toBe(true);
    expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("standard");

    view.rerender(<NoteWorkspaceLayoutController />);
    fireEvent.click(screen.getByRole("button", { name: "布局模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /三栏模式/ }));

    await waitFor(() => expect(actions.toggleNoteListCollapsed).toHaveBeenCalledTimes(2));
    expect(state.noteListCollapsed).toBe(false);
    expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("three-column");

    view.rerender(<NoteWorkspaceLayoutController />);
    fireEvent.click(screen.getByRole("button", { name: "布局模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /专注模式/ }));
    expect(actions.setEditorFullscreen).toHaveBeenLastCalledWith(true);
    expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("three-column");
  });

  it("restores the preferred three-column mode after a right split", async () => {
    mountDesktopSidebarHeader();
    localStorage.setItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY, "three-column");
    const view = render(<NoteWorkspaceLayoutController />);

    state.editorSplit = { noteId: "n2", direction: "right" };
    view.rerender(<NoteWorkspaceLayoutController />);
    await waitFor(() => expect(actions.toggleNoteListCollapsed).toHaveBeenCalledTimes(1));
    expect(state.noteListCollapsed).toBe(true);

    view.rerender(<NoteWorkspaceLayoutController />);
    state.editorSplit = null;
    view.rerender(<NoteWorkspaceLayoutController />);
    await waitFor(() => expect(actions.toggleNoteListCollapsed).toHaveBeenCalledTimes(2));
    expect(state.noteListCollapsed).toBe(false);

    view.rerender(<NoteWorkspaceLayoutController />);
    state.noteListCollapsed = true;
    view.rerender(<NoteWorkspaceLayoutController />);

    await waitFor(() => {
      expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("standard");
    });
    expect(actions.toggleNoteListCollapsed).toHaveBeenCalledTimes(2);
  });
});
