import { describe, expect, it } from "vitest";
import {
  buildDueAtFromDateAndTime,
  buildDueDatePatch,
  buildStartDateFromDateAndTime,
  compareTasksByDueTime,
  getDateValue,
  getDueTimeValue,
  getTaskScheduleMode,
  isTaskAllDay,
  isTaskDateRangeInvalid,
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

  it("splits and rebuilds a start date with an optional time", () => {
    expect(getDateValue("2026-06-17T09:15")).toBe("2026-06-17");
    expect(getDueTimeValue("2026-06-17 09:15:00")).toBe("09:15");
    expect(buildStartDateFromDateAndTime("2026-06-17", "09:15")).toBe("2026-06-17T09:15");
    expect(buildStartDateFromDateAndTime("2026-06-17", "")).toBe("2026-06-17");
  });

  it("validates exact start and due times on the same day", () => {
    expect(isTaskDateRangeInvalid("2026-06-17T18:01", "2026-06-17", "2026-06-17T18:00")).toBe(true);
    expect(isTaskDateRangeInvalid("2026-06-17T17:00", "2026-06-17", "2026-06-17T18:00")).toBe(false);
    expect(isTaskDateRangeInvalid("2026-06-17T17:00", "2026-06-17", null)).toBe(false);
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


describe("task schedule mode", () => {
  it("does not treat an unscheduled task as all-day", () => {
    const task = makeTask({ startDate: null, dueDate: null, dueAt: null });
    expect(getTaskScheduleMode(task)).toBe("unscheduled");
    expect(isTaskAllDay(task)).toBe(false);
  });

  it("recognizes date-only tasks as all-day", () => {
    const task = makeTask({ startDate: "2026-08-03", dueDate: "2026-08-03", dueAt: null });
    expect(getTaskScheduleMode(task)).toBe("all-day");
    expect(isTaskAllDay(task)).toBe(true);
  });

  it("recognizes ISO and legacy space timestamps as timed", () => {
    expect(getTaskScheduleMode(makeTask({ dueDate: "2026-08-03", dueAt: "2026-08-03T09:30" }))).toBe("timed");
    expect(getTaskScheduleMode(makeTask({ startDate: "2026-08-03 09:30:00", dueDate: "2026-08-03" }))).toBe("timed");
  });
});
