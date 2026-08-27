import { afterEach, describe, expect, it, vi } from "vitest";

import { knowledgeTreeApi } from "@/lib/knowledgeTreeApi";
import { installMobileLocalKnowledgeTreeBridge } from "@/lib/mobileLocalKnowledgeTreeBridge";
import type { NativeLocalRepository } from "@/lib/nativeLocalRepository";
import type { NoteListItem, Notebook } from "@/types";

const now = "2026-08-26T00:00:00.000Z";

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

describe("mobile local knowledge tree bridge", () => {
  it("lists local notebooks and notes without requesting the remote registry", async () => {
    const repository = {
      listNotebooksForWorkspace: vi.fn(async () => [notebook({ id: "folder-1", name: "本地目录" })]),
      listNotesForWorkspace: vi.fn(async () => [note({ id: "note-1", notebookId: "folder-1", title: "本地笔记" })]),
    } as unknown as NativeLocalRepository;
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
});
