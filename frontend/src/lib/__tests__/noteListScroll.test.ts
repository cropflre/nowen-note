import { describe, expect, it } from "vitest";
import {
  buildNoteListScrollScopeKey,
  resolveAnchoredScrollTop,
} from "@/lib/noteListScroll";

const baseScope = {
  viewMode: "notebook",
  selectedNotebookId: "notebook-a",
  selectedKnowledgeTreeParentId: "tree-a",
  selectedTagIds: ["tag-b", "tag-a"],
  searchQuery: "",
  dateFilter: null,
  sortBy: "updatedAt",
  sortDir: "desc",
  folderScope: "recursive" as const,
  unlockedFolderIds: ["folder-b", "folder-a"],
  folderPasswordSessionRevision: 2,
};

describe("buildNoteListScrollScopeKey", () => {
  it("is stable when unordered scope collections arrive in a different order", () => {
    const first = buildNoteListScrollScopeKey(baseScope);
    const second = buildNoteListScrollScopeKey({
      ...baseScope,
      selectedTagIds: ["tag-a", "tag-b"],
      unlockedFolderIds: ["folder-a", "folder-b"],
    });

    expect(second).toBe(first);
  });

  it("changes only when the logical list scope changes", () => {
    const original = buildNoteListScrollScopeKey(baseScope);

    expect(buildNoteListScrollScopeKey({ ...baseScope, selectedNotebookId: "notebook-b" }))
      .not.toBe(original);
    expect(buildNoteListScrollScopeKey({ ...baseScope, searchQuery: "needle" }))
      .not.toBe(original);
    expect(buildNoteListScrollScopeKey({ ...baseScope, dateFilter: "2026-09-10" }))
      .not.toBe(original);
    expect(buildNoteListScrollScopeKey({ ...baseScope, sortDir: "asc" }))
      .not.toBe(original);
    expect(buildNoteListScrollScopeKey({ ...baseScope, folderScope: "current" }))
      .not.toBe(original);
  });
});

describe("resolveAnchoredScrollTop", () => {
  it("keeps the same note at the same visual offset after notes are inserted above it", () => {
    const anchor = { noteId: "note-c", offsetWithinItem: 17 };

    expect(resolveAnchoredScrollTop(
      ["note-new", "note-a", "note-b", "note-c", "note-d"],
      anchor,
      90,
    )).toBe(287);
  });

  it("keeps the same note anchored after a same-scope reorder", () => {
    const anchor = { noteId: "note-c", offsetWithinItem: 12 };

    expect(resolveAnchoredScrollTop(
      ["note-c", "note-a", "note-b", "note-d"],
      anchor,
      90,
    )).toBe(12);
  });

  it("returns null when the anchor note no longer exists", () => {
    expect(resolveAnchoredScrollTop(
      ["note-a", "note-b"],
      { noteId: "note-c", offsetWithinItem: 10 },
      90,
    )).toBeNull();
  });
});
