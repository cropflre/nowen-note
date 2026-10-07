import { afterEach, describe, expect, it, vi } from "vitest";

import { knowledgeTreeApi } from "@/lib/knowledgeTreeApi";
import { api } from "@/lib/api";
import { installMobileLocalKnowledgeTreeBridge } from "@/lib/mobileLocalKnowledgeTreeBridge";
import type { NativeDatabase } from "@/lib/nativeDatabase";
import type { NativeLocalRepository } from "@/lib/nativeLocalRepository";
import type { NoteListItem, Notebook } from "@/types";

const now = "2026-08-27T00:00:00.000Z";

function notebook(input: Partial<Notebook> & Pick<Notebook, "id" | "name">): Notebook {
  const { id, name, ...rest } = input;
  return {
    userId: "mobile-local-user",
    workspaceId: null,
    parentId: null,
    description: null,
    icon: "📁",
    color: null,
    sortOrder: 0,
    isExpanded: 1,
    createdAt: now,
    updatedAt: now,
    ...rest,
    id,
    name,
  };
}

function note(input: Partial<NoteListItem> & Pick<NoteListItem, "id" | "notebookId" | "title">): NoteListItem {
  const { id, notebookId, title, ...rest } = input;
  return {
    userId: "mobile-local-user",
    workspaceId: null,
    contentText: "",
    contentFormat: "tiptap-json",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    version: 1,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...rest,
    id,
    notebookId,
    title,
  };
}

let restoreBridge: (() => void) | null = null;

afterEach(() => {
  restoreBridge?.();
  restoreBridge = null;
  vi.restoreAllMocks();
});

function createRepository() {
  const notebooks: Notebook[] = [
    notebook({ id: "folder-1", name: "本地目录 A" }),
    notebook({ id: "folder-2", name: "本地目录 B", sortOrder: 1 }),
  ];
  const notes: NoteListItem[] = [
    note({ id: "note-1", notebookId: "folder-1", title: "本地笔记" }),
  ];

  const repository = {
    listNotebooksForWorkspace: vi.fn(async () => notebooks),
    listNotesForWorkspace: vi.fn(async (_workspaceId?: string, query?: { includeTrashed?: boolean }) => (
      query?.includeTrashed ? notes : notes.filter((item) => item.isTrashed !== 1)
    )),
    notebooks: {
      create: vi.fn(async (input: Partial<Notebook> & { id: string }) => {
        notebooks.push(notebook({ ...input, id: input.id, name: input.name || "未命名文件夹" }));
        return { id: input.id, savedAt: now };
      }),
      update: vi.fn(async (id: string, patch: Partial<Notebook>) => {
        const item = notebooks.find((candidate) => candidate.id === id);
        if (!item) throw new Error("笔记本不存在");
        Object.assign(item, patch, { updatedAt: now });
        return { id, savedAt: now };
      }),
      remove: vi.fn(async (id: string) => {
        const item = notebooks.find((candidate) => candidate.id === id);
        if (item) Object.assign(item, { isDeleted: 1, updatedAt: now });
      }),
    },
    notes: {
      create: vi.fn(async (input: Partial<NoteListItem> & { id: string }) => {
        notes.push(note({
          ...input,
          id: input.id,
          notebookId: input.notebookId || "",
          title: input.title || "无标题笔记",
        }));
        return { id: input.id, savedAt: now };
      }),
      update: vi.fn(async (id: string, patch: Partial<NoteListItem>) => {
        const item = notes.find((candidate) => candidate.id === id);
        if (!item) throw new Error("笔记不存在");
        Object.assign(item, patch, { updatedAt: now });
        return { id, savedAt: now };
      }),
    },
    reorderNotes: vi.fn(async (items: Array<{ id: string; sortOrder: number }>) => {
      for (const item of items) {
        const target = notes.find((candidate) => candidate.id === item.id);
        if (target) target.sortOrder = item.sortOrder;
      }
    }),
    reorderNotebooks: vi.fn(async (items: Array<{ id: string; sortOrder: number }>) => {
      for (const item of items) {
        const target = notebooks.find((candidate) => candidate.id === item.id);
        if (target) target.sortOrder = item.sortOrder;
      }
    }),
  } as unknown as NativeLocalRepository;

  return { repository, notebooks, notes };
}

describe("mobile local knowledge tree bridge", () => {
  it("restores the last server tree with cross-type parents after a signed-in device goes offline", async () => {
    const { repository } = createRepository();
    const metadata = new Map<string, string>();
    const db = {
      run: vi.fn(async (_sql: string, values: unknown[]) => {
        metadata.set(String(values[0]), String(values[1]));
        return { changes: 1 };
      }),
      query: vi.fn(async (sql: string, values: unknown[]) => sql.includes("native_runtime_meta")
        ? (metadata.has(String(values[0])) ? [{ value: metadata.get(String(values[0])) }] : [])
        : []),
    } as unknown as NativeDatabase;
    const remoteNode = { id: "mindmap:map-1", workspaceId: null,
      parentId: "note:note-1", resourceType: "mindmap" };
    const remoteList = vi.spyOn(knowledgeTreeApi, "listForWorkspace")
      .mockResolvedValueOnce({ nodes: [remoteNode] as never })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: false }, db);
    expect((await knowledgeTreeApi.listForWorkspace("personal")).nodes).toEqual([remoteNode]);
    restoreBridge();
    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: false }, db);
    expect((await knowledgeTreeApi.listForWorkspace("personal")).nodes).toEqual([remoteNode]);
    expect(remoteList).toHaveBeenCalledTimes(2);
    expect(repository.listNotebooksForWorkspace).not.toHaveBeenCalled();
  });

  it("keeps offline snapshots isolated by workspace and refuses locally revoked access", async () => {
    const { repository } = createRepository();
    const metadata = new Map<string, string>();
    let accessStatus = "active";
    const db = {
      run: vi.fn(async (sql: string, values: unknown[]) => {
        if (sql.includes("UPDATE sync_workspace_scopes")) {
          accessStatus = "access_revoked";
          return { changes: 1 };
        }
        metadata.set(String(values[0]), String(values[1]));
        return { changes: 1 };
      }),
      query: vi.fn(async (sql: string, values: unknown[]) => {
        if (sql.includes("sync_workspace_scopes")) return [{ accessStatus }];
        if (sql.includes("native_runtime_meta") && metadata.has(String(values[0]))) {
          return [{ value: metadata.get(String(values[0])) }];
        }
        return [];
      }),
    } as unknown as NativeDatabase;
    const remoteNode = { id: "mindmap:ws-map", workspaceId: "ws-a", parentId: "note:ws-note" };
    const remoteList = vi.spyOn(knowledgeTreeApi, "listForWorkspace")
      .mockResolvedValueOnce({ nodes: [remoteNode] as never })
      .mockRejectedValue(new TypeError("Failed to fetch"));

    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: false }, db);
    expect((await knowledgeTreeApi.listForWorkspace("ws-a")).nodes).toEqual([remoteNode]);
    expect((await knowledgeTreeApi.listForWorkspace("ws-a")).nodes).toEqual([remoteNode]);
    await expect(knowledgeTreeApi.listForWorkspace("ws-b")).rejects.toThrow("目录权限和密码信息尚未缓存");
    const denied = Object.assign(new Error("forbidden"), { status: 403 });
    remoteList.mockRejectedValueOnce(denied);
    await expect(knowledgeTreeApi.listForWorkspace("ws-a")).rejects.toBe(denied);
    expect(accessStatus).toBe("access_revoked");
    await expect(knowledgeTreeApi.listForWorkspace("ws-a")).rejects.toThrow("离线访问权未确认");
    expect(remoteList).toHaveBeenCalledTimes(5);
  });

  it("rejects a server tree containing nodes from another workspace", async () => {
    const { repository } = createRepository();
    const db = {
      run: vi.fn(),
      query: vi.fn(),
    } as unknown as NativeDatabase;
    vi.spyOn(knowledgeTreeApi, "listForWorkspace").mockResolvedValue({ nodes: [
      { id: "mindmap:foreign", workspaceId: "ws-b" },
    ] as never });

    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: false }, db);
    await expect(knowledgeTreeApi.listForWorkspace("ws-a")).rejects.toThrow("空间不匹配");
    expect(db.run).not.toHaveBeenCalled();
    expect(repository.listNotebooksForWorkspace).not.toHaveBeenCalled();
  });

  it("uses the server tree in signed-in mode so cross-type placement and shared nodes remain visible", async () => {
    const { repository } = createRepository();
    const remote = { id: "mindmap:map-1", parentId: "note:note-1", resourceType: "mindmap" };
    const remoteList = vi.spyOn(knowledgeTreeApi, "list").mockResolvedValue({ nodes: [remote] as never });
    const remoteShared = vi.spyOn(knowledgeTreeApi, "listShared").mockResolvedValue({ nodes: [remote] as never });

    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: false });
    expect((await knowledgeTreeApi.list()).nodes).toEqual([remote]);
    expect((await knowledgeTreeApi.listShared()).nodes).toEqual([remote]);
    expect(remoteList).toHaveBeenCalledOnce();
    expect(remoteShared).toHaveBeenCalledOnce();
    expect(repository.listNotebooksForWorkspace).not.toHaveBeenCalled();
  });

  it("refuses a password-free local projection when a signed-in device has no server snapshot", async () => {
    const { repository } = createRepository();
    const remoteList = vi.spyOn(knowledgeTreeApi, "list").mockRejectedValue(new TypeError("Failed to fetch"));
    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: false });

    await expect(knowledgeTreeApi.list()).rejects.toThrow("目录权限和密码信息尚未缓存");
    expect(repository.listNotebooksForWorkspace).not.toHaveBeenCalled();

    const denied = Object.assign(new Error("forbidden"), { status: 403 });
    remoteList.mockRejectedValue(denied);
    await expect(knowledgeTreeApi.list()).rejects.toBe(denied);
    expect(repository.listNotebooksForWorkspace).not.toHaveBeenCalled();

    const malformed = new TypeError("Cannot read properties of undefined");
    remoteList.mockRejectedValue(malformed);
    await expect(knowledgeTreeApi.list()).rejects.toBe(malformed);
    expect(repository.listNotebooksForWorkspace).not.toHaveBeenCalled();
  });

  it("lists local notebooks and notes without requesting the remote registry", async () => {
    const { repository } = createRepository();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: true });
    const result = await knowledgeTreeApi.list();
    const shared = await knowledgeTreeApi.listShared();

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "notebook:folder-1", parentId: null, resourceId: "folder-1" }),
      expect.objectContaining({ id: "note:note-1", parentId: "notebook:folder-1", resourceId: "note-1" }),
    ]));
    expect(shared.nodes).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("persists create, rename, move, reorder and delete through the native repository only", async () => {
    const { repository, notes } = createRepository();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: true });

    const folder = await knowledgeTreeApi.create({
      parentId: "notebook:folder-1",
      nodeType: "folder",
      title: "离线子目录",
    });
    expect(folder.resourceType).toBe("notebook");
    expect(folder.parentId).toBe("notebook:folder-1");

    const created = await knowledgeTreeApi.create({
      parentId: folder.id,
      nodeType: "note",
      title: "离线创建",
    });
    expect(created.resourceType).toBe("note");
    expect(created.parentId).toBe(folder.id);

    const renamed = await knowledgeTreeApi.update(created.id, { title: "离线重命名" });
    expect(renamed).toEqual(expect.objectContaining({ title: "离线重命名" }));

    const moved = await knowledgeTreeApi.move(created.id, { parentId: "notebook:folder-2", sortOrder: 7 });
    expect(moved).toEqual(expect.objectContaining({ parentId: "notebook:folder-2", sortOrder: 7 }));

    await knowledgeTreeApi.reorder([{ id: created.id, sortOrder: 2 }]);
    expect(notes.find((item) => `note:${item.id}` === created.id)?.sortOrder).toBe(2);

    const removed = await knowledgeTreeApi.remove(created.id, "subtree");
    expect(removed.affectedNodeIds).toContain(created.id);
    expect(notes.find((item) => `note:${item.id}` === created.id)?.isTrashed).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks unsupported note-parent and server ACL operations before any remote request", async () => {
    const { repository } = createRepository();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: true });

    await expect(knowledgeTreeApi.create({
      parentId: "note:note-1",
      nodeType: "note",
      title: "不应创建",
    })).rejects.toMatchObject({ code: "MOBILE_LOCAL_UNSUPPORTED" });

    const permissions = await knowledgeTreeApi.getPermissions("note:note-1");
    expect(permissions.direct).toEqual([]);
    await expect(knowledgeTreeApi.setAccessMode("note:note-1", "restricted"))
      .rejects.toMatchObject({ code: "MOBILE_LOCAL_UNSUPPORTED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("persists local mind map placement and trash without creating a note", async () => {
    const { repository } = createRepository();
    const maps: Array<{ id: string; userId: string; workspaceId: null; title: string; starred: number; createdAt: string; updatedAt: string }> = [];
    const placements = new Map<string, { parentId: string | null; sortOrder: number; isDeleted: number }>();
    const db = {
      run: vi.fn(async (sql: string, values: unknown[] = []) => {
        const id = String(values[0] || "");
        if (sql.startsWith("INSERT INTO mobile_local_mindmap_tree")) {
          const current = placements.get(id) || { parentId: null, sortOrder: 0, isDeleted: 0 };
          if (sql.includes("(mindmapId,parentId,sortOrder)")) placements.set(id, { ...current, parentId: values[1] as string | null, sortOrder: Number(values[2]) });
          else if (sql.includes("(mindmapId,parentId)")) placements.set(id, { ...current, parentId: values[1] as string | null });
          else if (sql.includes("(mindmapId,isDeleted)")) placements.set(id, { ...current, isDeleted: 1 });
          else if (sql.includes("(mindmapId,sortOrder)")) placements.set(id, { ...current, sortOrder: Number(values[1]) });
        } else if (sql.startsWith("UPDATE mobile_local_mindmap_tree SET isDeleted=0")) {
          const current = placements.get(id);
          if (current) current.isDeleted = 0;
        }
        return { changes: 1 };
      }),
      query: vi.fn(async (sql: string) => {
        if (!sql.includes("FROM mindmaps m LEFT JOIN mobile_local_mindmap_tree")) return [];
        return maps.flatMap((map) => {
          const placement = placements.get(map.id);
          if (placement?.isDeleted && sql.includes("AND COALESCE(t.isDeleted,0)=0")) return [];
          return [{ ...map, treeParentId: placement?.parentId || null, treeSortOrder: placement?.sortOrder || 0, treeIsDeleted: placement?.isDeleted || 0 }];
        });
      }),
    } as unknown as NativeDatabase;
    vi.spyOn(api, "createMindMap").mockImplementation(async ({ title }) => {
      const map = { id: "map-1", userId: "mobile-local-user", workspaceId: null, title: title || "无标题导图", starred: 0, createdAt: now, updatedAt: now };
      maps.push(map);
      return { ...map, data: "{}" };
    });
    vi.spyOn(api, "updateMindMap").mockImplementation(async (id, patch) => {
      const map = maps.find((item) => item.id === id)!;
      map.title = patch.title || map.title;
      return { ...map, data: "{}" };
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: true }, db);

    const created = await knowledgeTreeApi.create({ parentId: "notebook:folder-1", nodeType: "mindmap", title: "离线脑图" });
    expect(created).toEqual(expect.objectContaining({ id: "mindmap:map-1", parentId: "notebook:folder-1", resourceType: "mindmap" }));
    expect(repository.notes.create).not.toHaveBeenCalled();
    expect((await knowledgeTreeApi.list()).nodes.find((node) => node.id === created.id)?.parentId).toBe("notebook:folder-1");

    await knowledgeTreeApi.move(created.id, { parentId: "notebook:folder-2", sortOrder: 4 });
    expect((await knowledgeTreeApi.list()).nodes.find((node) => node.id === created.id)).toEqual(expect.objectContaining({ parentId: "notebook:folder-2", sortOrder: 4 }));
    await knowledgeTreeApi.update(created.id, { title: "已改名脑图" });
    await knowledgeTreeApi.reorder([{ id: created.id, sortOrder: 8 }]);
    expect((await knowledgeTreeApi.list()).nodes.find((node) => node.id === created.id)).toEqual(expect.objectContaining({ title: "已改名脑图", sortOrder: 8 }));
    const removed = await knowledgeTreeApi.remove(created.id, "subtree");
    expect(removed.affectedNodeIds).toContain(created.id);
    expect((await knowledgeTreeApi.list()).nodes.some((node) => node.id === created.id)).toBe(false);
    expect((await knowledgeTreeApi.list(true)).nodes.find((node) => node.id === created.id)?.isDeleted).toBe(1);
    await knowledgeTreeApi.restore(created.id);
    expect((await knowledgeTreeApi.list()).nodes.find((node) => node.id === created.id)?.parentId).toBe("notebook:folder-2");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
