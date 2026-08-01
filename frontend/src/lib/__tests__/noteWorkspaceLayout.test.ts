import { beforeEach, describe, expect, it } from "vitest";
import {
  NOTE_WORKSPACE_LAYOUT_STORAGE_KEY,
  THREE_COLUMN_MIN_VIEWPORT_WIDTH,
  getAutomaticCollapseReason,
  loadNoteWorkspaceLayoutMode,
  persistNoteWorkspaceLayoutMode,
  resolveNoteWorkspaceVisibility,
} from "@/lib/noteWorkspaceLayout";

describe("note workspace layout", () => {
  beforeEach(() => localStorage.clear());

  it("migrates the previous note-list collapsed preference", () => {
    expect(loadNoteWorkspaceLayoutMode(true)).toBe("standard");
    expect(loadNoteWorkspaceLayoutMode(false)).toBe("three-column");
  });

  it("persists an explicit device-local preference", () => {
    persistNoteWorkspaceLayoutMode("standard");
    expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("standard");
    expect(loadNoteWorkspaceLayoutMode(false)).toBe("standard");
  });

  it("shows the middle list when three-column mode has enough room", () => {
    expect(resolveNoteWorkspaceVisibility({
      mode: "three-column",
      noteListCollapsed: false,
      editorFullscreen: false,
      viewportWidth: THREE_COLUMN_MIN_VIEWPORT_WIDTH,
      splitDirection: null,
    })).toEqual({ showNoteList: true, autoCollapseReason: null });
  });

  it("falls back on narrow windows without changing the preferred mode", () => {
    expect(resolveNoteWorkspaceVisibility({
      mode: "three-column",
      noteListCollapsed: false,
      editorFullscreen: false,
      viewportWidth: THREE_COLUMN_MIN_VIEWPORT_WIDTH - 1,
      splitDirection: null,
    })).toEqual({ showNoteList: false, autoCollapseReason: "viewport" });
  });

  it("temporarily collapses for right split but not down split", () => {
    expect(getAutomaticCollapseReason({
      editorFullscreen: false,
      viewportWidth: 1920,
      splitDirection: "right",
    })).toBe("right-split");
    expect(getAutomaticCollapseReason({
      editorFullscreen: false,
      viewportWidth: 1920,
      splitDirection: "down",
    })).toBeNull();
  });

  it("uses focus mode as a temporary automatic collapse", () => {
    expect(getAutomaticCollapseReason({
      editorFullscreen: true,
      viewportWidth: 1920,
      splitDirection: null,
    })).toBe("focus");
  });
});
