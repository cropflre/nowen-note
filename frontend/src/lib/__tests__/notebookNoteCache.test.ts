import { describe, expect, it } from "vitest";
import {
  addNoteToNotebookCache,
  directNotebookNotes,
  moveNoteInNotebookCache,
  upsertNoteInNotebookCache,
} from "@/lib/notebookNoteCache";
import type { NoteListItem } from "@/types";

const note = (id: string, notebookId: string): NoteListItem => ({
  id,
  userId: "u1",
  notebookId,
  workspaceId: null,
  title: id,
  contentText: "",
  isPinned: 0,
  isFavorite: 0,
  isLocked: 0,
  isArchived: 0,
  isTrashed: 0,
  version: 1,
  createdAt: "2026-06-03T00:00:00Z",
  updatedAt: "2026-06-03T00:00:00Z",
});

describe("notebook note cache", () => {
  it("keeps sidebar notebook rows direct-only", () => {
    expect(directNotebookNotes([note("a", "root"), note("b", "child")], "root")).toEqual([
      note("a", "root"),
    ]);
  });

  it("moves a note by removing stale copies from every cached notebook", () => {
    const moved = note("n1", "target");
    const cache = new Map<string, NoteListItem[]>([
      ["source", [note("n1", "source"), note("n2", "source")]],
      ["ancestor", [note("n1", "source"), note("n3", "child")]],
      ["target", [note("n4", "target")]],
    ]);

    const next = moveNoteInNotebookCache(cache, "n1", "target", moved);

    expect(next.get("source")?.map((n) => n.id)).toEqual(["n2"]);
    expect(next.get("ancestor")?.map((n) => n.id)).toEqual(["n3"]);
    expect(next.get("target")?.map((n) => n.id)).toEqual(["n1", "n4"]);
  });

  it("adds a newly created note to the target notebook cache immediately", () => {
    const created = note("n1", "target");
    const next = addNoteToNotebookCache(new Map(), "target", created);

    expect(next.get("target")).toEqual([created]);
  });

  it("dedupes when adding a newly created note to an existing cache", () => {
    const created = note("n1", "target");
    const cache = new Map<string, NoteListItem[]>([
      ["target", [created, note("n2", "target")]],
    ]);

    const next = addNoteToNotebookCache(cache, "target", created);

    expect(next.get("target")?.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("updates an existing active note without changing notebook order", () => {
    const updated = { ...note("n2", "target"), title: "updated" };
    const cache = new Map<string, NoteListItem[]>([
      ["target", [note("n1", "target"), note("n2", "target"), note("n3", "target")]],
    ]);

    const next = upsertNoteInNotebookCache(cache, "target", updated);

    expect(next.get("target")?.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(next.get("target")?.[1].title).toBe("updated");
  });
});
