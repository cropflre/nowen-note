import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KnowledgeTreePanel from "../KnowledgeTreePanel";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({
  list: vi.fn(), move: vi.fn(), batchMove: vi.fn(), reorder: vi.fn(), success: vi.fn(), error: vi.fn(),
  actions: { refreshNotebooks: vi.fn(), refreshNotes: vi.fn() },
  onMove: null as ((node: KnowledgeTreeNode) => void) | null,
}));
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: { viewMode: "all", searchQuery: "", selectedNotebookId: null, activeNote: null, notebooks: [] } }),
  useAppActions: () => mock.actions,
}));
vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: {
  list: mock.list, listShared: async () => ({ nodes: [] }), move: mock.move, batchMove: mock.batchMove, reorder: mock.reorder,
} }));
vi.mock("@/lib/toast", () => ({ toast: { success: mock.success, error: mock.error } }));
vi.mock("@/components/KnowledgeTreeNodeMenu", () => ({
  default: (props: { onMove?: (node: KnowledgeTreeNode) => void }) => {
    mock.onMove = props.onMove ?? null;
    return null;
  },
}));
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
    mock.batchMove.mockImplementation(async (ids: string[], { parentId }) => {
      nodes = nodes.map((item) => ids.includes(item.id) ? { ...item, parentId } : item);
      return { nodeIds: ids };
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

  it("moves multiple Ctrl-selected notes into a folder in one drag operation", async () => {
    await act(async () => root.render(<KnowledgeTreePanel />));
    const buttonOf = (id: string) => row(id).querySelectorAll("button")[1] as HTMLButtonElement;
    await act(async () => {
      buttonOf("level2-a").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    await act(async () => {
      buttonOf("level2-b").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    await drag("level2-a", "destination", 104);
    expect(mock.batchMove).toHaveBeenCalledWith(["level2-a", "level2-b"], { parentId: "destination" });
    expect(mock.move).not.toHaveBeenCalled();
  });

  it("allows dragging a filtered document directly into a folder while searching", async () => {
    nodes = [
      node("a02", null, 0, true),
      { ...node("folder-2083", "a02", 0, true), title: "驰铭-13012510_CM-2083W-MainDrv-V1.0" },
      { ...node("doc-2083", "a02", 1, false), title: "驰铭-13012083_CM-2055W-PL LED1" },
    ];
    await act(async () => root.render(<KnowledgeTreePanel />));
    const searchInput = host.querySelector<HTMLInputElement>("input[type='text'], input:not([type])")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(searchInput, "2083");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Even dropping near the top edge (104) while searching moves into the target folder instead of rejecting/reordering.
    await drag("doc-2083", "folder-2083", 104);
    expect(mock.move).toHaveBeenCalledWith("doc-2083", { parentId: "folder-2083" });
    expect(mock.reorder).not.toHaveBeenCalled();
  });

  it("sorts MovePanel with folders first, reacts to sort mode changes, supports search and shrink-0 icons", async () => {
    nodes = [
      { ...node("root-a", null, 0, true), title: "A01-包工包料", createdAt: "2025-01-01T00:00:00.000Z" },
      { ...node("root-b", null, 1, true), title: "A02-来料加工", createdAt: "2025-01-02T00:00:00.000Z" },
      { ...node("old-doc", "root-b", 0, false), title: "我司-201A00333_YD-5005X-V3-2835-超长标题测试", createdAt: "2025-03-01T00:00:00.000Z" },
      { ...node("new-folder", "root-b", 1, true), title: "驰铭-13010219_CM5015C-新建文件夹", createdAt: "2026-11-24T00:00:00.000Z" },
      { ...node("moving-doc", "root-b", 2, false), title: "待移动文档", createdAt: "2026-11-20T00:00:00.000Z" },
    ];
    await act(async () => root.render(<KnowledgeTreePanel />));
    await act(async () => {
      mock.onMove?.(nodes.find((item) => item.id === "moving-doc")!);
    });

    const movePanel = () => host.querySelector<HTMLElement>("[data-knowledge-tree-move-panel]")!;
    const candidateButtons = () => Array.from(movePanel().querySelectorAll<HTMLButtonElement>("button[title]"))
      .filter((btn) => btn.querySelector("[data-knowledge-tree-icon]"));

    // Manual mode: root folders first, newly created subfolder next, documents last.
    expect(candidateButtons().map((btn) => btn.textContent)).toEqual([
      "A01-包工包料",
      "A02-来料加工",
      "驰铭-13010219_CM5015C-新建文件夹A02-来料加工",
      "我司-201A00333_YD-5005X-V3-2835-超长标题测试A02-来料加工",
    ]);

    // Every candidate icon has shrink-0 so long titles never crush the icon.
    for (const btn of candidateButtons()) {
      const icon = btn.querySelector("[data-knowledge-tree-icon]");
      expect(icon?.getAttribute("class")).toContain("shrink-0");
    }

    // Switching sort mode immediately reorders MovePanel candidates.
    const { saveKnowledgeTreeSortMode } = await import("@/lib/knowledgeTreeSort");
    await act(async () => {
      saveKnowledgeTreeSortMode("title-desc");
    });
    expect(candidateButtons()[0].textContent).toContain("驰铭-13010219_CM5015C-新建文件夹");

    // Folders-only toggle filters out documents.
    const foldersOnlyBtn = Array.from(movePanel().querySelectorAll("button")).find((btn) => btn.textContent?.includes("仅文件夹"))!;
    await act(async () => {
      foldersOnlyBtn.click();
    });
    expect(candidateButtons().every((btn) => !btn.textContent?.includes("我司-201A00333"))).toBe(true);

    // Search box filters candidates by keyword.
    const moveSearch = movePanel().querySelector<HTMLInputElement>('input[aria-label="搜索移动目标"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(moveSearch, "5015C");
      moveSearch.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(candidateButtons().map((btn) => btn.textContent)).toEqual([
      "驰铭-13010219_CM5015C-新建文件夹A02-来料加工",
    ]);
  });
});
