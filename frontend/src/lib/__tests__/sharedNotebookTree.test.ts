import { describe, expect, it } from "vitest";
import type { Notebook } from "@/types";
import {
  buildSharedNotebookTree,
  canEditSharedNotebook,
  type SharedNotebook,
} from "@/components/SharedNotebookTree";

const notebook = (id: string, overrides: Partial<SharedNotebook> = {}): SharedNotebook => ({
  id,
  userId: "owner",
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
  sharedRootId: "root",
  myRole: "viewer",
  permission: "read",
  ...overrides,
}) as Notebook & SharedNotebook;

describe("shared notebook tree", () => {
  it("rebuilds nested shared descendants and sorts every level", () => {
    const tree = buildSharedNotebookTree([
      notebook("child-b", { parentId: "root", sortOrder: 2 }),
      notebook("grandchild", { parentId: "child-a" }),
      notebook("root", { sharedRootId: "root", sortOrder: 3 }),
      notebook("child-a", { parentId: "root", sortOrder: 1 }),
      notebook("second-root", { sharedRootId: "second-root", sortOrder: 1 }),
    ]);

    expect(tree.map((item) => item.id)).toEqual(["second-root", "root"]);
    expect(tree[1].children.map((item) => item.id)).toEqual(["child-a", "child-b"]);
    expect(tree[1].children[0].children.map((item) => item.id)).toEqual(["grandchild"]);
  });

  it("does not mutate the API response objects", () => {
    const source = [notebook("root"), notebook("child", { parentId: "root" })];
    buildSharedNotebookTree(source);
    expect(source[0].children).toBeUndefined();
  });

  it("only exposes creation controls for effective write permissions", () => {
    expect(canEditSharedNotebook(notebook("viewer"))).toBe(false);
    expect(canEditSharedNotebook(notebook("editor", { myRole: "editor", permission: "write" }))).toBe(true);
    expect(canEditSharedNotebook(notebook("manager", { permission: "manage" }))).toBe(true);
  });
});
