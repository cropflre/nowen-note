import { describe, expect, it, vi } from "vitest";

import {
  LEGACY_NOTEBOOK_TREE_SORT_KEY,
  LEGACY_NOTE_LIST_COLLAPSED_KEY,
  NOTE_WORKSPACE_LAYOUT_KEY,
  migrateUnifiedTreeOnlyLayout,
  shouldCollapseLegacyNoteList,
  usesFunctionalNoteList,
  type StorageLike,
} from "@/lib/unifiedTreeOnlyLayout";

function createStorage(initial: Record<string, string> = {}): StorageLike & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("unifiedTreeOnlyLayout", () => {
  it("identifies ordinary tree navigation and functional result lists", () => {
    for (const mode of ["all", "notebook", "tasks", "files", "diary", "mindmaps", "ai-chat", "shares"]) {
      expect(usesFunctionalNoteList(mode)).toBe(false);
      expect(shouldCollapseLegacyNoteList(mode)).toBe(true);
    }

    for (const mode of ["favorites", "trash", "tag", "search"]) {
      expect(usesFunctionalNoteList(mode)).toBe(true);
      expect(shouldCollapseLegacyNoteList(mode)).toBe(false);
    }
  });

  it("defaults users without an explicit workspace preference to standard mode", () => {
    const storage = createStorage({
      [LEGACY_NOTE_LIST_COLLAPSED_KEY]: "0",
      [LEGACY_NOTEBOOK_TREE_SORT_KEY]: JSON.stringify({ by: "name", dir: "asc" }),
    });

    migrateUnifiedTreeOnlyLayout(storage);

    expect(storage.getItem(LEGACY_NOTE_LIST_COLLAPSED_KEY)).toBe("1");
    expect(storage.getItem(LEGACY_NOTEBOOK_TREE_SORT_KEY)).toBeNull();
  });

  it("keeps an explicit three-column preference expanded before AppContext initializes", () => {
    const storage = createStorage({
      [NOTE_WORKSPACE_LAYOUT_KEY]: "three-column",
      [LEGACY_NOTE_LIST_COLLAPSED_KEY]: "1",
    });

    migrateUnifiedTreeOnlyLayout(storage);

    expect(storage.getItem(LEGACY_NOTE_LIST_COLLAPSED_KEY)).toBe("0");
  });

  it("keeps an explicit standard preference collapsed before AppContext initializes", () => {
    const storage = createStorage({
      [NOTE_WORKSPACE_LAYOUT_KEY]: "standard",
      [LEGACY_NOTE_LIST_COLLAPSED_KEY]: "0",
    });

    migrateUnifiedTreeOnlyLayout(storage);

    expect(storage.getItem(LEGACY_NOTE_LIST_COLLAPSED_KEY)).toBe("1");
  });

  it("does not throw when storage is restricted", () => {
    const storage: StorageLike = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new Error("blocked"); }),
      removeItem: vi.fn(() => { throw new Error("blocked"); }),
    };

    expect(() => migrateUnifiedTreeOnlyLayout(storage)).not.toThrow();
  });
});
