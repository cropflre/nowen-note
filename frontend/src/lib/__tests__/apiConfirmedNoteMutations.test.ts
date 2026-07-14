// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { clearQueue, getQueueLength } from "@/lib/offlineQueue";

function serverNote() {
  return {
    id: "note-1",
    userId: "user-1",
    notebookId: "book-1",
    workspaceId: null,
    title: "confirmed",
    content: "body",
    contentText: "body",
    contentFormat: "markdown",
    version: 9,
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    trashedAt: null,
    sortOrder: 0,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T02:00:00.000Z",
  };
}

describe("server-confirmed note mutations", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nowen-server-url", "https://sync.test");
    localStorage.setItem("nowen-token", "token");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    clearQueue();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  it("still performs a real request while offline instead of creating an optimistic queue item", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(serverNote()),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.updateNoteConfirmed("note-1", {
      title: "confirmed",
      content: "body",
      contentText: "body",
      contentFormat: "markdown",
      version: 8,
    })).resolves.toMatchObject({ id: "note-1", version: 9 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sync.test/api/notes/note-1",
      expect.objectContaining({ method: "PUT", signal: expect.anything() }),
    );
    expect(getQueueLength()).toBe(0);
  });
});
