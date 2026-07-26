import { describe, expect, it } from "vitest";
import {
  clampEditorSplitRatio,
  getEditorSplitRatioStorageKey,
  isEditorLayoutToggleShortcut,
  loadEditorSplitRatio,
  resolveEditorWorkspaceMode,
  saveEditorSplitRatio,
  type StorageLike,
} from "@/lib/editorWorkspaceLayout";

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("editorWorkspaceLayout", () => {
  it("recognizes the cross-platform note-list shortcut", () => {
    expect(isEditorLayoutToggleShortcut({ key: "B", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isEditorLayoutToggleShortcut({ key: "b", metaKey: true, shiftKey: true })).toBe(true);
    expect(isEditorLayoutToggleShortcut({ key: "b", ctrlKey: true })).toBe(false);
    expect(isEditorLayoutToggleShortcut({ key: "b", ctrlKey: true, shiftKey: true, altKey: true })).toBe(false);
  });

  it("resolves the four product layout modes in priority order", () => {
    expect(resolveEditorWorkspaceMode({ editorFullscreen: false, noteListCollapsed: false, hasSplit: false })).toBe("manage");
    expect(resolveEditorWorkspaceMode({ editorFullscreen: false, noteListCollapsed: true, hasSplit: false })).toBe("focus");
    expect(resolveEditorWorkspaceMode({ editorFullscreen: false, noteListCollapsed: false, hasSplit: true })).toBe("split");
    expect(resolveEditorWorkspaceMode({ editorFullscreen: true, noteListCollapsed: false, hasSplit: true })).toBe("fullscreen");
  });

  it("clamps and persists a ratio per split direction", () => {
    const storage = createMemoryStorage();
    expect(saveEditorSplitRatio("right", 0.73, storage)).toBe(0.73);
    expect(loadEditorSplitRatio("right", storage)).toBe(0.73);
    expect(loadEditorSplitRatio("down", storage)).toBe(0.5);

    saveEditorSplitRatio("down", 2, storage);
    expect(loadEditorSplitRatio("down", storage)).toBe(0.8);
    expect(getEditorSplitRatioStorageKey("right")).not.toBe(getEditorSplitRatioStorageKey("down"));
  });

  it("falls back safely for invalid stored ratios", () => {
    const storage = createMemoryStorage({
      [getEditorSplitRatioStorageKey("right")]: "not-a-number",
    });
    expect(loadEditorSplitRatio("right", storage)).toBe(0.5);
    expect(clampEditorSplitRatio(-1)).toBe(0.2);
    expect(clampEditorSplitRatio(10)).toBe(0.8);
  });
});
