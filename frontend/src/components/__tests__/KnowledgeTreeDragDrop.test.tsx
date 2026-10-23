import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KnowledgeTreePanel from "../KnowledgeTreePanel";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({
  list: vi.fn(), move: vi.fn(), reorder: vi.fn(), success: vi.fn(), error: vi.fn(),
  actions: { refreshNotebooks: vi.fn(), refreshNotes: vi.fn() },
}));
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: { viewMode: "all", searchQuery: "", selectedNotebookId: null, activeNote: null, notebooks: [] } }),
  useAppActions: () => mock.actions,
}));
vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: {
  list: mock.list, listShared: async () => ({ nodes: [] }), move: mock.move, reorder: mock.reorder,
} }));
vi.mock("@/lib/toast", () => ({ toast: { success: mock.success, error: mock.error } }));
vi.mock("@/components/KnowledgeTreeNodeMenu", () => ({ default: () => null }));
vi.mock("@/components/KnowledgeTreePermissionsDialog", () => ({ default: () => null }));
vi.mock("@/components/NoteTemplatePickerDialog", () => ({ default: () => null }));
vi.mock("@/components/FolderPasswordDialog", () => ({ default: () => null }));
vi.mock("@/components/attachmentDetail/AttachmentDetailDrawer", () => ({ default: () => null }));

function node(id: string, parentId: string | null, sortOrder = 0, folder = false): KnowledgeTreeNode {
  return {
    id, parentId, title: id, sortOrder, userId: "owner", workspaceId: null, scopeKey: "personal:owner",
    nodeType: folder ? "folder" : "note", resourceType: folder ? "notebook" : "note", resourceId: id,
    isDeleted: 0, isExpanded: 1, childCount: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    access: { nodeId: id, rolePreset: "admin", source: "owner", sourceNodeId: id,
      capabilities: { canView: true, canCreate: true, canEdit: true, canComment: true, canMove: true,
        canDelete: true, canDownload: true, canReshare: true, canManageMembers: true } },
  };
}

describe("knowledge tree native drag and drop", () => {
  let root: Root;
  let host: HTMLDivElement;
  let nodes: KnowledgeTreeNode[];

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    nodes = [node("root", null, 0, true), node("sub", "root", 0, true), node("destination", null, 1, true),
      node("level2-a", "root", 1), node("level2-b", "root", 2),
      node("level3-a", "sub", 0), node("level3-b", "sub", 1)];
    mock.list.mockImplementation(async () => ({ nodes: nodes.map((item) => ({ ...item })) }));
    mock.move.mockImplementation(async (id, { parentId }) => {
      nodes = nodes.map((item) => item.id === id ? { ...item, parentId } : item);
    });
    mock.reorder.mockImplementation(async (items: Array<{ id: string; sortOrder: number }>) => {
      nodes = nodes.map((item) => ({ ...item, sortOrder: items.find((entry) => entry.id === item.id)?.sortOrder ?? item.sortOrder }));
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const row = (id: string) => host.querySelector<HTMLElement>(`[data-knowledge-tree-node-id="${id}"]`)!;

  async function drag(sourceId: string, targetId: string | null, clientY: number, expectedEffect = "move") {
    const data = new Map<string, string>();
    const dataTransfer = { types: ["application/x-nowen-tree-node"], effectAllowed: "", dropEffect: "",
      setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) || "" };
    const dispatch = async (element: HTMLElement, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer, clientY });
      await act(async () => { element.dispatchEvent(event); });
    };
    const source = row(sourceId);
    expect(source.draggable).toBe(true);
    await dispatch(source, "dragstart");
    expect(row(sourceId)).toBe(source);
    const target = targetId ? row(targetId) : host.querySelector<HTMLElement>("[data-knowledge-tree-root-drop]")!;
    target.getBoundingClientRect = () => new DOMRect(0, 100, 250, 40);
    await dispatch(target, "dragover");
    expect(dataTransfer.dropEffect).toBe(expectedEffect);
    await dispatch(target, "drop");
  }

  it.each([2, 3])("reorders level %i notes and retains their parent after reload", async (level) => {
    await act(async () => root.render(<KnowledgeTreePanel />));
    await drag(`level${level}-b`, `level${level}-a`, 104);
    expect(mock.reorder).toHaveBeenCalledOnce();
    expect(mock.move).not.toHaveBeenCalled();
    const notes = Array.from(host.querySelectorAll<HTMLElement>("[data-knowledge-tree-node-id]"))
      .map((element) => element.dataset.knowledgeTreeNodeId).filter((id) => id?.startsWith(`level${level}`));
    expect(notes).toEqual([`level${level}-b`, `level${level}-a`]);
    expect(nodes.find((item) => item.id === `level${level}-b`)?.parentId).toBe(level === 2 ? "root" : "sub");
  });

  it.each([2, 3])("moves a level %i note into another root folder", async (level) => {
    await act(async () => root.render(<KnowledgeTreePanel />));
    await drag(`level${level}-a`, "destination", 120);
    expect(mock.move).toHaveBeenCalledWith(`level${level}-a`, { parentId: "destination" });
    expect(mock.reorder).not.toHaveBeenCalled();
    expect(nodes.find((item) => item.id === `level${level}-a`)?.parentId).toBe("destination");
  });

  it("moves a nested note to root through the floating target", async () => {
    await act(async () => root.render(<KnowledgeTreePanel />));
    await drag("level3-a", null, 120);
    expect(mock.move).toHaveBeenCalledWith("level3-a", { parentId: null });
    expect(host.querySelector("[data-knowledge-tree-root-drop]")).toBeNull();
  });

  it("rejects a target without move or create permission", async () => {
    const target = nodes.find((item) => item.id === "destination")!;
    target.access.capabilities.canMove = false;
    target.access.capabilities.canCreate = false;
    await act(async () => root.render(<KnowledgeTreePanel />));
    await drag("level3-a", "destination", 120, "none");
    expect(mock.move).not.toHaveBeenCalled();
    expect(mock.reorder).not.toHaveBeenCalled();
  });

  it("rejects moving a folder into its descendant", async () => {
    await act(async () => root.render(<KnowledgeTreePanel />));
    await drag("root", "sub", 120, "none");
    expect(mock.move).not.toHaveBeenCalled();
    expect(mock.reorder).not.toHaveBeenCalled();
  });

  it("restores the persisted sibling order when reorder fails", async () => {
    mock.reorder.mockRejectedValueOnce(new Error("保存失败"));
    await act(async () => root.render(<KnowledgeTreePanel />));
    await drag("level3-b", "level3-a", 104);
    expect(mock.error).toHaveBeenCalledWith("保存失败");
    expect(mock.success).not.toHaveBeenCalled();
    const ids = Array.from(host.querySelectorAll<HTMLElement>("[data-knowledge-tree-node-id]"))
      .map((element) => element.dataset.knowledgeTreeNodeId).filter((id) => id?.startsWith("level3"));
    expect(ids).toEqual(["level3-a", "level3-b"]);
  });
});
