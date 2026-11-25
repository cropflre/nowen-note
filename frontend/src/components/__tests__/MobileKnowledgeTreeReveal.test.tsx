import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickPanel from "../MobileKnowledgeTreePanel";
import { revealKnowledgeTreeNote } from "@/lib/knowledgeTreeCreateVisibility";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({
  list: vi.fn(), createTemplate: vi.fn(), getNote: vi.fn(),
  actions: {
    setActiveNote: vi.fn(), setSelectedNotebook: vi.fn(), setSelectedKnowledgeTreeParent: vi.fn(),
    setSearchQuery: vi.fn(), setViewMode: vi.fn(), openNoteTab: vi.fn(), setMobileSidebar: vi.fn(),
    setMobileView: vi.fn(), refreshNotes: vi.fn(), refreshNotebooks: vi.fn(), clearSelectedTags: vi.fn(),
  },
  state: { viewMode: "all", searchQuery: "", selectedNotebookId: null, activeNote: null, notebooks: [], noteListCollapsed: false },
}));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: mock.state }), useAppActions: () => mock.actions }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }) }));
vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: { list: mock.list, listShared: async () => ({ nodes: [] }) } }));
vi.mock("@/lib/noteTemplatesApi", () => ({ noteTemplatesApi: { createNote: mock.createTemplate } }));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, api: { ...original.api, getNote: mock.getNote } };
});
vi.mock("@/components/KnowledgeTreeCreateMenuRuntime", () => ({
  KnowledgeTreeCreateDropdown: ({ menu, onCreateFromTemplate }: { menu: { parentId: string | null } | null; onCreateFromTemplate: (parentId: string | null) => void }) =>
    menu ? <button onClick={() => onCreateFromTemplate(menu.parentId)}>选择模板</button> : null,
}));
vi.mock("@/components/NoteTemplatePickerDialog", () => ({
  default: ({ open, onCreate, onClose }: { open: boolean; onCreate: (id: string) => Promise<void>; onClose: () => void }) =>
    open ? <button onClick={() => { void onCreate("template-1").then(onClose); }}>使用模板</button> : null,
}));
vi.mock("@/components/KnowledgeTreeNodeMenu", () => ({ default: () => null }));
vi.mock("@/components/KnowledgeTreePermissionsDialog", () => ({ default: () => null }));
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

describe("quick browse document reveal", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function settle() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }

  it.each(["desktop", "mobile"] as const)("%s reveals a nested document without exposing unrelated branches", async (variant) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes(variant === "desktop" ? "min-width" : "max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const nodes = [node("parent", null, "编码3342"), node("child", "parent", "261111-011"), node("other", null, "Other")];
    mock.list.mockResolvedValue({ nodes });
    await act(async () => root.render(<QuickPanel variant={variant} />));
    await act(async () => revealKnowledgeTreeNote("child"));
    await settle();
    expect(host.querySelector('[data-knowledge-tree-select-id="child"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-knowledge-tree-select-id="other"]')).toBeNull();
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("ignores middle-list-only and inactive-surface reveal requests", async () => {
    mock.list.mockResolvedValue({ nodes: [node("parent", null, "编码3342"), node("child", "parent", "261111-011")] });
    await act(async () => root.render(<QuickPanel variant="desktop" />));
    await act(async () => revealKnowledgeTreeNote("child", false));
    await settle();
    expect(host.querySelector('[data-knowledge-tree-select-id="child"]')).toBeNull();
    await act(async () => root.render(<QuickPanel variant="mobile" />));
    await act(async () => revealKnowledgeTreeNote("child"));
    await settle();
    expect(host.querySelector('[data-knowledge-tree-select-id="child"]')).toBeNull();
  });

  it("switches list scope when locating a tab whose note is not the active document", async () => {
    mock.list.mockResolvedValue({ nodes: [node("parent", null, "编码3342"), node("child", "parent", "261111-011")] });
    await act(async () => root.render(<QuickPanel variant="desktop" />));
    await act(async () => revealKnowledgeTreeNote("child", true, "tab-notebook"));
    await settle();
    expect(host.querySelector('[data-knowledge-tree-select-id="child"]')?.getAttribute("aria-selected")).toBe("true");
    expect(mock.actions.setSelectedNotebook).toHaveBeenCalledWith("tab-notebook");
    expect(mock.actions.setSelectedKnowledgeTreeParent).toHaveBeenCalledWith("parent");
    expect(mock.actions.clearSelectedTags).toHaveBeenCalledOnce();
    expect(mock.actions.setSearchQuery).toHaveBeenCalledWith("");
    expect(mock.actions.setViewMode).toHaveBeenCalledWith("notebook");
    expect(mock.actions.setActiveNote).not.toHaveBeenCalled();
  });

  it.each(["desktop", "mobile"] as const)("%s template creation selects its actual location and selects the title for rename", async (variant) => {
    const parent = node("parent", null, "编码3342");
    const created = node("created", "parent", "产品测试模板");
    let nodes = [parent];
    mock.list.mockImplementation(async () => ({ nodes }));
    mock.createTemplate.mockImplementation(async () => { nodes = [parent, created]; return { noteId: created.resourceId, node: created }; });
    mock.getNote.mockResolvedValue({ id: created.resourceId, title: created.title, notebookId: "notebook", contentFormat: "markdown" });
    await act(async () => root.render(<QuickPanel variant={variant} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="在“编码3342”下新建内容"]')!.click());
    await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "选择模板")!.click());
    await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "使用模板")!.click());
    await settle();
    const row = host.querySelector('[data-knowledge-tree-select-id="created"]');
    expect(row?.getAttribute("aria-selected")).toBe("true");
    const input = row?.querySelector<HTMLInputElement>('[aria-label="文档名称"]');
    expect(input?.value).toBe(created.title);
    expect([input?.selectionStart, input?.selectionEnd]).toEqual([0, created.title.length]);
    expect(mock.createTemplate).toHaveBeenCalledWith("template-1", "parent");
    if (variant === "mobile") expect(mock.actions.setMobileSidebar).toHaveBeenLastCalledWith(true);
  });
});
