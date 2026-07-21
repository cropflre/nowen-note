import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getNotebooks: vi.fn(),
  getNotes: vi.fn(),
  getTags: vi.fn(),
  getTasks: vi.fn(),
  getHabits: vi.fn(),
  getHabitCheckinLog: vi.fn(),
  getTaskDependencies: vi.fn(),
  getTaskRemindersSnapshot: vi.fn(),
  getNoteSlim: vi.fn(),
}));

const localStoreMocks = vi.hoisted(() => ({
  setCurrentUser: vi.fn(),
  putNotebooks: vi.fn(),
  putNoteListItems: vi.fn(),
  putNote: vi.fn(),
  putTags: vi.fn(),
  putTasks: vi.fn(),
  replaceTasksSnapshot: vi.fn(),
  getTasks: vi.fn(),
  putHabits: vi.fn(),
  replaceHabitsSnapshot: vi.fn(),
  getHabits: vi.fn(),
  putHabitCheckins: vi.fn(),
  replaceHabitCheckinsSnapshot: vi.fn(),
  getHabitCheckins: vi.fn(),
  putTaskDependencies: vi.fn(),
  replaceTaskDependenciesSnapshot: vi.fn(),
  getTaskDependencies: vi.fn(),
  putTaskReminders: vi.fn(),
  replaceTaskRemindersSnapshot: vi.fn(),
  getTaskRemindersForWorkspace: vi.fn(),
  deleteTaskReminder: vi.fn(),
  setMeta: vi.fn(),
  getMeta: vi.fn(),
  getAllNotes: vi.fn(),
  getAllNotebooks: vi.fn(),
  getAllTags: vi.fn(),
  deleteNote: vi.fn(),
  deleteNotebook: vi.fn(),
  deleteTag: vi.fn(),
  clearAll: vi.fn(),
  isReady: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
  getCurrentWorkspace: () => "personal",
}));
vi.mock("@/lib/localStore", () => localStoreMocks);
vi.mock("@/lib/offlineQueue", () => ({
  flushQueue: vi.fn(),
  discardNoteQueueItems: vi.fn(),
  getFailedQueueItems: () => [],
  getQueue: () => [],
  getQueueLength: () => 0,
  clearQueue: vi.fn(),
  clearLocalIdMap: vi.fn(),
  subscribe: () => () => {},
}));
vi.mock("@/lib/offlineQueueFetch", () => ({ offlineQueueFetch: vi.fn() }));

import { syncNow } from "@/lib/syncEngine";

describe("syncEngine workspace snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    apiMocks.getNotebooks.mockResolvedValue([]);
    apiMocks.getNotes.mockResolvedValue([]);
    apiMocks.getTags.mockResolvedValue([]);
    apiMocks.getTasks.mockResolvedValue([]);
    apiMocks.getHabits.mockResolvedValue([]);
    apiMocks.getHabitCheckinLog.mockResolvedValue([]);
    apiMocks.getTaskDependencies.mockResolvedValue([]);
    apiMocks.getTaskRemindersSnapshot.mockResolvedValue({ reminders: [], deletedIds: [] });
    localStoreMocks.getAllNotes.mockResolvedValue([]);
    localStoreMocks.getAllNotebooks.mockResolvedValue([]);
    localStoreMocks.getAllTags.mockResolvedValue([]);
    localStoreMocks.getTasks.mockResolvedValue([{ id: "task-deleted-on-server" }]);
    localStoreMocks.getHabits.mockResolvedValue([{ id: "habit-deleted-on-server" }]);
    localStoreMocks.getHabitCheckins.mockResolvedValue([{ id: "checkin-deleted-on-server", habitId: "habit-deleted-on-server", checkinDate: "2026-07-21" }]);
    localStoreMocks.getTaskDependencies.mockResolvedValue([{ id: "dependency-deleted-on-server" }]);
    localStoreMocks.getTaskRemindersForWorkspace.mockResolvedValue([{ id: "reminder-deleted-on-server" }]);
  });

  it("replaces each workspace cache with the merged full snapshot", async () => {
    await expect(syncNow()).resolves.toMatchObject({ ok: true, pending: 0 });

    expect(localStoreMocks.replaceTasksSnapshot).toHaveBeenCalledWith([], null);
    expect(localStoreMocks.replaceHabitsSnapshot).toHaveBeenCalledWith([], null);
    expect(localStoreMocks.replaceHabitCheckinsSnapshot).toHaveBeenCalledWith([], null);
    expect(localStoreMocks.replaceTaskDependenciesSnapshot).toHaveBeenCalledWith([], null);
    expect(localStoreMocks.replaceTaskRemindersSnapshot).toHaveBeenCalledWith([], null);
    expect(localStoreMocks.putTasks).not.toHaveBeenCalled();
    expect(localStoreMocks.putHabits).not.toHaveBeenCalled();
    expect(localStoreMocks.putHabitCheckins).not.toHaveBeenCalled();
    expect(localStoreMocks.putTaskDependencies).not.toHaveBeenCalled();
    expect(localStoreMocks.putTaskReminders).not.toHaveBeenCalled();
  });
});
