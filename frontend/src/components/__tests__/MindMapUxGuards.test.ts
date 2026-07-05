import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/components/MindMapEditor.tsx"), "utf8");
const typesSource = readFileSync(resolve(process.cwd(), "src/types/index.ts"), "utf8");

describe("MindMapEditor UX guardrails", () => {
  it("uses pointer capture and rAF for canvas pan interactions", () => {
    expect(source).toContain("setPointerCapture");
    expect(source).toContain("releasePointerCapture");
    expect(source).toContain("panFrameRef");
    expect(source).toContain("requestAnimationFrame");
  });

  it("keeps box selection and canonical selected node ids wired", () => {
    expect(source).toContain("selectionRect");
    expect(source).toContain("hitTestSelectionByDom");
    expect(source).toContain("setSelectedNodeIds(ids)");
    expect(source).toContain("e.ctrlKey || e.metaKey || e.shiftKey");
  });

  it("uses real DOM rectangles for box selection hit testing", () => {
    expect(source).toContain("data-mindmap-node-id");
    expect(source).toContain("getBoundingClientRect");
    expect(source).toContain("createClientSelectionRect(pointer.startX, pointer.startY, e.clientX, e.clientY)");
    expect(source).toContain("hitTestSelectionByDom(clientRect)");
  });

  it("deletes multi-selected non-root nodes through one guarded path", () => {
    expect(source).toContain("handleDeleteSelectedNodes");
    expect(source).toContain('.filter((id) => id !== "root")');
    expect(source).toContain("removeNodes(mapData.root, ids)");
  });

  it("moves selected nodes together through the drag/drop path", () => {
    expect(source).toContain("getMovableNodeIdsForDrag");
    expect(source).toContain("moveMindMapNodes(mapData.root, targetId, nodeIds)");
    expect(source).toContain("handleMoveNodes(dragNodeId, n.id)");
    expect(source).toContain("selectedNodeIds.length > 1 && selectedNodeIds.includes(dragNodeId)");
  });

  it("hides the single-node toolbar for multi-selection", () => {
    expect(source).toContain("selectedNodeIds.length > 1 ? null");
  });

  it("keeps floating toolbar pointer events out of canvas selection", () => {
    expect(source).toContain('data-mindmap-floating-toolbar="true"');
    expect(source).toContain('target.closest("[data-mindmap-floating-toolbar]")');
    expect(source).toContain("onPointerDown={(e) => e.stopPropagation()}");
    expect(source).toContain("onMouseDown={(e) => e.stopPropagation()}");
  });

  it("supports dragging selected mind map nodes to resize their width", () => {
    expect(typesSource).toContain("width?: number");
    expect(source).toContain("function clampNodeWidth");
    expect(source).toContain('data-mindmap-node-resize-handle="true"');
    expect(source).toContain('target.closest("[data-mindmap-node-resize-handle]")');
    expect(source).toContain("handleNodeResizeStart");
    expect(source).toContain("applyNodeWidth");
  });
});
