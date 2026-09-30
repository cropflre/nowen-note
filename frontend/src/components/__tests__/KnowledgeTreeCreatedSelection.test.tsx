import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TreePanel from "../KnowledgeTreePanel";
import QuickPanel from "../MobileKnowledgeTreePanel";
import { revealCreatedKnowledgeTreeNote } from "@/lib/knowledgeTreeCreateVisibility";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};

const mock = vi.hoisted(() => ({
  list: vi.fn(),
  actions: { setSearchQuery: vi.fn(), setViewMode: vi.fn() },
  state: { viewMode: "all", searchQuery: "", selectedNotebookId: null, activeNote: null, notebooks: [], noteListCollapsed: false },
}));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: mock.state }), useAppActions: () => mock.actions }));
vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: { list: mock.list, listShared: async () => ({ nodes: [] }) } }));
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
});
