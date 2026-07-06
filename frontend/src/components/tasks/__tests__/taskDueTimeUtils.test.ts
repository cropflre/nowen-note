import { describe, expect, it } from "vitest";
import {
  buildDueAtFromDateAndTime,
  buildDueDatePatch,
  compareTasksByDueTime,
  getDueTimeValue,
} from "../taskDateUtils";
import type { Task } from "@/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: overrides.id || crypto.randomUUID(),
    userId: "user1",
    workspaceId: null,
    title: overrides.title || "Test task",
    description: overrides.description ?? "",
    isCompleted: overrides.isCompleted ?? 0,
    priority: overrides.priority ?? 2,
    dueDate: overrides.dueDate ?? null,
    dueAt: overrides.dueAt ?? null,
    noteId: null,
    parentId: overrides.parentId ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    projectId: null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00",
    status: "todo",
  };
  return {
    ...base,
    ...overrides,
    projectId: overrides.projectId ?? null,
    status: overrides.status ?? "todo",
  };
}

describe("due time helpers", () => {
  it("extracts the HH:mm value from dueAt", () => {
    expect(getDueTimeValue("2026-06-17T17:05:00")).toBe("17:05");
    expect(getDueTimeValue("2026-06-17T08:30")).toBe("08:30");
    expect(getDueTimeValue(null)).toBe("");
  });

  it("combines dueDate and time into existing dueAt shape", () => {
    expect(buildDueAtFromDateAndTime("2026-06-17", "17:00")).toBe("2026-06-17T17:00");
    expect(buildDueAtFromDateAndTime("", "17:00")).toBeNull();
    expect(buildDueAtFromDateAndTime("2026-06-17", "")).toBeNull();
  });

  it("clearing dueDate also clears dueAt and disables repeat", () => {
    const task = makeTask({ dueDate: "2026-06-17", dueAt: "2026-06-17T17:00", repeatRule: "weekly", repeatEndCount: 5 });
    expect(buildDueDatePatch(task, "")).toEqual({
      dueDate: null,
      dueAt: null,
      repeatRule: "none",
      repeatInterval: 1,
      repeatEndDate: null,
      repeatEndCount: null,
    });
  });

  it("sorts incomplete top-level tasks by effective due time with unscheduled last", () => {
    const unscheduled = makeTask({ id: "none", dueDate: null, dueAt: null, sortOrder: 0 });
    const dateOnly = makeTask({ id: "date", dueDate: "2026-06-18", dueAt: null, sortOrder: 0 });
    const earlierTime = makeTask({ id: "time", dueDate: "2026-06-17", dueAt: "2026-06-17T17:00", sortOrder: 0 });
    const rootIds = [unscheduled, dateOnly, earlierTime]
      .sort(compareTasksByDueTime)
      .map((t) => t.id);

    expect(rootIds).toEqual(["time", "date", "none"]);
  });
});
