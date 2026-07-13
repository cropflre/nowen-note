import { describe, expect, it } from "vitest";
import {
  TASK_BACKUP_FORMAT,
  TASK_BACKUP_VERSION,
  buildTaskCsv,
  normalizeTaskBackup,
  taskBackupFromCsv,
} from "@/lib/taskDataTransfer";

const packageWithCompletion = {
  format: TASK_BACKUP_FORMAT,
  version: 1,
  exportedAt: "2026-07-13T00:00:00.000Z",
  source: { workspace: "personal", app: "nowen-note" },
  data: {
    projects: [],
    tasks: [{
      sourceId: "task-1",
      title: "Historical task",
      description: "",
      isCompleted: 1,
      completedAt: "2025-03-10T08:30:00+08:00",
      priority: 2,
      dueDate: null,
      dueAt: null,
      startDate: null,
      noteId: null,
      parentSourceId: null,
      projectSourceId: null,
      sortOrder: 0,
      status: "done",
      repeatRule: "none",
      repeatInterval: 1,
      repeatEndDate: null,
      repeatEndCount: null,
      repeatGroupId: null,
      repeatGeneratedFromSourceId: null,
      repeatRuleJson: null,
    }],
    dependencies: [],
    reminders: [],
  },
};

describe("task completedAt transfer compatibility", () => {
  it("upgrades v1 JSON and preserves completion time", () => {
    const normalized = normalizeTaskBackup(packageWithCompletion);
    expect(normalized.version).toBe(TASK_BACKUP_VERSION);
    expect(normalized.data.tasks[0].completedAt).toBe("2025-03-10T00:30:00.000Z");
  });

  it("round-trips completedAt through CSV", () => {
    const csv = buildTaskCsv(normalizeTaskBackup(packageWithCompletion));
    expect(csv.split(/\r?\n/, 1)[0]).toContain("completedAt");
    const parsed = taskBackupFromCsv(csv);
    expect(parsed.data.tasks[0].completedAt).toBe("2025-03-10T00:30:00.000Z");
  });
});
