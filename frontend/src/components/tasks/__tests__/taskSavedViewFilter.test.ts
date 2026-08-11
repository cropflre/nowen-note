import { describe, expect, it } from "vitest";
import type { Task } from "@/types";
import type { TaskSavedViewFilters } from "@/lib/taskMetadataApi";
import {
  countTaskSavedViewFilters,
  filterTasksBySavedView,
  hasTaskSavedViewFilters,
} from "../taskSavedViewFilter";

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id || "task-1",
    userId: "user-1",
    workspaceId: null,
    title: "Default task",
    description: "",
    isCompleted: 0,
    priority: 2,
    dueDate: null,
    dueAt: null,
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

function filters(overrides: Partial<TaskSavedViewFilters>): TaskSavedViewFilters {
  return {
    labelIds: [],
    labelMode: "any",
    priorities: [],
    statuses: [],
    due: "all",
    keyword: "",
    ...overrides,
  };
}

const tasks = [
  task({ id: "urgent", title: "Ship release", description: "Prepare changelog", priority: 3, dueDate: "2026-08-02", projectId: "project-a" }),
  task({ id: "blocked", title: "Wait for review", dueDate: "2026-08-01", status: "blocked" }),
  task({ id: "done", title: "Write tests", priority: 1, dueDate: "2026-08-04", status: "done", isCompleted: 1 }),
  task({ id: "later", title: "Plan roadmap", dueDate: "2026-08-08" }),
];

const assignments = {
  urgent: ["release", "work"],
  blocked: ["work"],
  done: ["quality"],
  later: ["planning"],
};

describe("task saved view filters", () => {
  it("combines label, priority, project and keyword filters", () => {
    const result = filterTasksBySavedView(tasks, filters({
      labelIds: ["release", "work"],
      labelMode: "all",
      priorities: [3],
      projectId: "project-a",
      keyword: "changelog",
    }), assignments, "2026-08-02");
    expect(result.map((item) => item.id)).toEqual(["urgent"]);
  });

  it("supports any-label matching and no-project filtering", () => {
    expect(filterTasksBySavedView(tasks, filters({
      labelIds: ["release", "quality"],
      labelMode: "any",
    }), assignments, "2026-08-02").map((item) => item.id)).toEqual(["urgent", "done"]);

    expect(filterTasksBySavedView(tasks, filters({ projectId: null }), assignments, "2026-08-02")
      .map((item) => item.id)).toEqual(["blocked", "done", "later"]);
  });

  it("handles due ranges", () => {
    expect(filterTasksBySavedView(tasks, filters({ due: "overdue" }), assignments, "2026-08-02").map((item) => item.id)).toEqual(["blocked"]);
    expect(filterTasksBySavedView(tasks, filters({ due: "today" }), assignments, "2026-08-02").map((item) => item.id)).toEqual(["urgent"]);
    expect(filterTasksBySavedView(tasks, filters({ due: "week" }), assignments, "2026-08-02").map((item) => item.id)).toEqual(["urgent", "later"]);
    expect(filterTasksBySavedView(tasks, filters({ due: "completed" }), assignments, "2026-08-02").map((item) => item.id)).toEqual(["done"]);
  });

  it("reports active filter groups", () => {
    expect(hasTaskSavedViewFilters(filters({}))).toBe(false);
    const configured = filters({ labelIds: ["work"], due: "pending", keyword: "release" });
    expect(hasTaskSavedViewFilters(configured)).toBe(true);
    expect(countTaskSavedViewFilters(configured)).toBe(3);
  });
});
