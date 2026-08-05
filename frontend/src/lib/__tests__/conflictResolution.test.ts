import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";
import type { OfflineQueueItem } from "@/lib/offlineQueue";

const apiMock = vi.hoisted(() => ({
  getNote: vi.fn(),
  updateNoteConfirmed: vi.fn(),
  createNoteConfirmed: vi.fn(),
}));
const discardResolvedQueueItems = vi.hoisted(() => vi.fn());
const getQueue = vi.hoisted(() => vi.fn());
const clearDraft = vi.hoisted(() => vi.fn());
const loadDraft = vi.hoisted(() => vi.fn());
const clearOfflineNoteSnapshot = vi.hoisted(() => vi.fn());
const clearNoteSyncConflict = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/offlineQueue", () => ({ discardResolvedQueueItems, getQueue }));
vi.mock("@/lib/draftStorage", () => ({ clearDraft, loadDraft }));
vi.mock("@/lib/offlineRead", () => ({ clearOfflineNoteSnapshot }));
vi.mock("@/lib/noteSyncSafety", () => ({ clearNoteSyncConflict }));

import {
  discardConflictStateForDeletedCopy,
  getConflictCopyId,
  resolveNoteConflict,
  resolveQueuedNoteConflicts,
  shouldPersistPendingConflictSnapshot,
} from "@/lib/conflictResolution";

function remoteNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    userId: "user-1",
    notebookId: "book-1",
    workspaceId: null,
    title: "服务器标题",
    content: "服务器正文",
    contentText: "服务器正文",
    contentFormat: "markdown",
    version: 8,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T01:00:00.000Z",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    trashedAt: null,
    sortOrder: 0,
    ...overrides,
  } as Note;
}

function conflictItem(overrides: Partial<OfflineQueueItem> = {}): OfflineQueueItem {
  return {
    id: "queue-1",
    type: "updateNote",
    noteId: "note-1",
    url: "/notes/note-1",
    method: "PUT",
    body: {
      title: "本地标题",
      content: "本地正文",
      contentText: "本地正文",
      contentFormat: "markdown",
      version: 3,
    },
    localPayload: {
      title: "本地标题",
      content: "本地正文",
      contentText: "本地正文",
      contentFormat: "markdown",
      version: 3,
    },
    enqueuedAt: Date.now(),
    retryCount: 0,
    conflict: true,
    blocked: true,
    retryable: false,
    errorCode: "VERSION_CONFLICT",
    serverVersion: 8,
    ...overrides,
  };
}

describe("resolveNoteConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    loadDraft.mockReturnValue(null);
    getQueue.mockReturnValue([]);
    discardResolvedQueueItems.mockReturnValue({ discarded: true, remainingForNote: false });
    apiMock.getNote.mockResolvedValue(remoteNote());
    apiMock.updateNoteConfirmed.mockReset();
    apiMock.createNoteConfirmed.mockReset();
  });

  it("distinguishes debounced editor input from the conflict payload already copied", () => {
    const detail = {
      note: remoteNote(),
      resolvedLocal: {
        title: "本地标题",
        content: "本地正文",
        contentText: "本地正文",
      },
    };

    expect(shouldPersistPendingConflictSnapshot({
      content: "刚输入的新正文",
      contentText: "刚输入的新正文",
      title: "本地标题",
    }, "本地标题", detail)).toBe(true);
    expect(shouldPersistPendingConflictSnapshot({
      content: "本地正文",
      contentText: "本地正文",
      title: "本地标题",
    }, "本地标题", detail)).toBe(false);
    expect(shouldPersistPendingConflictSnapshot({
      content: "服务器正文",
      contentText: "服务器正文",
      title: "服务器标题",
    }, "本地标题", detail)).toBe(false);
  });

  it("keeps the local version using a non-queued confirmed write and clears only after ACK", async () => {
    const updated = remoteNote({
      title: "本地标题",
      content: "本地正文",
      contentText: "本地正文",
      version: 9,
    });
    apiMock.updateNoteConfirmed.mockResolvedValue(updated);

    await expect(resolveNoteConflict(conflictItem(), "keep-local")).resolves.toMatchObject({
      note: updated,
      resolvedLocal: expect.objectContaining({ content: "本地正文" }),
    });

    expect(apiMock.updateNoteConfirmed).toHaveBeenCalledWith("note-1", expect.objectContaining({
      title: "本地标题",
      content: "本地正文",
      version: 8,
    }));
    expect(discardResolvedQueueItems).toHaveBeenCalledWith(expect.objectContaining({ id: "queue-1" }));
    expect(clearDraft).toHaveBeenCalledWith("note-1");
    expect(clearNoteSyncConflict).toHaveBeenCalledWith("note-1");
  });

  it("does not clear a keep-local conflict until the server increments the revision", async () => {
    apiMock.updateNoteConfirmed.mockResolvedValue(remoteNote({ version: 8 }));

    await expect(resolveNoteConflict(conflictItem(), "keep-local")).rejects.toThrow("服务器尚未确认");
    expect(discardResolvedQueueItems).not.toHaveBeenCalled();
  });

  it("automatically preserves only the newest queued write as a copy before accepting the server version", async () => {
    const older = conflictItem({ id: "queue-old", enqueuedAt: 100 });
    const newer = conflictItem({
      id: "queue-new",
      enqueuedAt: 200,
      body: {
        title: "最后提交的标题",
        content: "最后提交的正文",
        contentText: "最后提交的正文",
        contentFormat: "markdown",
        version: 4,
      },
      localPayload: {
        title: "最后提交的标题",
        content: "最后提交的正文",
        contentText: "最后提交的正文",
        contentFormat: "markdown",
        version: 4,
      },
    });
    const copy = remoteNote({
      id: getConflictCopyId(newer.id),
      title: "最后提交的标题（冲突副本 2026-07-28 17:30）",
      content: "最后提交的正文",
      contentText: "最后提交的正文",
      version: 1,
    });
    apiMock.createNoteConfirmed.mockResolvedValue(copy);
    const resolvedEvents = vi.fn();
    window.addEventListener("nowen:note-conflict-auto-resolved", resolvedEvents);

    await expect(resolveQueuedNoteConflicts([older, newer])).resolves.toEqual({
      attempted: 1,
      resolved: 1,
      failed: 0,
      failures: [],
    });

    expect(apiMock.getNote).toHaveBeenCalledTimes(1);
    expect(apiMock.createNoteConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      id: getConflictCopyId(newer.id),
      title: expect.stringContaining("最后提交的标题（冲突副本"),
      content: "最后提交的正文",
    }));
    expect(apiMock.updateNoteConfirmed).not.toHaveBeenCalled();
    expect(resolvedEvents).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({
        note: expect.objectContaining({ id: "note-1" }),
        resolvedLocal: expect.objectContaining({
          title: "最后提交的标题",
          content: "最后提交的正文",
        }),
      }),
    }));
    window.removeEventListener("nowen:note-conflict-auto-resolved", resolvedEvents);
  });

  it("emits the exact draft payload copied before conflict cleanup", async () => {
    const draft = {
      noteId: "note-1",
      editorMode: "tiptap" as const,
      title: "防抖草稿标题",
      content: "防抖草稿正文",
      contentText: "防抖草稿正文",
      baseVersion: 3,
      savedAt: Date.now(),
    };
    loadDraft.mockReturnValue(draft);
    clearDraft.mockImplementationOnce(() => loadDraft.mockReturnValue(null));
    apiMock.createNoteConfirmed.mockResolvedValue(remoteNote({ id: "copy-1", version: 1 }));
    const resolvedEvents = vi.fn();
    window.addEventListener("nowen:note-conflict-auto-resolved", resolvedEvents);

    await resolveQueuedNoteConflicts([conflictItem()]);

    expect(apiMock.createNoteConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining("防抖草稿标题"),
      content: "防抖草稿正文",
    }));
    expect(resolvedEvents).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({
        resolvedLocal: expect.objectContaining({ content: "防抖草稿正文" }),
      }),
    }));
    window.removeEventListener("nowen:note-conflict-auto-resolved", resolvedEvents);
  });

  it("creates a recoverable conflict copy with a stable id before accepting the server version", async () => {
    const item = conflictItem();
    const copyId = getConflictCopyId(item.id);
    const copy = remoteNote({ id: copyId, title: "本地标题（冲突副本 2026-07-14 10:00）", version: 1 });
    apiMock.createNoteConfirmed.mockResolvedValue(copy);

    const result = await resolveNoteConflict(item, "use-server");

    expect(copyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(getConflictCopyId(item.id)).toBe(copyId);
    expect(apiMock.createNoteConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      id: copyId,
      notebookId: "book-1",
      title: expect.stringContaining("本地标题（冲突副本"),
      content: "本地正文",
    }));
    expect(result.note.id).toBe("note-1");
    expect(result.conflictCopy).toBe(copy);
    expect(discardResolvedQueueItems).toHaveBeenCalledWith(item);
  });

  it("recovers an already committed deterministic conflict copy after a lost response", async () => {
    const item = conflictItem();
    const copyId = getConflictCopyId(item.id);
    const conflictError = Object.assign(new Error("duplicate"), {
      status: 409,
      code: "NOTE_ID_CONFLICT",
    });
    const existingCopy = remoteNote({
      id: copyId,
      title: "已存在的冲突副本",
      content: "本地正文",
      contentText: "本地正文",
      version: 1,
    });
    apiMock.createNoteConfirmed.mockRejectedValue(conflictError);
    apiMock.getNote
      .mockResolvedValueOnce(remoteNote())
      .mockResolvedValueOnce(existingCopy);

    const result = await resolveNoteConflict(item, "use-server");

    expect(apiMock.getNote).toHaveBeenNthCalledWith(2, copyId);
    expect(apiMock.updateNoteConfirmed).not.toHaveBeenCalled();
    expect(result.conflictCopy).toBe(existingCopy);
    expect(discardResolvedQueueItems).toHaveBeenCalledWith(item);
  });

  it("updates the same deterministic copy when later local input arrives", async () => {
    const item = conflictItem();
    const copyId = getConflictCopyId(item.id);
    const conflictError = Object.assign(new Error("duplicate"), {
      status: 409,
      code: "NOTE_ID_CONFLICT",
    });
    const existingCopy = remoteNote({ id: copyId, title: "已存在的冲突副本", version: 1 });
    const refreshedCopy = remoteNote({
      id: copyId,
      title: "已存在的冲突副本",
      content: "本地正文",
      contentText: "本地正文",
      version: 2,
    });
    apiMock.createNoteConfirmed.mockRejectedValue(conflictError);
    apiMock.getNote
      .mockResolvedValueOnce(remoteNote())
      .mockResolvedValueOnce(existingCopy);
    apiMock.updateNoteConfirmed.mockResolvedValue(refreshedCopy);

    const result = await resolveNoteConflict(item, "use-server");

    expect(apiMock.updateNoteConfirmed).toHaveBeenCalledWith(copyId, expect.objectContaining({
      content: "本地正文",
      contentText: "本地正文",
      version: 1,
    }));
    expect(result.conflictCopy).toBe(refreshedCopy);
  });

  it("keeps a newer local payload after recovering a copy whose response was lost", async () => {
    const item = conflictItem();
    const conflictError = Object.assign(new Error("duplicate"), {
      status: 409,
      code: "NOTE_ID_CONFLICT",
    });
    apiMock.createNoteConfirmed.mockRejectedValue(conflictError);
    apiMock.getNote
      .mockResolvedValueOnce(remoteNote())
      .mockResolvedValueOnce(remoteNote({
        id: getConflictCopyId(item.id),
        content: "本地正文",
        contentText: "本地正文",
        version: 1,
      }));
    discardResolvedQueueItems.mockReturnValue({ discarded: false, remainingForNote: true });

    await expect(resolveNoteConflict(item, "use-server")).rejects.toThrow("本地内容已更新");
    expect(clearDraft).not.toHaveBeenCalled();
    expect(clearNoteSyncConflict).not.toHaveBeenCalled();
  });

  it("does not clear a newer local payload after an older conflict copy is acknowledged", async () => {
    const item = conflictItem();
    let confirmCopy!: (note: Note) => void;
    apiMock.createNoteConfirmed.mockReturnValue(new Promise<Note>((resolve) => {
      confirmCopy = resolve;
    }));

    const resolving = resolveNoteConflict(item, "use-server");
    await vi.waitFor(() => expect(apiMock.createNoteConfirmed).toHaveBeenCalledTimes(1));
    discardResolvedQueueItems.mockReturnValue({ discarded: false, remainingForNote: true });
    confirmCopy(remoteNote({ id: getConflictCopyId(item.id), version: 1 }));

    await expect(resolving).rejects.toThrow("本地内容已更新");
    expect(clearDraft).not.toHaveBeenCalled();
    expect(clearNoteSyncConflict).not.toHaveBeenCalled();
  });

  it("does not accept the server version while a later local edit is still queued", async () => {
    discardResolvedQueueItems.mockReturnValue({ discarded: true, remainingForNote: true });

    await expect(resolveNoteConflict(conflictItem(), "use-server")).rejects.toThrow("本地内容已更新");
    expect(clearDraft).not.toHaveBeenCalled();
    expect(clearNoteSyncConflict).not.toHaveBeenCalled();
  });

  it("keeps every local artifact when the confirmed copy write fails", async () => {
    apiMock.createNoteConfirmed.mockRejectedValue(new Error("offline"));

    await expect(resolveNoteConflict(conflictItem(), "use-server")).rejects.toThrow("offline");
    expect(discardResolvedQueueItems).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
    expect(clearNoteSyncConflict).not.toHaveBeenCalled();
  });

  it("clears the source conflict generation when its generated copy is deleted", () => {
    const item = conflictItem();
    getQueue.mockReturnValue([item]);

    expect(discardConflictStateForDeletedCopy(getConflictCopyId(item.id))).toBe("note-1");
    expect(discardResolvedQueueItems).toHaveBeenCalledWith(item);
    expect(clearDraft).toHaveBeenCalledWith("note-1");
    expect(clearNoteSyncConflict).toHaveBeenCalledWith("note-1");
  });

  it("reasserts the queued UI state while a pending conflict remains durable", () => {
    vi.useFakeTimers();
    const item = conflictItem();
    getQueue.mockReturnValue([item]);
    const queuedEvents = vi.fn();
    window.addEventListener("nowen:offline-queued", queuedEvents);

    window.dispatchEvent(new CustomEvent("nowen:note-sync-pending", {
      detail: { noteId: "note-1", queued: true },
    }));
    vi.runAllTimers();

    expect(queuedEvents).toHaveBeenCalledTimes(2);
    window.removeEventListener("nowen:offline-queued", queuedEvents);
    vi.useRealTimers();
  });
});
