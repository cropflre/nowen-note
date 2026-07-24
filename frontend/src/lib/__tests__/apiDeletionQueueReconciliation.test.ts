import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import {
  clearQueue,
  enqueue,
  getQueue,
  updateItem,
} from "@/lib/offlineQueue";

function seedConflict(noteId: string): void {
  enqueue({
    type: "updateNote",
    noteId,
    url: `/notes/${noteId}`,
    method: "PUT",
    body: {
      title: `冲突笔记 ${noteId}`,
      content: "本地内容",
      contentText: "本地内容",
      contentFormat: "markdown",
      version: 1,
    },
  });
  const item = getQueue().find((queued) => queued.noteId === noteId)!;
  updateItem(item.id, {
    conflict: true,
    blocked: true,
    retryable: false,
    errorCode: "VERSION_CONFLICT",
    localPayload: item.body,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function noteResponse(noteId: string) {
  return {
    id: noteId,
    userId: "user-1",
    notebookId: "book-1",
    workspaceId: null,
    title: "已删除笔记",
    content: "",
    contentText: "",
    contentFormat: "markdown",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 1,
    trashedAt: "2026-07-13T03:00:00.000Z",
    version: 2,
    sortOrder: 0,
    createdAt: "2026-07-13T02:00:00.000Z",
    updatedAt: "2026-07-13T03:00:00.000Z",
  };
}

describe("API deletion queue reconciliation", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nowen-server-url", "http://sync-test.local");
    localStorage.setItem("nowen-token", "test.token.value");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    clearQueue();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("removes a conflicted update after the server acknowledges moving that note to trash", async () => {
    seedConflict("note-trash");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(noteResponse("note-trash"))));

    await api.updateNote("note-trash", { isTrashed: 1 } as any);

    expect(getQueue()).toEqual([]);
  });

  it("removes a conflicted update after the server acknowledges permanent deletion", async () => {
    seedConflict("note-delete");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true })));

    await api.deleteNote("note-delete");

    expect(getQueue()).toEqual([]);
  });

  it("uses one workspace-scoped request and removes only conflicts returned by empty trash", async () => {
    seedConflict("deleted-a");
    seedConflict("kept-b");
    localStorage.setItem("nowen-current-workspace", "team-workspace");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      count: 1,
      skipped: 0,
      noteIds: ["deleted-a"],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.emptyTrash();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://sync-test.local/api/notes/trash/empty?workspaceId=team-workspace",
    );
    expect(getQueue().map((item) => item.noteId)).toEqual(["kept-b"]);
  });

  it("removes conflicts for notes trashed by deleting a notebook", async () => {
    seedConflict("deleted-a");
    seedConflict("kept-b");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      softDeletedNotebookCount: 1,
      trashedNoteCount: 1,
      trashedNoteIds: ["deleted-a"],
    })));

    await api.deleteNotebook("book-1");

    expect(getQueue().map((item) => item.noteId)).toEqual(["kept-b"]);
  });
});
