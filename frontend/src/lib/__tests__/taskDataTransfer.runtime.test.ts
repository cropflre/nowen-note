// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  archiveTask: vi.fn(),
  getTasks: vi.fn(),
  getTaskProjects: vi.fn(),
  getTaskDependencies: vi.fn(),
  getTaskReminders: vi.fn(),
  createTaskProject: vi.fn(),
  updateTaskProject: vi.fn(),
  deleteTaskProject: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  reorderTasks: vi.fn(),
  createTaskDependency: vi.fn(),
  deleteTaskDependency: vi.fn(),
  createTaskReminder: vi.fn(),
  updateTaskReminder: vi.fn(),
  deleteTaskReminder: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  getCurrentWorkspace: () => "personal",
}));

import {
  TASK_BACKUP_FORMAT,
  TASK_BACKUP_VERSION,
  collectTaskBackup,
  importTaskBackup,
  type TaskBackupPackage,
  type TaskBackupTask,
} from "@/lib/taskDataTransfer";

function task(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "existing-1",
    userId: "user-1",
    workspaceId: null,
    title: "任务",
    description: "",
    isCompleted: 0,
    priority: 2,
    dueDate: null,
    dueAt: null,
    startDate: null,
    noteId: null,
    parentId: null,
    sortOrder: 0,
    projectId: null,
    status: "todo",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    repeatRule: "none",
    repeatInterval: 1,
    repeatEndDate: null,
    repeatEndCount: null,
    repeatSequenceIndex: null,
    repeatGroupId: null,
    repeatGeneratedFromId: null,
    repeatNextGeneratedId: null,
    repeatRuleJson: null,
    ...overrides,
  };
}

function backupTask(overrides: Partial<TaskBackupTask> = {}): TaskBackupTask {
  return {
    sourceId: "source-1",
    title: "导入任务",
    description: "说明",
    isCompleted: 0,
    priority: 2,
    dueDate: null,
    dueAt: null,
    startDate: null,
    noteId: null,
    parentSourceId: null,
    projectSourceId: null,
    sortOrder: 0,
    status: "todo",
    repeatRule: "none",
    repeatInterval: 1,
    repeatEndDate: null,
    repeatEndCount: null,
    repeatGroupId: null,
    repeatGeneratedFromSourceId: null,
    repeatRuleJson: null,
    ...overrides,
  };
}

function backup(tasks: TaskBackupTask[]): TaskBackupPackage {
  return {
    format: TASK_BACKUP_FORMAT,
    version: TASK_BACKUP_VERSION,
    exportedAt: "2026-07-11T00:00:00.000Z",
    source: { workspace: "personal", app: "nowen-note" },
    data: { projects: [], tasks, dependencies: [], reminders: [] },
  };
}

describe("taskDataTransfer runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getTasks.mockResolvedValue([]);
    apiMock.getTaskProjects.mockResolvedValue([]);
    apiMock.getTaskDependencies.mockResolvedValue([]);
    apiMock.getTaskReminders.mockResolvedValue([]);
    apiMock.reorderTasks.mockResolvedValue({ success: true });
    apiMock.deleteTask.mockResolvedValue({ success: true });
    apiMock.deleteTaskProject.mockResolvedValue({ success: true });
    apiMock.deleteTaskDependency.mockResolvedValue({ success: true });
    apiMock.deleteTaskReminder.mockResolvedValue({ success: true });
  });

  it("fails the whole export when reminder collection is incomplete", async () => {
    apiMock.getTasks.mockResolvedValue([task()]);
    apiMock.getTaskReminders.mockRejectedValue(new Error("reminder endpoint failed"));

    await expect(collectTaskBackup()).rejects.toThrow("reminder endpoint failed");
  });

  it("detaches source note ids before creating tasks in another database", async () => {
    const source = backup([backupTask({ noteId: "source-note-id" })]);
    apiMock.createTask.mockImplementation(async (payload: Record<string, unknown>) => task({
      id: "created-1",
      title: payload.title,
      description: payload.description,
      noteId: payload.noteId,
    }));

    const result = await importTaskBackup(source, { duplicateMode: "append" });

    expect(apiMock.createTask).toHaveBeenCalledWith(expect.objectContaining({ noteId: null }));
    expect(result.createdTasks).toBe(1);
    expect(result.warnings.some((warning) => warning.includes("解除旧关联"))).toBe(true);
  });

  it("rolls back tasks created before a later task fails", async () => {
    const source = backup([
      backupTask({ sourceId: "parent", title: "父任务" }),
      backupTask({ sourceId: "child", title: "子任务", parentSourceId: "parent" }),
    ]);
    apiMock.createTask
      .mockResolvedValueOnce(task({ id: "created-parent", title: "父任务" }))
      .mockRejectedValueOnce(new Error("create child failed"));

    await expect(importTaskBackup(source, { duplicateMode: "append" })).rejects.toThrow("已尽量回滚");
    expect(apiMock.deleteTask).toHaveBeenCalledTimes(1);
    expect(apiMock.deleteTask).toHaveBeenCalledWith("created-parent");
  });
  it("archives an imported completed tree only after all descendants have been created",async () => {
    const archivedAt="2026-10-13T08:00:00Z";
    const source=backup([backupTask({sourceId:"parent",status:"done",isCompleted:1,archivedAt}),backupTask({sourceId:"child",parentSourceId:"parent",status:"done",isCompleted:1,archivedAt})]);
    let index=0;apiMock.createTask.mockImplementation(async (payload) => task({...payload,id:`created-${++index}`}));
    apiMock.archiveTask.mockResolvedValue({success:true,affected:2});
    await importTaskBackup(source,{duplicateMode:"append"});
    expect(apiMock.archiveTask).toHaveBeenCalledTimes(1);expect(apiMock.archiveTask).toHaveBeenCalledWith("created-1",true);
    expect(apiMock.archiveTask.mock.invocationCallOrder[0]).toBeGreaterThan(apiMock.createTask.mock.invocationCallOrder.at(-1)!);
  });
});
