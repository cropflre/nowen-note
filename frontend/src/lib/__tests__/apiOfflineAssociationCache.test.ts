import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localStoreMocks = vi.hoisted(() => ({
  deleteHabit: vi.fn(),
  deleteTask: vi.fn(),
  deleteTaskDependency: vi.fn().mockResolvedValue(undefined),
  deleteTaskReminder: vi.fn().mockResolvedValue(undefined),
  getHabits: vi.fn().mockResolvedValue([]),
  getTaskDependencies: vi.fn().mockResolvedValue([]),
  getTaskReminder: vi.fn(),
  getTasks: vi.fn().mockResolvedValue([]),
  putHabits: vi.fn().mockResolvedValue(undefined),
  putTaskDependencies: vi.fn().mockResolvedValue(undefined),
  putTaskReminders: vi.fn().mockResolvedValue(undefined),
  putTasks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/localStore", () => localStoreMocks);

import { api, setCurrentWorkspace } from "@/lib/api";
import { clearQueue, getQueue } from "@/lib/offlineQueue";

describe("offline association mutations", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nowen-server-url", "https://sync.test");
    localStorage.setItem("nowen-token", "token");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    clearQueue();
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.unstubAllGlobals();
  });

  it("caches offline dependency creation and deletion without writing a task", async () => {
    await api.createTaskDependency({ predecessorTaskId: "task-a", successorTaskId: "task-b" });
    await api.createTaskReminder("task-a", 30);

    await vi.waitFor(() => expect(localStoreMocks.putTaskDependencies).toHaveBeenCalledOnce());
    const [dependencies] = localStoreMocks.putTaskDependencies.mock.calls[0];
    expect(dependencies).toMatchObject([{
      predecessorTaskId: "task-a",
      successorTaskId: "task-b",
      type: "finish_to_start",
    }]);

    const dependencyId = getQueue()[0].noteId;
    await api.deleteTaskDependency(dependencyId);
    await vi.waitFor(() => expect(localStoreMocks.deleteTaskDependency).toHaveBeenCalledWith(dependencyId));

    expect(getQueue().map((item) => item.type)).toEqual([
      "createTaskDependency",
      "createTaskReminder",
      "deleteTaskDependency",
    ]);
    expect(localStoreMocks.getTasks).not.toHaveBeenCalled();
    expect(localStoreMocks.putTasks).not.toHaveBeenCalled();
    expect(localStoreMocks.deleteTask).not.toHaveBeenCalled();
  });

  it("queues task toggle with the intended completion state", async () => {
    localStoreMocks.getTasks.mockResolvedValueOnce([{
      id: "task-a",
      isCompleted: 0,
      status: "todo",
    }]);

    await api.toggleTask("task-a", true);

    expect(getQueue()).toMatchObject([{
      type: "toggleTask",
      noteId: "task-a",
      body: { isCompleted: true },
    }]);
  });

  it("persists offline reminder create, update, and delete before resolving", async () => {
    const created = await api.createTaskReminder("task-a", 30);
    expect(localStoreMocks.putTaskReminders).toHaveBeenCalledWith([
      expect.objectContaining({ id: created.id, taskId: "task-a", offsetMinutes: 30, enabled: 1 }),
    ], null);

    localStoreMocks.getTaskReminder.mockResolvedValueOnce({
      ...created,
      enabled: 1,
      updatedAt: "2026-07-21T10:00:00.000Z",
    });
    await api.updateTaskReminder(created.id, { enabled: false, snoozedUntil: "2026-07-21T13:00:00.000Z" });
    expect(localStoreMocks.putTaskReminders).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: created.id, enabled: false, snoozedUntil: "2026-07-21T13:00:00.000Z" }),
    ], null);

    await api.deleteTaskReminder(created.id);
    expect(localStoreMocks.deleteTaskReminder).toHaveBeenCalledWith(created.id);
  });

  it("clears optimistic association caches when an unsent offline task is cancelled", async () => {
    const task = await api.createTask({ title: "temporary task" });
    const dependency = await api.createTaskDependency({ predecessorTaskId: task.id, successorTaskId: "task-existing" });
    const reminder = await api.createTaskReminder(task.id, 30);

    await api.deleteTask(task.id);

    expect(getQueue()).toEqual([]);
    expect(localStoreMocks.deleteTaskDependency).toHaveBeenCalledWith(dependency.id);
    expect(localStoreMocks.deleteTaskReminder).toHaveBeenCalledWith(reminder.id);
  });

  it("reuses the first task create envelope after its response is lost", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network lost"));
    vi.stubGlobal("fetch", fetchMock);

    const created = await api.createTask({ title: "lost response" });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const queued = getQueue()[0];
    expect(headers["Idempotency-Key"]).toBe(queued.id);
    expect(requestBody.id).toBe(queued.noteId);
    expect(created.id).toBe(queued.noteId);
  });

  it("queues workspace task and habit creates using their query URLs", async () => {
    setCurrentWorkspace("workspace-1");
    await api.createTask({ title: "workspace task" });
    await api.createHabit({ title: "workspace habit" });

    expect(getQueue()).toMatchObject([
      { type: "createTask", url: "/tasks?workspaceId=workspace-1" },
      { type: "createHabit", url: "/habits?workspaceId=workspace-1" },
    ]);
  });

  it("does not queue task reordering while offline", async () => {
    await expect(api.reorderTasks([{ id: "task-a", sortOrder: 1 }])).rejects.toThrow();
    expect(getQueue()).toHaveLength(0);
  });

  it("updates cache after acknowledged online deletes", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))));

    await api.deleteTask("task-a");
    await api.deleteHabit("habit-a");
    await api.deleteTaskReminder("reminder-a");

    expect(localStoreMocks.deleteTask).toHaveBeenCalledWith("task-a");
    expect(localStoreMocks.deleteHabit).toHaveBeenCalledWith("habit-a");
    expect(localStoreMocks.deleteTaskReminder).toHaveBeenCalledWith("reminder-a");
  });

  it("rejects offline optimistic success when the queue cannot persist", async () => {
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key: string, value: string) {
      if (key.startsWith("nowen-offline-queue:v2")) throw new DOMException("quota", "QuotaExceededError");
      return originalSetItem.call(localStorage, key, value);
    });

    await expect(api.createTask({ title: "must not disappear" })).rejects.toThrow("quota");
  });
});