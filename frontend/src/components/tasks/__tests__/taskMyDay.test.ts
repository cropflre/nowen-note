import { describe, expect, it } from "vitest";
import type { Task } from "@/types";
import {
  getMyDaySuggestions,
  normalizeMyDayPlan,
  orderMyDayTasks,
} from "../taskMyDay";

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id || "task-1",
    userId: "user-1",
    workspaceId: null,
    title: overrides.title || "Task",
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
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("taskMyDay", () => {
  it("normalizes task ids and limits focus to three planned tasks", () => {
    const normalized = normalizeMyDayPlan(
      ["a", "a", "b", "c", "d", "missing"],
      ["missing", "d", "c", "b", "a"],
      new Set(["a", "b", "c", "d"]),
    );

    expect(normalized.taskIds).toEqual(["a", "b", "c", "d"]);
    expect(normalized.focusTaskIds).toEqual(["d", "c", "b"]);
  });

  it("suggests overdue and due-today tasks while excluding planned and completed tasks", () => {
    const tasks = [
      task({ id: "planned", dueDate: "2026-08-02" }),
      task({ id: "overdue", dueDate: "2026-08-01", priority: 1 }),
      task({ id: "today", dueDate: "2026-08-02", priority: 3 }),
      task({ id: "starting", startDate: "2026-08-02" }),
      task({ id: "future", dueDate: "2026-08-03" }),
      task({ id: "done", dueDate: "2026-08-01", isCompleted: 1, status: "done" }),
    ];

    expect(getMyDaySuggestions(tasks, "2026-08-02", ["planned"]).map((item) => item.id))
      .toEqual(["overdue", "today", "starting"]);
  });

  it("orders focus tasks first and completed tasks last within each group", () => {
    const tasks = [
      task({ id: "a" }),
      task({ id: "b", isCompleted: 1, status: "done" }),
      task({ id: "c" }),
    ];

    expect(orderMyDayTasks(tasks, {
      taskIds: ["a", "b", "c"],
      focusTaskIds: ["c"],
    }).map((item) => item.id)).toEqual(["c", "a", "b"]);
  });
});
