import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQueue,
  discardNoteQueueItems,
  enqueue,
  flushQueue,
  generateLocalNoteId,
  getQueue,
  getQueueLength,
  inferMutationType,
  retryQueueItem,
  updateItem,
} from "@/lib/offlineQueue";

function seedIdentity() {
  localStorage.setItem("nowen-server-url", "http://sync-test.local");
  localStorage.setItem("nowen-token", "test.token.value");
}

function enqueueUpdate(noteId = "note-1", version = 1) {
  enqueue({
    type: "updateNote",
    noteId,
    url: `/notes/${noteId}`,
    method: "PUT",
    body: {
      title: "offline title",
      content: "{}",
      contentText: "offline title",
      contentFormat: "markdown",
      version,
    },
  });
}

describe("offlineQueue reliability", () => {
  beforeEach(() => {
    localStorage.clear();
    seedIdentity();
    clearQueue();
  });

  it("marks a VERSION_CONFLICT update as conflict without replaying currentVersion", async () => {
    enqueueUpdate("note-1", 1);
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: { code: "VERSION_CONFLICT", currentVersion: 5 },
    });

    const result = await flushQueue(fetchFn);
    const queue = getQueue();

    expect(result).toEqual({ success: 0, failed: 1, remaining: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "/notes/note-1",
      "PUT",
      expect.objectContaining({ version: 1 }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(queue[0]).toEqual(expect.objectContaining({
      conflict: true,
      blocked: true,
      retryable: false,
      errorCode: "VERSION_CONFLICT",
      serverVersion: 5,
      retryCount: 0,
    }));
    expect(queue[0].localPayload).toEqual(expect.objectContaining({ version: 1, title: "offline title" }));
  });

  it("does not automatically process an existing conflict item", async () => {
    enqueueUpdate("note-2", 2);
    await flushQueue(vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: { code: "VERSION_CONFLICT", currentVersion: 8 },
    }));

    const fetchFn = vi.fn();
    const result = await flushQueue(fetchFn);

    expect(result).toEqual({ success: 0, failed: 0, remaining: 1 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(retryQueueItem(getQueue()[0].id)).toBe(false);
  });

  it("lets a later trash intent replace an earlier conflicted update", async () => {
    enqueueUpdate("note-trash", 2);
    await flushQueue(vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: { code: "VERSION_CONFLICT", currentVersion: 5 },
    }));

    enqueue({
      type: "updateNote",
      noteId: "note-trash",
      url: "/notes/note-trash",
      method: "PUT",
      body: { isTrashed: 1 },
    });

    expect(getQueue()).toEqual([
      expect.objectContaining({
        noteId: "note-trash",
        type: "updateNote",
        body: { isTrashed: 1 },
      }),
    ]);
    expect(getQueue()[0].conflict).toBeUndefined();
  });

  it("lets a permanent delete intent replace an earlier conflicted update", async () => {
    enqueueUpdate("note-delete", 3);
    await flushQueue(vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: { code: "VERSION_CONFLICT", currentVersion: 6 },
    }));

    enqueue({
      type: "deleteNote",
      noteId: "note-delete",
      url: "/notes/note-delete",
      method: "DELETE",
      body: null,
    });

    expect(getQueue()).toEqual([
      expect.objectContaining({ noteId: "note-delete", type: "deleteNote" }),
    ]);
  });

  it("discards only queue items belonging to acknowledged deleted notes", () => {
    enqueueUpdate("deleted-a", 1);
    enqueueUpdate("kept-b", 1);

    expect(discardNoteQueueItems(["deleted-a"])).toBe(1);
    expect(getQueue().map((item) => item.noteId)).toEqual(["kept-b"]);
  });

  it("keeps normal server errors retryable", async () => {
    enqueueUpdate("note-4", 4);
    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, data: {} });

    const result = await flushQueue(fetchFn);
    const queue = getQueue();

    expect(result).toEqual({ success: 0, failed: 1, remaining: 1 });
    expect(queue[0].retryCount).toBe(1);
    expect(queue[0].retryable).toBe(true);
    expect(queue[0].body).toEqual(expect.objectContaining({ version: 4 }));
  });

  it("removes successful queued updates only after the server ACK", async () => {
    enqueueUpdate("note-5", 5);
    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, data: { id: "note-5", version: 6 } });

    const result = await flushQueue(fetchFn);

    expect(result).toEqual({ success: 1, failed: 0, remaining: 0 });
    expect(getQueueLength()).toBe(0);
  });

  it("makes concurrent manual and automatic flush callers await the same in-flight work", async () => {
    enqueueUpdate("note-race", 1);
    let resolveRequest: ((value: { ok: boolean; status: number; data: any }) => void) | undefined;
    const fetchFn = vi.fn(() => new Promise<{ ok: boolean; status: number; data: any }>((resolve) => {
      resolveRequest = resolve;
    }));

    const automatic = flushQueue(fetchFn);
    const manual = flushQueue(fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(getQueueLength()).toBe(1);

    resolveRequest?.({ ok: true, status: 200, data: { id: "note-race", version: 2 } });
    await expect(Promise.all([automatic, manual])).resolves.toEqual([
      { success: 1, failed: 0, remaining: 0 },
      { success: 1, failed: 0, remaining: 0 },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps task and habit delete intents when their create request is already in flight", async () => {
    for (const [createType, deleteType, createUrl, deleteUrl] of [
      ["createTask", "deleteTask", "/tasks", "/tasks/task-in-flight"],
      ["createHabit", "deleteHabit", "/habits", "/habits/habit-in-flight"],
    ] as const) {
      const id = createType === "createTask" ? "task-in-flight" : "habit-in-flight";
      enqueue({
        type: createType,
        noteId: id,
        url: createUrl,
        method: "POST",
        body: { id, title: "offline" },
      });

      let resolveRequest: ((value: { ok: boolean; status: number; data: unknown }) => void) | undefined;
      const fetchFn = vi.fn(() => new Promise<{ ok: boolean; status: number; data: unknown }>((resolve) => {
        resolveRequest = resolve;
      }));
      const firstFlush = flushQueue(fetchFn);

      enqueue({ type: deleteType, noteId: id, url: deleteUrl, method: "DELETE", body: null });
      expect(getQueue().map((item) => item.type)).toEqual([createType, deleteType]);

      resolveRequest?.({ ok: true, status: 201, data: { id } });
      await expect(firstFlush).resolves.toEqual({ success: 1, failed: 0, remaining: 1 });
      await expect(flushQueue(vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }))).resolves.toEqual({ success: 1, failed: 0, remaining: 0 });
      clearQueue();
    }
  });

  it("cancels unsent task associations when an offline-created task is deleted", () => {
    enqueue({
      type: "createTask",
      noteId: "task-local",
      url: "/tasks",
      method: "POST",
      body: { id: "task-local", title: "offline" },
    });
    enqueue({
      type: "createTaskDependency",
      noteId: "dependency-local",
      url: "/task-dependencies",
      method: "POST",
      body: { id: "dependency-local", predecessorTaskId: "task-local", successorTaskId: "task-existing" },
    });
    enqueue({
      type: "deleteTaskDependency",
      noteId: "dependency-local",
      url: "/task-dependencies/dependency-local",
      method: "DELETE",
      body: null,
    });
    enqueue({
      type: "createTaskReminder",
      noteId: "reminder-local",
      url: "/task-reminders/task-local",
      method: "POST",
      body: { id: "reminder-local", offsetMinutes: 30 },
    });
    enqueue({
      type: "updateTaskReminder",
      noteId: "reminder-local",
      url: "/task-reminders/reminder-local",
      method: "PUT",
      body: { enabled: false },
    });

    const result = enqueue({
      type: "deleteTask",
      noteId: "task-local",
      url: "/tasks/task-local",
      method: "DELETE",
      body: null,
    });

    expect(getQueue()).toEqual([]);
    expect(result.cancelledTaskAssociationIds).toEqual({
      dependencyIds: ["dependency-local"],
      reminderIds: ["reminder-local"],
    });
  });

  it("preserves a permanent client failure and its local payload instead of dropping it", async () => {
    enqueueUpdate("missing-note", 3);
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      data: { code: "NOT_FOUND", error: "Note not found" },
    });

    const result = await flushQueue(fetchFn);
    const item = getQueue()[0];

    expect(result).toEqual({ success: 0, failed: 1, remaining: 1 });
    expect(item).toEqual(expect.objectContaining({
      blocked: true,
      retryable: false,
      errorCode: "NOTE_NOT_FOUND",
    }));
    expect(item.localPayload).toEqual(expect.objectContaining({ version: 3, title: "offline title" }));
  });

  it("allows a manually retried non-conflict item to run again", async () => {
    enqueueUpdate("retry-note", 1);
    const itemId = getQueue()[0].id;
    updateItem(itemId, {
      blocked: true,
      retryable: true,
      errorCode: "NETWORK_ERROR",
      message: "offline",
      retryCount: 10,
    });

    expect(retryQueueItem(itemId)).toBe(true);
    expect(getQueue()[0]).toEqual(expect.objectContaining({ retryCount: 0 }));
    expect(getQueue()[0].blocked).toBeUndefined();

    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, data: { version: 2 } });
    await expect(flushQueue(fetchFn)).resolves.toEqual({ success: 1, failed: 0, remaining: 0 });
  });

  it("uses an RFC 4122 UUID for offline-created note ids", () => {
    expect(generateLocalNoteId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("treats an existing UUID create as an idempotent success", async () => {
    const noteId = generateLocalNoteId();
    enqueue({
      type: "createNote",
      noteId,
      url: "/notes",
      method: "POST",
      body: { id: noteId, notebookId: "nb-1", title: "offline note" },
    });

    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: { code: "NOTE_ID_CONFLICT" },
    });

    await expect(flushQueue(fetchFn)).resolves.toEqual({ success: 1, failed: 0, remaining: 0 });
    expect(getQueueLength()).toBe(0);
  });

  it("recognizes task and habit mutations for offline replay", () => {
    expect(inferMutationType("/tasks", "POST")).toBe("createTask");
    expect(inferMutationType("/tasks/task-1/toggle", "PATCH")).toBe("toggleTask");
    expect(inferMutationType("/tasks/reorder/batch", "PUT")).toBeNull();
    expect(inferMutationType("/habits", "POST")).toBe("createHabit");
    expect(inferMutationType("/habits/habit-1/archive", "PATCH")).toBe("archiveHabit");
    expect(inferMutationType("/habits/habit-1/checkins", "POST")).toBe("checkInHabit");
  });

  it("replays an offline task creation with its client UUID", async () => {
    const taskId = generateLocalNoteId();
    enqueue({
      type: "createTask",
      noteId: taskId,
      url: "/tasks",
      method: "POST",
      body: { id: taskId, title: "offline task" },
    });

    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: true, status: 201, data: { id: taskId } });
    await expect(flushQueue(fetchFn)).resolves.toEqual({ success: 1, failed: 0, remaining: 0 });
    expect(fetchFn).toHaveBeenCalledWith(
      "/tasks",
      "POST",
      { id: taskId, title: "offline task" },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });
});
