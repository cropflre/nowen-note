import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearQueue, enqueue, flushQueue, getQueue, getQueueLength } from "@/lib/offlineQueue";

function seedIdentity() {
  localStorage.setItem("nowen-server-url", "http://sync-test.local");
  localStorage.setItem("nowen-token", "test.token.value");
}

describe("offlineQueue conflict handling", () => {
  beforeEach(() => {
    localStorage.clear();
    seedIdentity();
    clearQueue();
  });

  it("marks a VERSION_CONFLICT update as conflict without replaying currentVersion", async () => {
    enqueue({
      type: "updateNote",
      noteId: "note-1",
      url: "/notes/note-1",
      method: "PUT",
      body: {
        title: "offline title",
        content: "{}",
        contentText: "offline title",
        contentFormat: "markdown",
        version: 1,
      },
    });

    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, data: { code: "VERSION_CONFLICT", currentVersion: 5 } });

    const result = await flushQueue(fetchFn);
    const queue = getQueue();

    expect(result).toEqual({ success: 0, failed: 1, remaining: 1 });
    expect(getQueueLength()).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenNthCalledWith(1, "/notes/note-1", "PUT", expect.objectContaining({ version: 1 }));
    expect(queue[0]).toEqual(expect.objectContaining({
      conflict: true,
      errorCode: "VERSION_CONFLICT",
      serverVersion: 5,
      retryCount: 0,
    }));
    expect(queue[0].body).toEqual(expect.objectContaining({ version: 1, title: "offline title", contentFormat: "markdown" }));
    expect(queue[0].localPayload).toEqual(expect.objectContaining({ version: 1, title: "offline title", contentFormat: "markdown" }));
  });

  it("does not automatically process an existing conflict item", async () => {
    enqueue({
      type: "updateNote",
      noteId: "note-2",
      url: "/notes/note-2",
      method: "PUT",
      body: {
        title: "offline title",
        content: "{}",
        contentText: "offline title",
        contentFormat: "markdown",
        version: 2,
      },
    });

    await flushQueue(vi.fn().mockResolvedValueOnce({ ok: false, status: 409, data: { code: "VERSION_CONFLICT", currentVersion: 8 } }));
    const fetchFn = vi.fn();

    const result = await flushQueue(fetchFn);
    const queue = getQueue();

    expect(result).toEqual({ success: 0, failed: 0, remaining: 1 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(queue).toHaveLength(1);
    expect(queue[0].retryCount).toBe(0);
    expect(queue[0].body).toEqual(expect.objectContaining({ version: 2, contentFormat: "markdown" }));
  });

  it("keeps the queued update when a 409 response has no currentVersion", async () => {
    enqueue({
      type: "updateNote",
      noteId: "note-3",
      url: "/notes/note-3",
      method: "PUT",
      body: {
        title: "offline title",
        content: "{}",
        contentText: "offline title",
        contentFormat: "markdown",
        version: 3,
      },
    });

    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: false, status: 409, data: {} });

    const result = await flushQueue(fetchFn);
    const queue = getQueue();

    expect(result).toEqual({ success: 0, failed: 1, remaining: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(queue[0].retryCount).toBe(0);
    expect(queue[0]).toEqual(expect.objectContaining({
      conflict: true,
      errorCode: "VERSION_CONFLICT",
    }));
    expect(queue[0].body).toEqual(expect.objectContaining({ version: 3, contentFormat: "markdown" }));
  });

  it("keeps normal server errors retryable", async () => {
    enqueue({
      type: "updateNote",
      noteId: "note-4",
      url: "/notes/note-4",
      method: "PUT",
      body: {
        title: "offline title",
        content: "{}",
        contentText: "offline title",
        contentFormat: "markdown",
        version: 4,
      },
    });

    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, data: {} });

    const result = await flushQueue(fetchFn);
    const queue = getQueue();

    expect(result).toEqual({ success: 0, failed: 1, remaining: 1 });
    expect(queue[0]).not.toHaveProperty("conflict", true);
    expect(queue[0].retryCount).toBe(1);
    expect(queue[0].body).toEqual(expect.objectContaining({ version: 4, contentFormat: "markdown" }));
  });

  it("removes successful queued updates", async () => {
    enqueue({
      type: "updateNote",
      noteId: "note-5",
      url: "/notes/note-5",
      method: "PUT",
      body: {
        title: "offline title",
        content: "{}",
        contentText: "offline title",
        version: 5,
      },
    });

    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, data: { id: "note-5", version: 6 } });

    const result = await flushQueue(fetchFn);

    expect(result).toEqual({ success: 1, failed: 0, remaining: 0 });
    expect(getQueueLength()).toBe(0);
  });
});
