import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KnowledgeTreePanel, { type KnowledgeTreeInlineCreateRequest } from "../KnowledgeTreePanel";
import MobileKnowledgeTreePanel from "../MobileKnowledgeTreePanel";
import { AppProvider, useApp, useAppActions } from "@/store/AppContext";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MAP_ID = "11111111-2222-3333-4444-555555555555";
const CREATED_MAP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { getNote: vi.fn(), getNotebooks: async () => [] },
  getCurrentWorkspace: () => null,
  getServerUrl: () => "http://localhost",
}));
vi.mock("@/lib/knowledgeTreeApi", () => ({
  knowledgeTreeApi: {
    list: mocks.list,
    listShared: async () => ({ nodes: [] }),
    create: mocks.create,
  },
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/KnowledgeTreeCreateMenuRuntime", () => ({ KnowledgeTreeCreateDropdown: () => null }));
vi.mock("@/components/KnowledgeTreeNodeMenu", () => ({ default: () => null }));
vi.mock("@/components/KnowledgeTreePermissionsDialog", () => ({ default: () => null }));
vi.mock("@/components/NoteTemplatePickerDialog", () => ({ default: () => null }));
vi.mock("@/components/FolderPasswordDialog", () => ({ default: () => null }));
vi.mock("@/components/attachmentDetail/AttachmentDetailDrawer", () => ({ default: () => null }));
vi.mock("@/components/knowledgeTreeImport", () => ({}));

function mindMapNode(resourceId: string, title = "设备房"): KnowledgeTreeNode {
  return {
    id: `mindmap:${resourceId}`,
    parentId: null,
    title,
    resourceId,
    userId: "owner",
    workspaceId: null,
    scopeKey: "personal:owner",
    nodeType: "mindmap",
    resourceType: "mindmap",
    sortOrder: 0,
    isDeleted: 0,
    isExpanded: 0,
    childCount: 0,
    createdAt: "2026-11-24",
    updatedAt: "2026-11-24",
    access: {
      nodeId: `mindmap:${resourceId}`,
      rolePreset: "editor",
      source: "inherited",
      sourceNodeId: null,
      capabilities: {
        canView: true,
        canCreate: true,
        canEdit: true,
        canComment: true,
        canMove: true,
        canDelete: true,
        canDownload: true,
        canReshare: false,
        canManageMembers: false,
      },
    },
  };
}

describe.each(["mobile tree", "mobile quick"] as const)("%s mindmap drawer navigation", (surface) => {
  let root: Root;
  let host: HTMLDivElement;
  let context: ReturnType<typeof useApp>;
  let actions: ReturnType<typeof useAppActions>;
  let setCreateRequestExternal: ((req: KnowledgeTreeInlineCreateRequest | undefined) => void) | null = null;

  function Harness() {
    context = useApp();
    actions = useAppActions();
    const [createRequest, setCreateRequest] = React.useState<KnowledgeTreeInlineCreateRequest | undefined>();
    setCreateRequestExternal = setCreateRequest;
    return surface === "mobile tree"
      ? <KnowledgeTreePanel variant="mobile" createRequest={createRequest} />
      : <MobileKnowledgeTreePanel variant="mobile" />;
  }

  async function clickMindMap(resourceId: string) {
    const row = host.querySelector<HTMLElement>(`[data-knowledge-tree-select-id="mindmap:${resourceId}"]`);
    expect(row).not.toBeNull();
    await act(async () => row!.querySelector<HTMLElement>("[data-knowledge-tree-title]")!.click());
  }

  beforeEach(async () => {
    localStorage.clear();
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    mocks.list.mockResolvedValue({ nodes: [mindMapNode(MAP_ID)] });
    mocks.create.mockResolvedValue(mindMapNode(CREATED_MAP_ID, "新脑图"));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<AppProvider><Harness /></AppProvider>));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("closes the mobile drawer and routes to the mindmap when tapped", async () => {
    await act(async () => actions.setMobileSidebar(true));
    expect(context.state.mobileSidebarOpen).toBe(true);

    await clickMindMap(MAP_ID);

    expect(window.location.pathname).toBe(`/mindmaps/${MAP_ID}`);
    expect(context.state.mobileSidebarOpen).toBe(false);
  });

  it("closes the mobile drawer even when tapping the already active mindmap", async () => {
    window.history.replaceState(null, "", `/mindmaps/${MAP_ID}`);
    await act(async () => actions.setMobileSidebar(true));
    expect(context.state.mobileSidebarOpen).toBe(true);

    await clickMindMap(MAP_ID);

    expect(window.location.pathname).toBe(`/mindmaps/${MAP_ID}`);
    expect(context.state.mobileSidebarOpen).toBe(false);
  });

  if (surface === "mobile tree") {
    it("closes the mobile drawer after creating a mindmap inline", async () => {
      await act(async () => actions.setMobileSidebar(true));
      await act(async () => {
        setCreateRequestExternal?.({ requestId: 1, parentId: null, kind: "mindmap" });
      });

      const confirmButton = host.querySelector<HTMLButtonElement>('[data-knowledge-tree-inline-create] button');
      expect(confirmButton).not.toBeNull();
      await act(async () => confirmButton!.click());

      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ nodeType: "mindmap" }));
      expect(window.location.pathname).toBe(`/mindmaps/${CREATED_MAP_ID}`);
      expect(context.state.mobileSidebarOpen).toBe(false);
    });
  }
});
