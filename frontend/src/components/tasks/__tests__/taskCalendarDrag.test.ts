import { describe, it, expect } from "vitest";
import { moveTaskToDate, getTaskDateKey } from "../taskDateUtils";
import type { Task } from "@/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id || crypto.randomUUID(),
    userId: "user1",
    workspaceId: null,
    title: overrides.title || "Test task",
    isCompleted: overrides.isCompleted ?? 0,
    priority: overrides.priority ?? 2,
    dueDate: overrides.dueDate ?? null,
    dueAt: overrides.dueAt ?? null,
    noteId: null,
    parentId: null,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00",
    updatedAt: "2026-01-01T00:00:00",
    status: "todo",
    ...overrides,
  } as Task;
}

describe("getTaskDateKey", () => {
  it("returns dueAt date part when dueAt exists", () => {
    const task = makeTask({ dueAt: "2026-06-15T14:30:00", dueDate: "2026-06-10" });
    expect(getTaskDateKey(task)).toBe("2026-06-15");
  });

  it("returns dueDate when no dueAt", () => {
    const task = makeTask({ dueDate: "2026-06-10" });
    expect(getTaskDateKey(task)).toBe("2026-06-10");
  });

  it("returns null when neither dueDate nor dueAt", () => {
    const task = makeTask();
    expect(getTaskDateKey(task)).toBeNull();
  });
});

describe("moveTaskToDate", () => {
  it("updates dueDate for dueDate-only task", () => {
    const task = makeTask({ dueDate: "2026-06-10" });
    const patch = moveTaskToDate(task, "2026-06-20");
    expect(patch).toEqual({ dueDate: "2026-06-20" });
  });

  it("preserves time part for dueAt task and syncs dueDate", () => {
    const task = makeTask({ dueAt: "2026-06-10T15:30:00", dueDate: "2026-06-10" });
    const patch = moveTaskToDate(task, "2026-06-20");
    expect(patch).toEqual({
      dueAt: "2026-06-20T15:30:00",
      dueDate: "2026-06-20",
    });
  });

  it("handles dueAt-only task (no dueDate)", () => {
    const task = makeTask({ dueAt: "2026-06-10T09:00:00", dueDate: null });
    const patch = moveTaskToDate(task, "2026-06-25");
    expect(patch).toEqual({
      dueAt: "2026-06-25T09:00:00",
      dueDate: "2026-06-25",
    });
  });

  it("returns null when dragging to same date (dueDate)", () => {
    const task = makeTask({ dueDate: "2026-06-10" });
    expect(moveTaskToDate(task, "2026-06-10")).toBeNull();
  });

  it("returns null when dragging to same date (dueAt)", () => {
    const task = makeTask({ dueAt: "2026-06-10T15:30:00", dueDate: "2026-06-10" });
    expect(moveTaskToDate(task, "2026-06-10")).toBeNull();
  });

  it("sets dueDate for task with no dates (assigning a date)", () => {
    const task = makeTask();
    const patch = moveTaskToDate(task, "2026-06-10");
    expect(patch).toEqual({ dueDate: "2026-06-10" });
  });
});


