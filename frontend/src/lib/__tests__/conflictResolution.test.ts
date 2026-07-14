import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";
import type { OfflineQueueItem } from "@/lib/offlineQueue";

const apiMock = vi.hoisted(() => ({
  getNote: vi.fn(),
  updateNoteConfirmed: vi.fn(),
  createNoteConfirmed: vi.fn(),
}));
const discardNoteQueueItems = vi.hoisted(() => vi.fn());
const clearDraft = vi.hoisted(() => vi.fn());
const loadDraft = vi.hoisted(() => vi.fn());
const clearOfflineNoteSnapshot = vi.hoisted(() => vi.fn());
const clearNoteSyncConflict = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/offlineQueue", () => ({ discardNoteQueueItems }));
vi.mock("@/lib/draftStorage", () => ({ clearDraft, loadDraft }));
vi.mock("@/lib/offlineRead", () => ({ clearOfflineNoteSnapshot }));
vi.mock("@/lib/noteSyncSafety", () => ({ clearNoteSyncConflict }));

import {
  getConflictCopyId,
  resolveNoteConflict,
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

function conflictItem(): OfflineQueueItem {
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
  };
}

describe("resolveNoteConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadDraft.mockReturnValue(null);
    apiMock.getNote.mockResolvedValue(remoteNote());
  });

  it("keeps the local version using a non-queued confirmed write and clears only after ACK", async () => {
    const updated = remoteNote({
      title: "本地标题",
      content: "本地正文",
      contentText: "本地正文",
      version: 9,
    });
    apiMock.updateNoteConfirmed.mockResolvedValue(updated);

    await expect(resolveNoteConflict(conflictItem(), "keep-local")).resolves.toEqual({ note: updated });

    expect(apiMock.updateNoteConfirmed).toHaveBeenCalledWith("note-1", expect.objectContaining({
      title: "本地标题",
      content: "本地正文",
      version: 8,
    }));
    expect(discardNoteQueueItems).toHaveBeenCalledWith(["note-1"]);
    expect(clearDraft).toHaveBeenCalledWith("note-1");
    expect(clearNoteSyncConflict).toHaveBeenCalledWith("note-1");
  });

  it("does not clear a keep-local conflict until the server increments the revision", async () => {
    apiMock.updateNoteConfirmed.mockResolvedValue(remoteNote({ version: 8 }));

    await expect(resolveNoteConflict(conflictItem(), "keep-local")).rejects.toThrow("服务器尚未确认");
    expect(discardNoteQueueItems).not.toHaveBeenCalled();
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
    expect(discardNoteQueueItems).toHaveBeenCalledWith(["note-1"]);
  });

  it("recovers an already committed deterministic conflict copy after a lost response", async () => {
    const item = conflictItem();
    const copyId = getConflictCopyId(item.id);
    const conflictError = Object.assign(new Error("duplicate"), {
      status: 409,
      code: "NOTE_ID_CONFLICT",
    });
    const existingCopy = remoteNote({ id: copyId, title: "已存在的冲突副本", version: 1 });
    apiMock.createNoteConfirmed.mockRejectedValue(conflictError);
    apiMock.getNote
      .mockResolvedValueOnce(remoteNote())
      .mockResolvedValueOnce(existingCopy);

    const result = await resolveNoteConflict(item, "use-server");

    expect(apiMock.getNote).toHaveBeenNthCalledWith(2, copyId);
    expect(result.conflictCopy).toBe(existingCopy);
    expect(discardNoteQueueItems).toHaveBeenCalledWith(["note-1"]);
  });

  it("keeps every local artifact when the confirmed copy write fails", async () => {
    apiMock.createNoteConfirmed.mockRejectedValue(new Error("offline"));

    await expect(resolveNoteConflict(conflictItem(), "use-server")).rejects.toThrow("offline");
    expect(discardNoteQueueItems).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
    expect(clearNoteSyncConflict).not.toHaveBeenCalled();
  });
});
