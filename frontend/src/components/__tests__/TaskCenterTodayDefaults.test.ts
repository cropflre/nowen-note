import { describe, expect, it, vi } from "vitest";
import { formatLocalDateKey, getDefaultTaskPatchForFilter } from "../TaskCenter";

describe("TaskCenter default task patch", () => {
  it("uses local today as dueDate for the today filter", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 5, 23, 30, 0));
    try {
      expect(formatLocalDateKey()).toBe("2026-07-05");
      expect(getDefaultTaskPatchForFilter("today")).toEqual({ dueDate: "2026-07-05" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not add dueDate for other filters", () => {
    expect(getDefaultTaskPatchForFilter("all")).toEqual({});
    expect(getDefaultTaskPatchForFilter("week")).toEqual({});
    expect(getDefaultTaskPatchForFilter("overdue")).toEqual({});
    expect(getDefaultTaskPatchForFilter("completed")).toEqual({});
  });
});
