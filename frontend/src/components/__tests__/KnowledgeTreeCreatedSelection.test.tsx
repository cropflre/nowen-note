import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TreePanel from "../KnowledgeTreePanel";
import QuickPanel from "../MobileKnowledgeTreePanel";
import { saveKnowledgeTreeDisplaySize } from "@/hooks/useKnowledgeTreeDisplaySize";
import { KNOWLEDGE_TREE_CLEAR_SEARCH_EVENT, revealCreatedKnowledgeTreeNote, revealKnowledgeTreeNote } from "@/lib/knowledgeTreeCreateVisibility";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { getKnowledgeTreeExpansionScope, getKnowledgeTreeExpansionSnapshot, saveKnowledgeTreeExpansion } from "@/lib/knowledgeTreeExpansion";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};

const mock = vi.hoisted(() => ({
  list: vi.fn(),
  createTemplate: vi.fn(),
  getNote: vi.fn(),
  update: vi.fn(),
  actions: { setSearchQuery: vi.fn(), setViewMode: vi.fn(), clearSelectedTags: vi.fn(), setActiveNote: vi.fn(),
    setSelectedNotebook: vi.fn(), setSelectedKnowledgeTreeParent: vi.fn(), openNoteTab: vi.fn(),
    setMobileView: vi.fn(), setMobileSidebar: vi.fn(), refreshNotebooks: vi.fn(), refreshNotes: vi.fn() },
  state: { viewMode: "all", searchQuery: "", selectedNotebookId: null, activeNote: null, notebooks: [], noteListCollapsed: false },
}));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: mock.state }), useAppActions: () => mock.actions }));
vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: { list: mock.list, listShared: async () => ({ nodes: [] }), update: mock.update } }));
vi.mock("@/lib/noteTemplatesApi", () => ({ noteTemplatesApi: { createNote: mock.createTemplate } }));
vi.mock("@/lib/api", () => ({ api: { getNote: mock.getNote }, getCurrentWorkspace: () => "personal", getBaseUrl: () => "/api", getServerUrl: () => "" }));
vi.mock("@/components/KnowledgeTreeCreateMenuRuntime", () => ({ KnowledgeTreeCreateDropdown: () => null }));
vi.mock("@/components/KnowledgeTreeNodeMenu", () => ({ default: () => null }));
vi.mock("@/components/KnowledgeTreePermissionsDialog", () => ({ default: () => null }));
vi.mock("@/components/NoteTemplatePickerDialog", () => ({ default: () => null }));
vi.mock("@/components/FolderPasswordDialog", () => ({ default: () => null }));
vi.mock("@/components/attachmentDetail/AttachmentDetailDrawer", () => ({ default: () => null }));

function node(id: string, parentId: string | null, title: string): KnowledgeTreeNode {
  return {
    id, parentId, title, userId: "owner", workspaceId: null, scopeKey: "personal:owner",
    nodeType: "markdown", resourceType: "note", resourceId: id, sortOrder: 0,
    isDeleted: 0, isExpanded: 0, childCount: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    access: { nodeId: id, rolePreset: "editor", source: "inherited", sourceNodeId: null,
      capabilities: { canView: true, canCreate: true, canEdit: true, canComment: true, canMove: false, canDelete: false, canDownload: true, canReshare: false, canManageMembers: false } },
  };
}

describe("created knowledge tree note selection", () => {
  let root: Root;
  let host: HTMLDivElement;
  let scrolledIds: string[];

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mock.update.mockResolvedValue({ success: true });
    scrolledIds = [];
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolledIds.push(this.dataset.knowledgeTreeSelectId || "");
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["tree", "desktop quick", "mobile quick"])("%s responds to display size changes without changing selection", async (surface) => {
    mock.list.mockResolvedValue({ nodes: [node("source", null, "目录文档")] });
    await act(async () => root.render(surface === "tree" ? <TreePanel /> : <QuickPanel variant={surface === "mobile quick" ? "mobile" : "desktop"} />));
    const panel = host.querySelector("[data-knowledge-tree-size]")!;
    expect(panel.getAttribute("data-knowledge-tree-size")).toBe("default");
    expect(panel.querySelector("[data-knowledge-tree-title]")?.textContent).toBe("目录文档");
    expect(panel.querySelector("[data-knowledge-tree-icon]")).not.toBeNull();
    const row = panel.querySelector('[data-knowledge-tree-select-id="source"]')!;
    const selected = row.getAttribute("aria-selected");
    await act(async () => saveKnowledgeTreeDisplaySize("extra-large"));
    expect(panel.getAttribute("data-knowledge-tree-size")).toBe("extra-large");
    expect(row.getAttribute("aria-selected")).toBe(selected);
    await act(async () => saveKnowledgeTreeDisplaySize("default"));
    expect(panel.getAttribute("data-knowledge-tree-size")).toBe("default");
  });

  it.each(["tree", "desktop quick", "mobile quick"])("%s clears the local tree filter when opening all notes", async (surface) => {
    mock.list.mockResolvedValue({ nodes: [node("source", null, "目录文档")] });
    await act(async () => root.render(surface === "tree" ? <TreePanel /> : <QuickPanel variant={surface === "mobile quick" ? "mobile" : "desktop"} />));
    const input = host.querySelector<HTMLInputElement>('input[data-search-scope]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "not-found");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector('[data-knowledge-tree-select-id="source"]')).toBeNull();
    await act(async () => window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_CLEAR_SEARCH_EVENT, { detail: { clearOnly: true } })));
    expect(input.value).toBe("");
    expect(host.querySelector('[data-knowledge-tree-select-id="source"]')).not.toBeNull();
  });

  it.each(["tree", "desktop quick", "mobile quick"])("%s waits for refresh, reveals the source children and selects the copy", async (surface) => {
    const ancestor = node("ancestor", null, "Ancestor");
    const source = node("source", ancestor.id, "Source");
    const copy = node("copy", source.id, "Copy");
    mock.list.mockResolvedValueOnce({ nodes: [ancestor, source] });
    let finishReload!: (result: { nodes: KnowledgeTreeNode[] }) => void;
    mock.list.mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }));
    await act(async () => root.render(surface === "tree" ? <TreePanel /> : <QuickPanel variant={surface === "mobile quick" ? "mobile" : "desktop"} />));
    await act(async () => {
      revealCreatedKnowledgeTreeNote(source.id, copy.id);
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
    });
    expect(host.querySelector('[data-knowledge-tree-select-id="copy"]')).toBeNull();
    await act(async () => finishReload({ nodes: [ancestor, source, copy] }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const selected = host.querySelector('[data-knowledge-tree-select-id="copy"]');
    expect(selected).not.toBeNull();
    expect(selected?.getAttribute("aria-selected")).toBe("true");
    expect(scrolledIds).toContain("copy");
  });

  it("reveals an open document through a filtered and collapsed ancestor path", async () => {
    const ancestor = node("reveal-ancestor", null, "加工资料");
    const source = node("reveal-source", ancestor.id, "3342 产品资料");
    const child = node("reveal-child", source.id, "261111-011");
    mock.list.mockResolvedValue({ nodes: [ancestor, source, child] });
    await act(async () => root.render(<TreePanel />));
    const input = host.querySelector<HTMLInputElement>('input[data-search-scope]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "other");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector('[data-knowledge-tree-select-id="reveal-child"]')).toBeNull();
    await act(async () => revealKnowledgeTreeNote(child.resourceId));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(input.value).toBe("");
    expect(host.querySelector('[data-knowledge-tree-select-id="reveal-child"]')?.getAttribute("aria-selected")).toBe("true");
    expect(scrolledIds).toContain(child.id);
    expect(mock.actions.setSelectedKnowledgeTreeParent).toHaveBeenCalledWith(source.id);
  });

  it("does not expose locked folder descendants through search or explicit reveal", async () => {
    const locked = { ...node("locked-folder", null, "加工资料"), nodeType: "folder" as const,
      resourceType: "notebook" as const, isPasswordProtected: 1 };
    const child = node("locked-child", locked.id, "3342 私密文档");
    mock.list.mockResolvedValue({ nodes: [locked, child] });
    await act(async () => root.render(<TreePanel />));
    const input = host.querySelector<HTMLInputElement>('input[data-search-scope]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "3342");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      revealKnowledgeTreeNote(child.resourceId);
    });
    expect(host.querySelector('[data-knowledge-tree-select-id="locked-child"]')).toBeNull();
    expect(input.value).toBe("3342");
    expect(mock.actions.setSelectedKnowledgeTreeParent).not.toHaveBeenCalled();
  });

  it("opens a filtered document in its actual parent without clearing the tree filter", async () => {
    const parent = node("click-parent", null, "加工资料");
    const source = node("click-source", parent.id, "3342 产品资料");
    mock.list.mockResolvedValue({ nodes: [parent, source] });
    mock.getNote.mockResolvedValue({ id: source.resourceId, title: source.title, notebookId: "actual-notebook" });
    await act(async () => root.render(<TreePanel layoutMode="three-column" />));
    const input = host.querySelector<HTMLInputElement>('input[data-search-scope]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "3342");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="3342 产品资料"]')!.click());
    expect(input.value).toBe("3342");
    expect(mock.actions.setSelectedNotebook).toHaveBeenCalledWith("actual-notebook");
    expect(mock.actions.setSelectedKnowledgeTreeParent).toHaveBeenCalledWith(parent.id);
    expect(mock.actions.setActiveNote).toHaveBeenCalledWith(expect.objectContaining({ id: source.resourceId }));
  });

  it("automatically expands searched document descendants and keeps search disclosure separate from saved tree expansion", async () => {
    const ancestor = { ...node("search-root", null, "加工资料"), nodeType: "folder" as const, resourceType: "notebook" as const, childCount: 1 };
    const source = { ...node("search-product", ancestor.id, "CM3342 产品资料"), childCount: 2 };
    const folder = { ...node("search-folder", source.id, "261111-011"), nodeType: "folder" as const, resourceType: "notebook" as const, childCount: 1 };
    const child = node("search-child", source.id, "产品测试记录");
    const grandchild = node("search-grandchild", folder.id, "首件测试");
    const expansionScope = getKnowledgeTreeExpansionScope();
    saveKnowledgeTreeExpansion(expansionScope, [ancestor.id]);
    mock.list.mockResolvedValue({ nodes: [ancestor, source, folder, child, grandchild] });
    mock.getNote.mockResolvedValue({ id: source.resourceId, title: source.title, notebookId: "actual-notebook" });
    await act(async () => root.render(<TreePanel layoutMode="three-column" />));
    const input = host.querySelector<HTMLInputElement>('input[data-search-scope]')!;
    const row = (id: string) => host.querySelector(`[data-knowledge-tree-select-id="${id}"]`);
    const descendants = () => [folder, child, grandchild].map((candidate) => row(candidate.id));
    const setQuery = async (query: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const toggleProduct = async (label: "展开" | "折叠") => {
      await act(async () => row(source.id)!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    };
    expect(row(source.id)).not.toBeNull();
    expect(descendants().map(Boolean)).toEqual([false, false, false]);

    await setQuery("3342");
    expect(descendants().every(Boolean)).toBe(true);
    await toggleProduct("折叠");
    expect(descendants().map(Boolean)).toEqual([false, false, false]);
    expect(input.value).toBe("3342");
    expect(getKnowledgeTreeExpansionSnapshot(expansionScope).expandedNodeIds).toEqual([ancestor.id]);
    expect(mock.update).not.toHaveBeenCalled();

    await toggleProduct("展开");
    expect(descendants().every(Boolean)).toBe(true);
    await toggleProduct("折叠");
    await act(async () => row(source.id)!.querySelector<HTMLButtonElement>(`button[title="${source.title}"]`)!.click());
    expect(descendants().every(Boolean)).toBe(true);
    expect(input.value).toBe("3342");
    expect(mock.actions.setActiveNote).toHaveBeenCalledWith(expect.objectContaining({ id: source.resourceId }));

    await toggleProduct("折叠");
    await setQuery("CM3342");
    expect(descendants().every(Boolean)).toBe(true);
    await toggleProduct("折叠");
    await setQuery("");
    expect(row(source.id)).not.toBeNull();
    expect(descendants().map(Boolean)).toEqual([false, false, false]);
    expect(getKnowledgeTreeExpansionSnapshot(expansionScope).expandedNodeIds).toEqual([ancestor.id]);
    expect(mock.update).not.toHaveBeenCalled();
  });

  it("selects a template-created child and selects its full title for inline naming", async () => {
    const ancestor = node("template-ancestor", null, "加工资料");
    const source = node("template-parent", ancestor.id, "3342 产品资料");
    const created = node("template-child", source.id, "SMT-产品测试记录-模板");
    let createdOnServer = false;
    mock.list.mockImplementation(async () => ({ nodes: createdOnServer ? [ancestor, source, created] : [ancestor, source] }));
    mock.createTemplate.mockImplementation(async () => {
      createdOnServer = true;
      return { noteId: created.resourceId, node: created };
    });
    mock.getNote.mockResolvedValue({ id: created.resourceId, title: created.title, notebookId: "actual-notebook" });
    const onCompleted = vi.fn();
    const onFailed = vi.fn();
    await act(async () => root.render(<TreePanel />));
    await act(async () => root.render(<TreePanel templateCreateRequest={{
      requestId: 1, parentId: source.id, templateId: "smt-template", onCompleted, onFailed,
    }} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(mock.createTemplate).toHaveBeenCalledTimes(1);
    expect(mock.createTemplate).toHaveBeenCalledWith("smt-template", source.id);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    expect(host.querySelector(`[data-knowledge-tree-select-id="${created.id}"]`)?.getAttribute("aria-selected")).toBe("true");
    const field = host.querySelector<HTMLInputElement>('input[aria-label="文档名称"]')!;
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe(created.title);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(created.title.length);
    expect(host.querySelector('button[aria-label="确认重命名"]')).not.toBeNull();
    expect(scrolledIds).toContain(created.id);
  });
});
