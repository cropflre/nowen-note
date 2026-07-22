import { describe, expect, it } from "vitest";
import { canApplyRevalidatedNote } from "@/lib/noteLoadSource";
import type { Note } from "@/types";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    userId: "user-1",
    notebookId: "book-1",
    title: "Cached title",
    content: "cached body",
    contentText: "cached body",
    contentFormat: "tiptap-json",
    version: 3,
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    sortOrder: 0,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  } as Note;
}

describe("canApplyRevalidatedNote", () => {
  const cached = makeNote();
  const remote = makeNote({
    version: 4,
    title: "Server title",
    content: "server body",
    contentText: "server body",
    updatedAt: "2026-07-20T01:00:00.000Z",
  });

  it("allows a newer server version when the visible note is still the untouched cache", () => {
    expect(canApplyRevalidatedNote({
      current: makeNote(),
      cached,
      remote,
      hasDraft: false,
      pendingNoteId: null,
    })).toBe(true);
  });

  it("blocks revalidation when a local draft or another switch exists", () => {
    expect(canApplyRevalidatedNote({ current: cached, cached, remote, hasDraft: true, pendingNoteId: null })).toBe(false);
    expect(canApplyRevalidatedNote({ current: cached, cached, remote, hasDraft: false, pendingNoteId: "note-2" })).toBe(false);
  });

  it("blocks revalidation after the visible content changed locally", () => {
    expect(canApplyRevalidatedNote({
      current: makeNote({ content: "local edit", contentText: "local edit" }),
      cached,
      remote,
      hasDraft: false,
      pendingNoteId: null,
    })).toBe(false);
  });

  it("ignores unchanged or older server versions", () => {
    expect(canApplyRevalidatedNote({
      current: cached,
      cached,
      remote: makeNote({ version: 3 }),
      hasDraft: false,
      pendingNoteId: null,
    })).toBe(false);
  });
});
