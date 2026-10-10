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
    expect(source).toContain("moveMindMapNodes(mapData.root, targetId, nodeIds, placement)");
    expect(source).toContain("handleMoveNodes(dragNodeId, n.id, placement)");
    expect(source).toContain("const targetIsSelected =");
    expect(source).toContain("selectedNodeIds.includes(dragNodeId)");
    expect(source).toContain("selectedNodeIds.includes(n.id)");
  });

  it("supports long-press structural dragging on touch devices", () => {
    expect(source).toContain("touchDragRef");
    expect(source).toContain("}, 320);");
    expect(source).toContain("document.elementFromPoint");
    expect(source).toContain('data-mindmap-node-depth={node.depth}');
    expect(source).toContain("beginTouchNodeDrag");
    expect(source).toContain("moveTouchNodeDrag");
    expect(source).toContain("endTouchNodeDrag");
    expect(source).toContain('touchAction: isMobile ? "none" : undefined');
  });

  it("keeps desktop dragging out of edit mode and clears transient drag state", () => {
    expect(source).toContain("draggable={!!onDragStart && !isEditing}");
    expect(source).toContain("onDragEnd={() => {");
    expect(source).toContain("setDragNodeId(null)");
    expect(source).toContain("setDropTarget(null)");
  });

  it("surfaces normal mind map autosave failures instead of silently logging them", () => {
    expect(source).toContain('toast.error(error.message || "思维导图保存失败")');
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

  it("keeps collapse controls out of canvas pointer handling", () => {
    const collapseControl = source.slice(
      source.indexOf("{/* 折叠/展开按钮 */}"),
      source.indexOf("/* ===== 列表项组件 ===== */"),
    );

    expect(collapseControl).toContain("onPointerDown={(e) => e.stopPropagation()}");
  });

  it("shows the hidden descendant count on collapsed nodes", () => {
    const collapseControl = source.slice(
      source.indexOf("{/* 折叠/展开按钮 */}"),
      source.indexOf("/* ===== 列表项组件 ===== */"),
    );

    expect(source).toContain("countMindMapDescendants(nodeData)");
    expect(collapseControl).toContain("+{collapsedDescendantCount}");
  });

  it("supports dragging selected mind map nodes to resize their width", () => {
    expect(typesSource).toContain("width?: number");
    expect(source).toContain("function clampNodeWidth");
    expect(source).toContain('data-mindmap-node-resize-handle="true"');
    expect(source).toContain('target.closest("[data-mindmap-node-resize-handle]")');
    expect(source).toContain("handleNodeResizeStart");
    expect(source).toContain("applyNodeWidth");
  });
  it("clears stale mind map content when switching routes or workspaces", () => {
    expect(source).toContain("const mapLoadRequestRef = useRef(0)");
    expect(source).toContain("const clearActiveMap = useCallback");
    expect(source).toContain("const requestId = ++mapLoadRequestRef.current");
    expect(source).toContain("if (requestId !== mapLoadRequestRef.current) return");
    expect(source).toContain("setActiveMap((current) => current?.id === updated.id ? updated : current)");

    expect(source).toContain("if (activeMapRef.current) clearActiveMap();");
    expect(source).toContain('window.addEventListener("nowen:workspace-changed", onWs)');
    expect(source).toContain("if (activeMap && current && !current.some((map) => map.id === activeMap.id)) clearActiveMap();");
  });

});
