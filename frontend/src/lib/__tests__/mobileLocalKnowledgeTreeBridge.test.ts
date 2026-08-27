import { afterEach, describe, expect, it, vi } from "vitest";

import { knowledgeTreeApi } from "@/lib/knowledgeTreeApi";
import { installMobileLocalKnowledgeTreeBridge } from "@/lib/mobileLocalKnowledgeTreeBridge";
import type { NativeLocalRepository } from "@/lib/nativeLocalRepository";
import type { NoteListItem, Notebook } from "@/types";

const now = "2026-08-27T00:00:00.000Z";

function notebook(input: Partial<Notebook> & Pick<Notebook, "id" | "name">): Notebook {
  const { id, name, ...rest } = input;
  return {
    ...rest,
    id,
    userId: "mobile-local-user",
    workspaceId: null,
    parentId: null,
    name,
    description: null,
    icon: "📁",
    color: null,
    sortOrder: 0,
    isExpanded: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function note(input: Partial<NoteListItem> & Pick<NoteListItem, "id" | "notebookId" | "title">): NoteListItem {
  const { id, notebookId, title, ...rest } = input;
  return {
    ...rest,
    id,
    userId: "mobile-local-user",
    notebookId,
    workspaceId: null,
    title,
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
  it("lists local notebooks and notes without requesting the remote registry", async () => {
    const { repository } = createRepository();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository);
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
    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository);

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
    restoreBridge = installMobileLocalKnowledgeTreeBridge(repository);

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
});
