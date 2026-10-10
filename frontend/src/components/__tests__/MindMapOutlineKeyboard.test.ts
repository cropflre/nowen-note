import { describe, expect, it } from "vitest";
import type { MindMapNode } from "@/types";
import { navigateMindMapNode, promoteMindMapNode } from "../MindMapEditor";

function makeTree(): MindMapNode {
  return {
    id: "root", text: "Root", children: [
      { id: "A", text: "A", children: [
        { id: "A1", text: "A1", children: [
          { id: "A1a", text: "A1a", children: [] },
        ] },
        { id: "A2", text: "A2", children: [] },
      ] },
      { id: "B", text: "B", children: [] },
    ],
  };
}

describe("mind map outline keyboard operations", () => {
  it("promotes a nested node immediately after its parent without losing its children", () => {
    const root = makeTree();
    const promoted = promoteMindMapNode(root, "A1");

    expect(promoted.children.map((node) => node.id)).toEqual(["A", "A1", "B"]);
    expect(promoted.children[0].children.map((node) => node.id)).toEqual(["A2"]);
    expect(promoted.children[1].children.map((node) => node.id)).toEqual(["A1a"]);
    expect(root.children[0].children.map((node) => node.id)).toEqual(["A1", "A2"]);
  });

  it("does not promote the root, a direct root child, or a missing node", () => {
    const root = makeTree();
    expect(promoteMindMapNode(root, "root")).toBe(root);
    expect(promoteMindMapNode(root, "A")).toBe(root);
    expect(promoteMindMapNode(root, "missing")).toBe(root);
  });

  it("promotes a deeper node by one level rather than moving it to the root", () => {
    const promoted = promoteMindMapNode(makeTree(), "A1a");
    expect(promoted.children.map((node) => node.id)).toEqual(["A", "B"]);
    expect(promoted.children[0].children.map((node) => node.id)).toEqual(["A1", "A1a", "A2"]);
  });

  it("navigates the visible tree in outline order", () => {
    const root = makeTree();
    expect(navigateMindMapNode(root, "A", "ArrowRight")).toBe("A1");
    expect(navigateMindMapNode(root, "A1", "ArrowLeft")).toBe("A");
    expect(navigateMindMapNode(root, "A1", "ArrowDown")).toBe("A1a");
    expect(navigateMindMapNode(root, "B", "ArrowUp")).toBe("A2");
    expect(navigateMindMapNode(root, "root", "ArrowUp")).toBeNull();
  });

  it("skips descendants of collapsed nodes and rejects hidden selections", () => {
    const root = makeTree();
    root.children[0].collapsed = true;
    expect(navigateMindMapNode(root, "A", "ArrowDown")).toBe("B");
    expect(navigateMindMapNode(root, "A", "ArrowRight")).toBeNull();
    expect(navigateMindMapNode(root, "A1", "ArrowDown")).toBeNull();
  });
});
