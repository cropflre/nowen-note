// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  TASK_BACKUP_FORMAT,
  TASK_BACKUP_VERSION,
  buildTaskCsv,
  createTaskImportSignature,
  normalizeTaskBackup,
  parseCsvRows,
  summarizeTaskBackup,
  taskBackupFromCsv,
  type TaskBackupPackage,
} from "@/lib/taskDataTransfer";

function fixture(): TaskBackupPackage {
  return {
    format: TASK_BACKUP_FORMAT,
    version: TASK_BACKUP_VERSION,
    exportedAt: "2026-07-11T00:00:00.000Z",
    source: { workspace: "personal", app: "nowen-note" },
    data: {
      projects: [
        { sourceId: "project-1", name: "Nowen", icon: "📁", color: "#6366f1", sortOrder: 0 },
      ],
      tasks: [
        {
          sourceId: "task-parent",
          title: "发布新版本",
          description: "检查构建,\n然后发布",
          isCompleted: 0,
          priority: 3,
          dueDate: "2026-07-20",
          dueAt: "2026-07-20T18:30",
          startDate: "2026-07-11",
          noteId: null,
          parentSourceId: null,
          projectSourceId: "project-1",
          sortOrder: 0,
          status: "doing",
          repeatRule: "none",
          repeatInterval: 1,
          repeatEndDate: null,
          repeatEndCount: null,
          repeatGroupId: null,
          repeatGeneratedFromSourceId: null,
          repeatRuleJson: null,
        },
        {
          sourceId: "task-child",
          title: "验证 Android",
          description: "包含 \"引号\" 的说明",
          isCompleted: 1,
          priority: 2,
          dueDate: "2026-07-19",
          dueAt: null,
          startDate: null,
          noteId: null,
          parentSourceId: "task-parent",
          projectSourceId: "project-1",
          sortOrder: 1,
          status: "done",
          repeatRule: "weekly",
          repeatInterval: 1,
          repeatEndDate: "2026-09-01",
          repeatEndCount: 6,
          repeatGroupId: "repeat-1",
          repeatGeneratedFromSourceId: null,
          repeatRuleJson: null,
        },
      ],
      dependencies: [
        { predecessorSourceId: "task-parent", successorSourceId: "task-child", type: "finish_to_start" },
      ],
      reminders: [
        { taskSourceId: "task-parent", offsetMinutes: 30, enabled: 1, snoozedUntil: null },
      ],
    },
  };
}

describe("taskDataTransfer", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nowen-current-workspace", "personal");
  });

  it("round-trips CSV fields with commas, quotes, newlines and task hierarchy", () => {
    const csv = buildTaskCsv(fixture());
    expect(csv.startsWith("\uFEFFid,parentId,title")).toBe(true);
    expect(csv).toContain('"检查构建,\n然后发布"');
    expect(csv).toContain('"包含 ""引号"" 的说明"');

    const restored = taskBackupFromCsv(csv);
    expect(restored.data.tasks).toHaveLength(2);
    expect(restored.data.projects[0]?.name).toBe("Nowen");
    expect(restored.data.tasks.find((task) => task.sourceId === "task-child")?.parentSourceId).toBe("task-parent");
    expect(restored.data.tasks.find((task) => task.sourceId === "task-parent")?.description).toBe("检查构建,\n然后发布");
  });

  it("parses CRLF and empty quoted columns without shifting fields", () => {
    const rows = parseCsvRows('\uFEFFtitle,description,status\r\n"任务 A","",todo\r\n"任务 B","两行\r\n说明",done\r\n');
    expect(rows).toEqual([
      ["title", "description", "status"],
      ["任务 A", "", "todo"],
      ["任务 B", "两行\r\n说明", "done"],
    ]);
  });

  it("rejects duplicate source ids before any import can run", () => {
    const duplicated = fixture();
    duplicated.data.tasks.push({ ...duplicated.data.tasks[0], title: "重复", sourceId: "task-parent" });
    expect(() => normalizeTaskBackup(duplicated)).toThrow("任务 ID 重复");
  });

  it("normalizes unsafe fields and reports missing parent/project references", () => {
    const normalized = normalizeTaskBackup({
      ...fixture(),
      data: {
        projects: [],
        dependencies: [],
        reminders: [],
        tasks: [{
          ...fixture().data.tasks[0],
          title: " 任务\u0000标题 ",
          priority: 99,
          status: "完成",
          parentSourceId: "missing-parent",
          projectSourceId: "missing-project",
        }],
      },
    });
    expect(normalized.data.tasks[0].title).toBe("任务标题");
    expect(normalized.data.tasks[0].priority).toBe(2);
    expect(normalized.data.tasks[0].status).toBe("done");
    expect(summarizeTaskBackup(normalized).warnings).toHaveLength(2);
  });

  it("uses parent path and project name in duplicate signatures", () => {
    const base = createTaskImportSignature({
      title: "测试",
      description: "说明",
      status: "todo",
      priority: 2,
      projectName: "Nowen",
      parentPath: "发布 / Android",
    });
    expect(createTaskImportSignature({
      title: "  测试 ",
      description: "说明",
      status: "todo",
      priority: 2,
      projectName: "nowen",
      parentPath: "发布 / Android",
    })).toBe(base);
    expect(createTaskImportSignature({
      title: "测试",
      description: "说明",
      status: "todo",
      priority: 2,
      projectName: "Nowen",
      parentPath: "发布 / Desktop",
    })).not.toBe(base);
  });
});
