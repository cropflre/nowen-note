import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";
import type { OfflineQueueItem } from "@/lib/offlineQueue";

const apiMock = vi.hoisted(() => ({
  getNote: vi.fn(),
  getNoteSlim: vi.fn(),
  updateNote: vi.fn(),
  createNote: vi.fn(),
}));
const discardNoteQueueItems = vi.hoisted(() => vi.fn());
const clearDraft = vi.hoisted(() => vi.fn());
const loadDraft = vi.hoisted(() => vi.fn());
const clearOfflineNoteSnapshot = vi.hoisted(() => vi.fn());
const clearNoteSyncConflict = vi.hoisted(() => vi.fn());
const runWithNoteConflictResolution = vi.hoisted(() => vi.fn(async (_id: string, task: () => Promise<unknown>) => task()));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/offlineQueue", () => ({ discardNoteQueueItems }));
vi.mock("@/lib/draftStorage", () => ({ clearDraft, loadDraft }));
vi.mock("@/lib/offlineRead", () => ({ clearOfflineNoteSnapshot }));
vi.mock("@/lib/noteSyncSafety", () => ({ clearNoteSyncConflict, runWithNoteConflictResolution }));

import { resolveNoteConflict } from "@/lib/conflictResolution";

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
    apiMock.getNoteSlim.mockImplementation(async (id: string) => ({ id, version: 1 }));
  });

  it("keeps the local version using the latest server revision and clears artifacts only after ACK", async () => {
    const updated = remoteNote({
      title: "本地标题",
      content: "本地正文",
      contentText: "本地正文",
      version: 9,
    });
    apiMock.updateNote.mockResolvedValue(updated);

    await expect(resolveNoteConflict(conflictItem(), "keep-local")).resolves.toEqual({ note: updated });

    expect(runWithNoteConflictResolution).toHaveBeenCalledWith("note-1", expect.any(Function));
    expect(apiMock.updateNote).toHaveBeenCalledWith("note-1", expect.objectContaining({
      title: "本地标题",
      content: "本地正文",
      version: 8,
    }));
    expect(discardNoteQueueItems).toHaveBeenCalledWith(["note-1"]);
    expect(clearDraft).toHaveBeenCalledWith("note-1");
    expect(clearNoteSyncConflict).toHaveBeenCalledWith("note-1");
  });

  it("does not clear a keep-local conflict until the server increments the revision", async () => {
    apiMock.updateNote.mockResolvedValue(remoteNote({ version: 8 }));

    await expect(resolveNoteConflict(conflictItem(), "keep-local")).rejects.toThrow("服务器尚未确认");
    expect(discardNoteQueueItems).not.toHaveBeenCalled();
  });

  it("creates and confirms a recoverable conflict copy before accepting the server version", async () => {
    const copy = remoteNote({ id: "copy-1", title: "本地标题（冲突副本 2026-07-14 10:00）", version: 1 });
    apiMock.createNote.mockResolvedValue(copy);

    const result = await resolveNoteConflict(conflictItem(), "use-server");

    expect(apiMock.createNote).toHaveBeenCalledWith(expect.objectContaining({
      notebookId: "book-1",
      title: expect.stringContaining("本地标题（冲突副本"),
      content: "本地正文",
    }));
    expect(apiMock.getNoteSlim).toHaveBeenCalledWith("copy-1");
    expect(result.note.id).toBe("note-1");
    expect(result.conflictCopy).toBe(copy);
    expect(discardNoteQueueItems).toHaveBeenCalledWith(["note-1"]);
  });

  it("keeps every local artifact when creating or confirming the conflict copy fails", async () => {
    apiMock.createNote.mockResolvedValue(remoteNote({ id: "copy-1" }));
    apiMock.getNoteSlim.mockRejectedValue(new Error("offline"));

    await expect(resolveNoteConflict(conflictItem(), "use-server")).rejects.toThrow("offline");
    expect(discardNoteQueueItems).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
    expect(clearNoteSyncConflict).not.toHaveBeenCalled();
  });
});
