import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Habit,
  HabitCheckin,
  HabitStats,
  Task,
  TaskFilter,
  TaskStats,
} from "@/types";
import {
  deriveOfflineTaskStats,
  filterOfflineTasks,
  installTaskOfflineApi,
} from "@/lib/taskOfflineApi";

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value,
  });
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    userId: "user-1",
    workspaceId: null,
    title: "任务",
    description: "",
    priority: 2,
    dueDate: null,
    dueAt: null,
    startDate: null,
    noteId: null,
    parentId: null,
    isCompleted: 0,
    completedAt: null,
    sortOrder: 0,
    projectId: null,
    status: "todo",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function habit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: "habit-1",
    userId: "user-1",
    workspaceId: null,
    title: "喝水",
    icon: "💧",
    color: "#6366f1",
    sortOrder: 0,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function createApi() {
  const taskStats: TaskStats = {
    total: 1,
    completed: 0,
    pending: 1,
    today: 0,
    overdue: 0,
    week: 0,
  };
  const habitStats: HabitStats = {
    totalCheckins: 0,
    checkinDays: 0,
    currentStreak: 0,
    successCount: 0,
    partialCount: 0,
    failureCount: 0,
    habitCount: 1,
  };

  const native = {
    getTasks: vi.fn(async (_filter?: TaskFilter, _noteId?: string, _projectId?: string) => [task()]),
    getTaskStats: vi.fn(async () => taskStats),
    createTask: vi.fn(async (data: Partial<Task>) => task({ id: "server-task", ...data })),
    updateTask: vi.fn(async (id: string, data: Partial<Task>) => ({
      task: task({ id, ...data }),
      generatedTask: null,
    })),
    toggleTask: vi.fn(async (id: string) => ({
      task: task({ id, isCompleted: 1, status: "done" }),
      generatedTask: null,
    })),
    deleteTask: vi.fn(async (_id: string) => ({ success: true })),
    getHabits: vi.fn(async (_includeArchived?: boolean, _checkinDate?: string) => [habit()]),
    getHabitStats: vi.fn(async (_includeArchived?: boolean, _checkinDate?: string) => habitStats),
    getHabitCheckinLog: vi.fn(async (_params?: { from?: string; to?: string; includeArchived?: boolean }) => []),
    createHabit: vi.fn(async (data: { title: string; icon?: string; color?: string; sortOrder?: number }) => (
      habit({ id: "server-habit", ...data })
    )),
    updateHabit: vi.fn(async (id: string, data: Partial<Habit>) => habit({ id, ...data })),
    archiveHabit: vi.fn(async (id: string, archived = true) => habit({
      id,
      archivedAt: archived ? "2026-08-01T01:00:00.000Z" : null,
    })),
    deleteHabit: vi.fn(async (_id: string) => ({ success: true })),
    checkInHabit: vi.fn(async (id: string, data: { status: "success" | "partial" | "failure"; note?: string; checkinDate?: string }) => ({
      id: "server-checkin",
      habitId: id,
      userId: "user-1",
      workspaceId: null,
      checkinDate: data.checkinDate || "2026-08-01",
      status: data.status,
      note: data.note || "",
      createdAt: "2026-08-01T01:00:00.000Z",
      updatedAt: "2026-08-01T01:00:00.000Z",
    } satisfies HabitCheckin)),
  };

  return { api: { ...native }, native };
}

beforeEach(() => {
  localStorage.clear();
  setOnline(true);
});

describe("taskOfflineApi", () => {
  it("uses cached task and habit lists when the network is unavailable", async () => {
    const { api, native } = createApi();
    installTaskOfflineApi(api, {
      getServerUrl: () => "https://example.test",
      getWorkspaceId: () => "personal",
      getScopeKey: () => "cache-fallback",
    });

    await api.getTasks("all");
    await api.getHabits(true, "2026-08-01");

    setOnline(false);
    native.getTasks.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    native.getHabits.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(api.getTasks("all")).resolves.toMatchObject([{ id: "task-1" }]);
    await expect(api.getHabits(true, "2026-08-01")).resolves.toMatchObject([{ id: "habit-1" }]);
  });

  it("queues an offline task create and remaps it after reconnect", async () => {
    setOnline(false);
    const { api, native } = createApi();
    const controller = installTaskOfflineApi(api, {
      getServerUrl: () => "https://example.test",
      getWorkspaceId: () => "personal",
      getScopeKey: () => "task-create",
    });

    const created = await api.createTask({ title: "离线创建" });
    expect(created.id).toMatch(/^local-task:/);
    expect(controller.pending()).toBe(1);
    expect(native.createTask).not.toHaveBeenCalled();

    setOnline(true);
    await controller.flush();

    expect(controller.pending()).toBe(0);
    expect(native.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "离线创建" }));
  });

  it("compacts updates into an offline create before replay", async () => {
    setOnline(false);
    const { api, native } = createApi();
    const controller = installTaskOfflineApi(api, {
      getServerUrl: () => "https://example.test",
      getWorkspaceId: () => "personal",
      getScopeKey: () => "task-compact",
    });

    const created = await api.createTask({ title: "初始标题" });
    await api.updateTask(created.id, { title: "最终标题", priority: 3 });
    expect(controller.pending()).toBe(1);

    setOnline(true);
    await controller.flush();

    expect(native.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "最终标题",
      priority: 3,
    }));
    expect(controller.pending()).toBe(0);
  });

  it("keeps a blocked local update on top of a newer server snapshot", async () => {
    const { api, native } = createApi();
    const controller = installTaskOfflineApi(api, {
      getServerUrl: () => "https://example.test",
      getWorkspaceId: () => "personal",
      getScopeKey: () => "pending-overlay",
    });

    await api.getTasks("all");
    setOnline(false);
    await api.updateTask("task-1", { title: "离线标题" });

    setOnline(true);
    native.updateTask.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403 }));
    native.getTasks.mockResolvedValueOnce([task({ title: "服务器旧标题" })]);

    await expect(api.getTasks("all")).resolves.toMatchObject([
      { id: "task-1", title: "离线标题" },
    ]);
    expect(controller.pending()).toBe(1);
  });

  it("can delete with the original local id after the create was remapped", async () => {
    setOnline(false);
    const { api, native } = createApi();
    const controller = installTaskOfflineApi(api, {
      getServerUrl: () => "https://example.test",
      getWorkspaceId: () => "personal",
      getScopeKey: () => "mapped-delete",
    });

    const created = await api.createTask({ title: "稍后删除" });
    setOnline(true);
    await controller.flush();

    setOnline(false);
    await api.deleteTask(created.id);
    native.getTasks.mockResolvedValueOnce([task({ id: "server-task", title: "稍后删除" })]);
    await expect(api.getTasks("all")).resolves.toEqual([]);

    setOnline(true);
    await controller.flush();
    expect(native.deleteTask).toHaveBeenCalledWith("server-task");
    expect(controller.pending()).toBe(0);
  });

  it("keeps an offline habit check-in and replays it after reconnect", async () => {
    const { api, native } = createApi();
    const controller = installTaskOfflineApi(api, {
      getServerUrl: () => "https://example.test",
      getWorkspaceId: () => "personal",
      getScopeKey: () => "habit-checkin",
    });

    await api.getHabits(true, "2026-08-01");
    setOnline(false);

    const checkin = await api.checkInHabit("habit-1", {
      status: "success",
      note: "完成",
      checkinDate: "2026-08-01",
    });
    expect(checkin.id).toMatch(/^local-checkin:/);
    expect(controller.pending()).toBe(1);

    native.getHabits.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(api.getHabits(true, "2026-08-01")).resolves.toMatchObject([
      { id: "habit-1", todayStatus: "success", todayNote: "完成" },
    ]);

    setOnline(true);
    await controller.flush();
    expect(native.checkInHabit).toHaveBeenCalledWith("habit-1", expect.objectContaining({
      status: "success",
      checkinDate: "2026-08-01",
    }));
    expect(controller.pending()).toBe(0);
  });

  it("derives filters and statistics from the cached task snapshot", () => {
    const current = new Date();
    const key = [
      current.getFullYear(),
      String(current.getMonth() + 1).padStart(2, "0"),
      String(current.getDate()).padStart(2, "0"),
    ].join("-");
    const tasks = [
      task({ id: "today", dueDate: key }),
      task({ id: "done", dueDate: key, isCompleted: 1, status: "done" }),
    ];

    expect(filterOfflineTasks(tasks, "today").map((item) => item.id)).toEqual(["today"]);
    expect(deriveOfflineTaskStats(tasks)).toMatchObject({
      total: 2,
      completed: 1,
      pending: 1,
      today: 1,
    });
  });
});
