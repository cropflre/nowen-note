import { describe, it, expect } from "vitest";
import { getTaskStartDate, getTaskDurationDays, moveTaskDateRange, isTaskScheduled, resizeTaskDateRange, getVisibleTaskBar, buildTimelineDays } from "../taskGanttUtils";
import type { Task } from "../../../types";

const baseTask: Task = {
  id: "1",
  userId: "u1",
  workspaceId: null,
  title: "Test",
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
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

describe("getTaskDurationDays", () => {
  it("returns duration when both startDate and dueDate are set", () => {
    const task = { ...baseTask, startDate: "2026-06-10", dueDate: "2026-06-15" };
    expect(getTaskDurationDays(task)).toBe(6);
  });

  it("returns 1 when only dueDate is set (single day)", () => {
    const task = { ...baseTask, dueDate: "2026-06-15" };
    expect(getTaskDurationDays(task)).toBe(1);
  });

  it("returns 1 when no dates are set", () => {
    expect(getTaskDurationDays(baseTask)).toBe(1);
  });

  it("returns 1 when start and end are the same day", () => {
    const task = { ...baseTask, startDate: "2026-06-10", dueDate: "2026-06-10" };
    expect(getTaskDurationDays(task)).toBe(1);
  });
});

describe("moveTaskDateRange", () => {
  it("preserves duration when moving", () => {
    const task = { ...baseTask, startDate: "2026-06-10", dueDate: "2026-06-15" };
    const result = moveTaskDateRange(task, "2026-06-20");
    expect(result).not.toBeNull();
    expect(result!.startDate).toBe("2026-06-20");
    expect(result!.dueDate).toBe("2026-06-25");
  });

  it("returns null when target is same as current start", () => {
    const task = { ...baseTask, startDate: "2026-06-10", dueDate: "2026-06-15" };
    expect(moveTaskDateRange(task, "2026-06-10")).toBeNull();
  });

  it("returns null when task has no dates", () => {
    expect(moveTaskDateRange(baseTask, "2026-06-10")).toBeNull();
  });
});

describe("isTaskScheduled", () => {
  it("returns true when startDate is set", () => {
    const task = { ...baseTask, startDate: "2026-06-10" };
    expect(isTaskScheduled(task)).toBe(true);
  });

  it("returns true when dueDate is set", () => {
    const task = { ...baseTask, dueDate: "2026-06-10" };
    expect(isTaskScheduled(task)).toBe(true);
  });

  it("returns false when no dates are set", () => {
    expect(isTaskScheduled(baseTask)).toBe(false);
  });
});

describe("getTaskStartDate", () => {
  it("returns dueDate when only dueDate is set", () => {
    const task = { ...baseTask, dueDate: "2026-06-15" };
    expect(getTaskStartDate(task)).toBe("2026-06-15");
  });

  it("returns startDate when both are set", () => {
    const task = { ...baseTask, startDate: "2026-06-10", dueDate: "2026-06-15" };
    expect(getTaskStartDate(task)).toBe("2026-06-10");
  });

  it("uses the date part when startDate contains a time", () => {
    const task = { ...baseTask, startDate: "2026-06-10T09:15", dueDate: "2026-06-15" };
    expect(getTaskStartDate(task)).toBe("2026-06-10");
    expect(moveTaskDateRange(task, "2026-06-20")?.startDate).toBe("2026-06-20T09:15");
  });

  it("returns null when no dates", () => {
    expect(getTaskStartDate(baseTask)).toBeNull();
  });
});

describe("moveTaskDateRange dueDate-only", () => {
  it("can move a dueDate-only task", () => {
    const task = { ...baseTask, dueDate: "2026-06-15" };
    const result = moveTaskDateRange(task, "2026-06-20");
    expect(result).not.toBeNull();
    expect(result!.startDate).toBe("2026-06-20");
    expect(result!.dueDate).toBe("2026-06-20");
  });
});

describe("moveTaskDateRange startDate-only", () => {
  it("can move a startDate-only task", () => {
    const task = { ...baseTask, startDate: "2026-06-10" };
    const result = moveTaskDateRange(task, "2026-06-20");
    expect(result).not.toBeNull();
    expect(result!.startDate).toBe("2026-06-20");
    expect(result!.dueDate).toBe("2026-06-20");
  });
});

describe("resizeTaskDateRange", () => {
  it("can resize start date", () => {
    const task = { ...baseTask, startDate: "2026-06-10", dueDate: "2026-06-15" };
    const result = resizeTaskDateRange(task, "start", "2026-06-12");
    expect(result).toEqual({ startDate: "2026-06-12", dueDate: "2026-06-15" });
  });

  it("can resize end date", () => {
    const task = { ...baseTask, startDate: "2026-06-10", dueDate: "2026-06-15" };
    const result = resizeTaskDateRange(task, "end", "2026-06-20");
    expect(result).toEqual({ startDate: "2026-06-10", dueDate: "2026-06-20" });
  });

  it("returns null for invalid range (start > end)", () => {
    const task = { ...baseTask, startDate: "2026-06-10", dueDate: "2026-06-15" };
    expect(resizeTaskDateRange(task, "start", "2026-06-20")).toBeNull();
  });

  it("can resize dueDate-only task", () => {
    const task = { ...baseTask, dueDate: "2026-06-15" };
    const result = resizeTaskDateRange(task, "end", "2026-06-20");
    expect(result).not.toBeNull();
    expect(result!.dueDate).toBe("2026-06-20");
  });
});

describe("getVisibleTaskBar", () => {
  it("returns null when task is completely outside view", () => {
    const task = { ...baseTask, startDate: "2026-05-01", dueDate: "2026-05-10" };
    const days = buildTimelineDays(new Date("2026-06-01"), 7);
    expect(getVisibleTaskBar(task, days)).toBeNull();
  });

  it("returns bar with clippedStart when task starts before view", () => {
    const task = { ...baseTask, startDate: "2026-05-28", dueDate: "2026-06-03" };
    const days = buildTimelineDays(new Date("2026-06-01"), 7);
    const bar = getVisibleTaskBar(task, days);
    expect(bar).not.toBeNull();
    expect(bar!.clippedStart).toBe(true);
    expect(bar!.clippedEnd).toBe(false);
  });

  it("returns bar with clippedEnd when task ends after view", () => {
    const task = { ...baseTask, startDate: "2026-06-05", dueDate: "2026-06-15" };
    const days = buildTimelineDays(new Date("2026-06-01"), 7);
    const bar = getVisibleTaskBar(task, days);
    expect(bar).not.toBeNull();
    expect(bar!.clippedEnd).toBe(true);
  });
});
