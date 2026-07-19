import { describe, expect, it } from "vitest";
import type { Notebook } from "@/types";
import {
  buildNotebookTree,
  compareNotebooks,
  getNotebookDropZone,
  getNotebookDragHint,
  notebookTreeContainsId,
  notebookTreeMapChanged,
  notebookTreeSetChanged,
  normalizeNotebookSortPref,
  reorderNotebooksForDrop,
} from "@/lib/notebookSort";

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
  isExpanded: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const orderedUnder = (notebooks: Notebook[], parentId: string | null) =>
  notebooks
    .filter((nb) => (nb.parentId ?? null) === parentId)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id))
    .map((nb) => `${nb.id}:${parentId ?? "root"}:${nb.sortOrder}`);

describe("buildNotebookTree", () => {
  it("keeps hierarchy while sorting siblings by name", () => {
    const tree = buildNotebookTree(
      [
        notebook("root-b", { name: "Beta", sortOrder: 0 }),
        notebook("child-z", { parentId: "root-a", name: "Zulu", sortOrder: 0 }),
        notebook("root-a", { name: "Alpha", sortOrder: 1 }),
        notebook("child-a", { parentId: "root-a", name: "Alpha child", sortOrder: 1 }),
      ],
      { by: "name", dir: "asc" },
    );

    expect(tree.map((nb) => nb.id)).toEqual(["root-a", "root-b"]);
    expect(tree[0].children?.map((nb) => nb.id)).toEqual(["child-a", "child-z"]);
  });

  it("sorts root notebooks and every child notebook level independently", () => {
    const tree = buildNotebookTree(
      [
        notebook("root-b", { name: "Beta" }),
        notebook("root-a", { name: "Alpha" }),
        notebook("child-z", { parentId: "root-a", name: "Zulu" }),
        notebook("child-a", { parentId: "root-a", name: "Alpha child" }),
        notebook("grand-b", { parentId: "child-a", name: "Bravo grandchild" }),
        notebook("grand-a", { parentId: "child-a", name: "Alpha grandchild" }),
      ],
      { by: "name", dir: "asc" },
    );

    expect(tree.map((nb) => nb.id)).toEqual(["root-a", "root-b"]);
    expect(tree[0].children?.map((nb) => nb.id)).toEqual(["child-a", "child-z"]);
    expect(tree[0].children?.[0].children?.map((nb) => nb.id)).toEqual(["grand-a", "grand-b"]);
  });

  it("allows each parent notebook to use its own child sort preference", () => {
    const tree = buildNotebookTree(
      [
        notebook("z-root", { name: "Beta", sortOrder: 0 }),
        notebook("a-root", { name: "Alpha", sortOrder: 1 }),
        notebook("z-older", { parentId: "a-root", name: "Alpha", updatedAt: "2026-01-01T00:00:00.000Z" }),
        notebook("a-newer", { parentId: "a-root", name: "Zulu", updatedAt: "2026-02-01T00:00:00.000Z" }),
        notebook("a-manual-last", { parentId: "z-root", name: "Alpha", sortOrder: 2 }),
        notebook("z-manual-first", { parentId: "z-root", name: "Zulu", sortOrder: 0 }),
      ],
      (parentId) => {
        if (parentId === null) return { by: "name", dir: "asc" };
        if (parentId === "a-root") return { by: "updatedAt", dir: "desc" };
        return { by: "manual", dir: "desc" };
      },
    );

    expect(tree.map((nb) => nb.id)).toEqual(["a-root", "z-root"]);
    expect(tree[0].children?.map((nb) => nb.id)).toEqual(["a-newer", "z-older"]);
    expect(tree[1].children?.map((nb) => nb.id)).toEqual(["z-manual-first", "a-manual-last"]);
  });

  it("uses manual sortOrder without changing source notebooks", () => {
    const source = [
      notebook("b", { sortOrder: 2 }),
      notebook("a", { sortOrder: 1 }),
    ];

    expect(buildNotebookTree(source, { by: "manual", dir: "desc" }).map((nb) => nb.id)).toEqual(["a", "b"]);
    expect(source[0].children).toBeUndefined();
  });
});

describe("notebook subtree memo boundaries", () => {
  const tree = buildNotebookTree([
    notebook("root"),
    notebook("child", { parentId: "root" }),
    notebook("grandchild", { parentId: "child" }),
  ])[0];

  it("finds editing and selection ids below the current memoized row", () => {
    expect(notebookTreeContainsId(tree, "grandchild")).toBe(true);
    expect(notebookTreeContainsId(tree, "other-root")).toBe(false);
  });

  it("detects a changed create operation in a descendant only", () => {
    const operation = { status: "pending" };
    for (const nextOperation of [
      { status: "confirmed" },
      { status: "failed" },
      { status: "pending", retry: 1 },
      undefined,
    ]) {
      expect(notebookTreeMapChanged(
        tree,
        new Map([["grandchild", operation]]),
        nextOperation ? new Map([["grandchild", nextOperation]]) : new Map(),
      )).toBe(true);
    }
    expect(notebookTreeMapChanged(
      tree,
      new Map([["other-root", operation]]),
      new Map([["other-root", { status: "confirmed" }]]),
    )).toBe(false);
  });

  it("detects descendant loading membership without invalidating unrelated branches", () => {
    expect(notebookTreeSetChanged(tree, new Set(), new Set(["child"]))).toBe(true);
    expect(notebookTreeSetChanged(tree, new Set(), new Set(["other-root"]))).toBe(false);
  });
});

describe("compareNotebooks", () => {
  it("sorts dates according to direction", () => {
    const older = notebook("older", { createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = notebook("newer", { createdAt: "2026-02-01T00:00:00.000Z" });

    expect(compareNotebooks(older, newer, { by: "createdAt", dir: "asc" })).toBeLessThan(0);
    expect(compareNotebooks(older, newer, { by: "createdAt", dir: "desc" })).toBeGreaterThan(0);
  });
});

describe("normalizeNotebookSortPref", () => {
  it("falls back to manual desc for invalid input", () => {
    expect(normalizeNotebookSortPref({ by: "bad", dir: "bad" })).toEqual({ by: "manual", dir: "desc" });
  });
});

describe("getNotebookDragHint", () => {
  it("explains when notebook drag sorting is locked", () => {
    expect(getNotebookDragHint(false)).toBe("切换到手动排序后可拖动调整顺序");
  });
});

describe("getNotebookDropZone", () => {
  const rect = { top: 100, height: 40 } as DOMRect;

  it("splits notebook rows into before inside and after zones", () => {
    expect(getNotebookDropZone(105, rect)).toBe("before");
    expect(getNotebookDropZone(120, rect)).toBe("inside");
    expect(getNotebookDropZone(135, rect)).toBe("after");
  });
});

describe("reorderNotebooksForDrop", () => {
  it("moves a root notebook before another root notebook", () => {
    const result = reorderNotebooksForDrop(
      [
        notebook("a", { sortOrder: 0 }),
        notebook("b", { sortOrder: 1 }),
        notebook("c", { sortOrder: 2 }),
      ],
      "c",
      "a",
      "before",
    );

    expect(orderedUnder(result?.nextNotebooks ?? [], null)).toEqual([
      "c:root:0",
      "a:root:1",
      "b:root:2",
    ]);
    expect(result?.movePayload).toEqual({ parentId: null, sortOrder: 0 });
    expect(result?.reorderItems).toEqual([
      { id: "c", sortOrder: 0 },
      { id: "a", sortOrder: 1 },
      { id: "b", sortOrder: 2 },
    ]);
  });

  it("moves a root notebook after another root notebook", () => {
    const result = reorderNotebooksForDrop(
      [
        notebook("a", { sortOrder: 0 }),
        notebook("b", { sortOrder: 1 }),
        notebook("c", { sortOrder: 2 }),
      ],
      "a",
      "b",
      "after",
    );

    expect(orderedUnder(result?.nextNotebooks ?? [], null)).toEqual([
      "b:root:0",
      "a:root:1",
      "c:root:2",
    ]);
    expect(result?.movePayload).toEqual({ parentId: null, sortOrder: 1 });
  });

  it("moves a child notebook before a sibling", () => {
    const result = reorderNotebooksForDrop(
      [
        notebook("root"),
        notebook("a1", { parentId: "root", sortOrder: 0 }),
        notebook("a2", { parentId: "root", sortOrder: 1 }),
      ],
      "a2",
      "a1",
      "before",
    );

    expect(orderedUnder(result?.nextNotebooks ?? [], "root")).toEqual([
      "a2:root:0",
      "a1:root:1",
    ]);
    expect(result?.movePayload).toEqual({ parentId: "root", sortOrder: 0 });
  });

  it("moves a child notebook after a sibling", () => {
    const result = reorderNotebooksForDrop(
      [
        notebook("root"),
        notebook("a1", { parentId: "root", sortOrder: 0 }),
        notebook("a2", { parentId: "root", sortOrder: 1 }),
        notebook("a3", { parentId: "root", sortOrder: 2 }),
      ],
      "a1",
      "a2",
      "after",
    );

    expect(orderedUnder(result?.nextNotebooks ?? [], "root")).toEqual([
      "a2:root:0",
      "a1:root:1",
      "a3:root:2",
    ]);
  });

  it("moves a root notebook inside another notebook as the last child", () => {
    const result = reorderNotebooksForDrop(
      [
        notebook("a", { sortOrder: 0 }),
        notebook("b", { sortOrder: 1 }),
        notebook("b1", { parentId: "b", sortOrder: 0 }),
      ],
      "a",
      "b",
      "inside",
    );

    expect(orderedUnder(result?.nextNotebooks ?? [], "b")).toEqual([
      "b1:b:0",
      "a:b:1",
    ]);
    expect(result?.movePayload).toEqual({ parentId: "b", sortOrder: 1 });
    expect(result?.expandedNotebookId).toBe("b");
  });

  it("moves a child notebook to root after a root notebook", () => {
    const result = reorderNotebooksForDrop(
      [
        notebook("a", { sortOrder: 0 }),
        notebook("a1", { parentId: "a", sortOrder: 0 }),
        notebook("b", { sortOrder: 1 }),
      ],
      "a1",
      "b",
      "after",
    );

    expect(orderedUnder(result?.nextNotebooks ?? [], null)).toEqual([
      "a:root:0",
      "b:root:1",
      "a1:root:2",
    ]);
    expect(result?.movePayload).toEqual({ parentId: null, sortOrder: 2 });
  });

  it("rejects dropping a notebook onto itself", () => {
    expect(reorderNotebooksForDrop([notebook("a")], "a", "a", "inside")).toBeNull();
  });

  it("rejects dropping a notebook onto its descendant", () => {
    expect(
      reorderNotebooksForDrop(
        [
          notebook("a"),
          notebook("a1", { parentId: "a" }),
        ],
        "a",
        "a1",
        "after",
      ),
    ).toBeNull();
  });
});
