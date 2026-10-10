import { describe, expect, it } from "vitest";
import type { MindMapNode } from "@/types";
import {
  getMovableNodeIdsForDrag,
  hasSelectedAncestor,
  isNodeDescendant,
  moveMindMapNodes,
  resolveMindMapDropPlacement,
} from "../MindMapEditor";

function makeTree(): MindMapNode {
  return {
    id: "root",
    text: "Root",
    children: [
      {
        id: "A",
        text: "A",
        children: [{ id: "A1", text: "A1", children: [] }],
      },
      { id: "B", text: "B", children: [] },
      { id: "C", text: "C", children: [] },
    ],
  };
}

function findNode(root: MindMapNode, id: string): MindMapNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

describe("mind map node drag moves", () => {
  it("moves a single node under the target", () => {
    const root = makeTree();
    const movable = getMovableNodeIdsForDrag(root, "A", "B", []);
    const moved = moveMindMapNodes(root, "B", movable.nodeIds);

    expect(movable).toEqual({ nodeIds: ["A"] });
    expect(moved.children.map((node) => node.id)).toEqual(["B", "C"]);
    expect(findNode(moved, "B")?.children.map((node) => node.id)).toEqual(["A"]);
  });

  it("reorders a node before or after a sibling without changing hierarchy", () => {
    const root = makeTree();

    const before = moveMindMapNodes(root, "B", ["C"], "before");
    expect(before.children.map((node) => node.id)).toEqual(["A", "C", "B"]);
    expect(findNode(before, "C")?.children).toEqual([]);

    const after = moveMindMapNodes(root, "B", ["A"], "after");
    expect(after.children.map((node) => node.id)).toEqual(["B", "A", "C"]);
    expect(findNode(after, "A")?.children.map((node) => node.id)).toEqual(["A1"]);
  });

  it("moves nodes across parents and inserts them next to the target sibling", () => {
    const root = makeTree();
    const moved = moveMindMapNodes(root, "A1", ["C"], "after");

    expect(moved.children.map((node) => node.id)).toEqual(["A", "B"]);
    expect(findNode(moved, "A")?.children.map((node) => node.id)).toEqual(["A1", "C"]);
  });

  it("splits a node surface into before, inside and after drag zones", () => {
    expect(resolveMindMapDropPlacement(102, 100, 40)).toBe("before");
    expect(resolveMindMapDropPlacement(120, 100, 40)).toBe("inside");
    expect(resolveMindMapDropPlacement(138, 100, 40)).toBe("after");
    expect(resolveMindMapDropPlacement(100, 100, 0)).toBe("inside");
  });

  it("moves selected nodes together in tree order", () => {
    const root = makeTree();
    const movable = getMovableNodeIdsForDrag(root, "A", "B", ["C", "A"]);
    const moved = moveMindMapNodes(root, "B", movable.nodeIds);

    expect(movable).toEqual({ nodeIds: ["A", "C"] });
    expect(moved.children.map((node) => node.id)).toEqual(["B"]);
    expect(findNode(moved, "B")?.children.map((node) => node.id)).toEqual(["A", "C"]);
  });

  it("filters root out of selected drag moves", () => {
    const root = makeTree();
    const movable = getMovableNodeIdsForDrag(root, "A", "B", ["root", "A"]);

    expect(movable).toEqual({ nodeIds: ["A"] });
  });

  it("rejects dropping a selected group onto a selected target", () => {
    const root = makeTree();
    const movable = getMovableNodeIdsForDrag(root, "A", "B", ["A", "B"]);

    expect(movable).toEqual({ nodeIds: [], reason: "target-selected" });
  });

  it("rejects moving a node under its descendant", () => {
    const root = makeTree();
    const movable = getMovableNodeIdsForDrag(root, "A", "A1", []);

    expect(isNodeDescendant(root, "A", "A1")).toBe(true);
    expect(movable).toEqual({ nodeIds: [], reason: "descendant" });
  });

  it("moves only the top-level selected node when parent and child are both selected", () => {
    const root = makeTree();
    const selected = new Set(["A", "A1"]);
    const movable = getMovableNodeIdsForDrag(root, "A", "B", ["A", "A1"]);
    const moved = moveMindMapNodes(root, "B", movable.nodeIds);

    expect(hasSelectedAncestor(root, "A1", selected)).toBe(true);
    expect(movable).toEqual({ nodeIds: ["A"] });
    expect(findNode(moved, "B")?.children.map((node) => node.id)).toEqual(["A"]);
    expect(findNode(moved, "A")?.children.map((node) => node.id)).toEqual(["A1"]);
  });

  it("keeps the tree unchanged when the drop target is missing", () => {
    const root = makeTree();

    expect(moveMindMapNodes(root, "missing", ["A"])).toBe(root);
  });
});
