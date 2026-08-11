import { beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_TREE_SORT_STORAGE_KEY } from "@/lib/knowledgeTreeSort";

const localStore = vi.hoisted(() => ({
  getOfflineKnowledgeTree: vi.fn(),
  putCompleteOfflineKnowledgeTree: vi.fn(),
}));
const api = vi.hoisted(() => ({
  getCurrentWorkspace: vi.fn(() => "personal"),
  getServerUrl: vi.fn(() => "https://notes.example.com"),
}));

vi.mock("@/lib/localStore", () => localStore);
vi.mock("@/lib/api", () => api);

import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

function knowledgeTreeNode(): KnowledgeTreeNode {
  return {
    id: "node-1",
    userId: "user-1",
    workspaceId: null,
    scopeKey: "personal",
    parentId: null,
    nodeType: "note",
    resourceType: "note",
    resourceId: "note-1",
    title: "离线笔记",
    sortOrder: 0,
    isExpanded: 0,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    access: {
      nodeId: "node-1",
      rolePreset: "admin",
      capabilities: {
        canView: true,
        canComment: true,
        canCreate: true,
        canEdit: true,
        canDelete: true,
        canMove: true,
        canDownload: true,
        canReshare: true,
        canManageMembers: true,
      },
      source: "owner",
      sourceNodeId: null,
    },
  };
}

describe("knowledgeTreeApi offline fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    api.getCurrentWorkspace.mockReturnValue("personal");
    api.getServerUrl.mockReturnValue("https://notes.example.com");
    localStore.putCompleteOfflineKnowledgeTree.mockResolvedValue(undefined);
    localStore.getOfflineKnowledgeTree.mockResolvedValue(undefined);
  });

  it("caches the online tree for the current workspace", async () => {
    const node = knowledgeTreeNode();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ nodes: [node] }))));

    await expect(knowledgeTreeApi.list()).resolves.toEqual({ nodes: [node] });

    expect(localStore.putCompleteOfflineKnowledgeTree).toHaveBeenCalledWith("personal", [node]);
  });

  it("preserves the server manual order when the display sort changes offline", async () => {
    const first = { ...knowledgeTreeNode(), title: "Zulu" };
    const second = { ...knowledgeTreeNode(), id: "node-2", resourceId: "note-2", title: "Alpha", sortOrder: 1 };
    let cachedNodes: KnowledgeTreeNode[] | undefined;
    localStore.putCompleteOfflineKnowledgeTree.mockImplementation(async (_workspaceId, nodes) => {
      cachedNodes = nodes;
    });
    localStore.getOfflineKnowledgeTree.mockImplementation(async () => cachedNodes);
    localStorage.setItem(KNOWLEDGE_TREE_SORT_STORAGE_KEY, "title-asc");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ nodes: [first, second] }))));

    await expect(knowledgeTreeApi.list()).resolves.toMatchObject({
      nodes: [{ id: "node-1", sortOrder: 1 }, { id: "node-2", sortOrder: 0 }],
    });
    expect(cachedNodes).toEqual([first, second]);

    localStorage.setItem(KNOWLEDGE_TREE_SORT_STORAGE_KEY, "manual");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(knowledgeTreeApi.list()).resolves.toMatchObject({
      nodes: [{ id: "node-1", sortOrder: 0 }, { id: "node-2", sortOrder: 1 }],
    });
  });

  it("uses the current workspace snapshot when the tree request fails offline", async () => {
    const node = knowledgeTreeNode();
    localStore.getOfflineKnowledgeTree.mockResolvedValue([node]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(knowledgeTreeApi.list()).resolves.toEqual({ nodes: [node] });

    expect(localStore.getOfflineKnowledgeTree).toHaveBeenCalledWith("personal");
  });

  it.each([401, 403])("does not expose a cached tree after an authorization failure (%i)", async (status) => {
    localStore.getOfflineKnowledgeTree.mockResolvedValue([knowledgeTreeNode()]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "没有访问权限" }),
      { status },
    )));

    await expect(knowledgeTreeApi.list()).rejects.toMatchObject({ status });

    expect(localStore.getOfflineKnowledgeTree).not.toHaveBeenCalled();
  });
});