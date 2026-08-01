// @vitest-environment jsdom

import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function click(element: Element | null) {
  expect(element).not.toBeNull();
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function findMenuChoice(text: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    .find((element) => element.textContent?.includes(text)) || null;
}

describe("NoteWorkspaceLayoutController", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    state.noteListCollapsed = false;
    state.editorFullscreen = false;
    state.editorSplit = null;
    actions.toggleNoteListCollapsed.mockClear();
    actions.setEditorFullscreen.mockClear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });

    const aside = document.createElement("aside");
    aside.dataset.unifiedSidebar = "";
    aside.dataset.sidebarVariant = "desktop";
    aside.appendChild(document.createElement("header"));
    document.body.appendChild(aside);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("switches among standard, three-column and focus modes", () => {
    act(() => root.render(<NoteWorkspaceLayoutController />));

    act(() => click(document.querySelector('[data-testid="note-workspace-layout-trigger"]')));
    act(() => click(findMenuChoice("标准模式")));
    expect(actions.toggleNoteListCollapsed).toHaveBeenCalledTimes(1);
    expect(state.noteListCollapsed).toBe(true);
    expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("standard");

    act(() => root.render(<NoteWorkspaceLayoutController />));
    act(() => click(document.querySelector('[data-testid="note-workspace-layout-trigger"]')));
    act(() => click(findMenuChoice("三栏模式")));
    expect(actions.toggleNoteListCollapsed).toHaveBeenCalledTimes(2);
    expect(state.noteListCollapsed).toBe(false);
    expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("three-column");

    act(() => root.render(<NoteWorkspaceLayoutController />));
    act(() => click(document.querySelector('[data-testid="note-workspace-layout-trigger"]')));
    act(() => click(findMenuChoice("专注模式")));
    expect(actions.setEditorFullscreen).toHaveBeenLastCalledWith(true);
    expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("three-column");
  });

  it("restores three-column mode after right split and still accepts a manual collapse", () => {
    localStorage.setItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY, "three-column");
    act(() => root.render(<NoteWorkspaceLayoutController />));

    state.editorSplit = { noteId: "n2", direction: "right" };
    act(() => root.render(<NoteWorkspaceLayoutController />));
    expect(actions.toggleNoteListCollapsed).toHaveBeenCalledTimes(1);
    expect(state.noteListCollapsed).toBe(true);

    act(() => root.render(<NoteWorkspaceLayoutController />));
    state.editorSplit = null;
    act(() => root.render(<NoteWorkspaceLayoutController />));
    expect(actions.toggleNoteListCollapsed).toHaveBeenCalledTimes(2);
    expect(state.noteListCollapsed).toBe(false);

    act(() => root.render(<NoteWorkspaceLayoutController />));
    state.noteListCollapsed = true;
    act(() => root.render(<NoteWorkspaceLayoutController />));

    expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("standard");
    expect(actions.toggleNoteListCollapsed).toHaveBeenCalledTimes(2);
  });
});
