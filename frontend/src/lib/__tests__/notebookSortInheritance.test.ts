import { describe, expect, it } from "vitest";
import type { NoteListItem, Notebook } from "@/types";
import {
  buildNotebookTree,
  DEFAULT_NOTEBOOK_SORT_PREF,
  type NotebookSortPref,
} from "@/lib/notebookSort";
import { sortNotebookNotes } from "@/lib/notebookNoteCache";

const notebook = (id: string, overrides: Partial<Notebook> = {}): Notebook => ({
  id,
  userId: "user-1",
  workspaceId: null,
  parentId: null,
  name: id,
  description: null,
  icon: "📒",
  color: null,
  sortOrder: 0,
  isExpanded: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const note = (id: string, title: string): NoteListItem => ({
  id,
  userId: "user-1",
  workspaceId: null,
  notebookId: "child-a",
  title,
  contentText: "",
  isPinned: 0,
  isFavorite: 0,
  isLocked: 0,
  isArchived: 0,
  isTrashed: 0,
  version: 1,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function inheritedResolver(
  rootPref: NotebookSortPref,
  overrides: Record<string, NotebookSortPref> = {},
) {
  return (parentId: string | null): NotebookSortPref => {
    if (parentId === null) return rootPref;
    return overrides[parentId] ?? DEFAULT_NOTEBOOK_SORT_PREF;
  };
}

describe("notebook sort inheritance", () => {
  it("applies the root rule to child and grandchild notebook levels", () => {
    const tree = buildNotebookTree(
      [
        notebook("root-z", { name: "Zulu" }),
        notebook("root-a", { name: "Alpha" }),
        notebook("child-z", { parentId: "root-a", name: "Zulu child" }),
        notebook("child-a", { parentId: "root-a", name: "Alpha child" }),
        notebook("grand-z", { parentId: "child-a", name: "Zulu grandchild" }),
        notebook("grand-a", { parentId: "child-a", name: "Alpha grandchild" }),
      ],
      inheritedResolver({ by: "name", dir: "asc" }),
    );

    expect(tree.map((item) => item.id)).toEqual(["root-a", "root-z"]);
    expect(tree[0].children?.map((item) => item.id)).toEqual(["child-a", "child-z"]);
    expect(tree[0].children?.[0].children?.map((item) => item.id)).toEqual(["grand-a", "grand-z"]);
  });

  it("applies the inherited root rule to notes inside a nested notebook", () => {
    buildNotebookTree(
      [notebook("root"), notebook("child-a", { parentId: "root" })],
      inheritedResolver({ by: "name", dir: "asc" }),
    );

    const sorted = sortNotebookNotes(
      [note("z", "Zulu note"), note("a", "Alpha note")],
      DEFAULT_NOTEBOOK_SORT_PREF,
    );

    expect(sorted.map((item) => item.id)).toEqual(["a", "z"]);
  });

  it("keeps an explicit child manual override instead of inheriting the root rule", () => {
    const explicitManual: NotebookSortPref = { by: "manual", dir: "desc" };
    const tree = buildNotebookTree(
      [
        notebook("root"),
        notebook("child-z", { parentId: "root", name: "Zulu", sortOrder: 0 }),
        notebook("child-a", { parentId: "root", name: "Alpha", sortOrder: 1 }),
      ],
      inheritedResolver({ by: "name", dir: "asc" }, { root: explicitManual }),
    );

    expect(tree[0].children?.map((item) => item.id)).toEqual(["child-z", "child-a"]);
    expect(
      sortNotebookNotes(
        [note("z", "Zulu note"), note("a", "Alpha note")],
        explicitManual,
      ).map((item) => item.id),
    ).toEqual(["z", "a"]);
  });
});
