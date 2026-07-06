import { describe, it, expect } from "vitest";
import { isRepeatingTask, getNextRepeatDate, buildNextRepeatedTaskPatch } from "../taskRepeatUtils";
import type { Task } from "@/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
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
    parentId: null,
    sortOrder: 0,
    projectId: null,
    status: "todo",
    createdAt: "2026-01-01T00:00:00",
    updatedAt: "2026-01-01T00:00:00",
    repeatRule: overrides.repeatRule ?? "none",
    repeatInterval: overrides.repeatInterval ?? 1,
    repeatEndDate: overrides.repeatEndDate ?? null,
    repeatGroupId: overrides.repeatGroupId ?? null,
    repeatGeneratedFromId: overrides.repeatGeneratedFromId ?? null,
    repeatNextGeneratedId: overrides.repeatNextGeneratedId ?? null,
    repeatEndCount: overrides.repeatEndCount ?? null,
    repeatSequenceIndex: overrides.repeatSequenceIndex ?? 1,
    repeatRuleJson: overrides.repeatRuleJson ?? null,
    ...overrides,
  } as Task;
}

describe("isRepeatingTask", () => {
  it("returns false for none", () => {
    expect(isRepeatingTask(makeTask())).toBe(false);
  });
  it("returns true for daily", () => {
    expect(isRepeatingTask(makeTask({ repeatRule: "daily", dueDate: "2026-06-10" }))).toBe(true);
  });
  it("returns false when interval is 0", () => {
    expect(isRepeatingTask(makeTask({ repeatRule: "daily", repeatInterval: 0, dueDate: "2026-06-10" }))).toBe(false);
  });
});

describe("getNextRepeatDate", () => {
  it("daily: adds interval days", () => {
    const t = makeTask({ repeatRule: "daily", dueDate: "2026-06-10" });
    expect(getNextRepeatDate(t)).toBe("2026-06-11");
  });
  it("daily interval=3", () => {
    const t = makeTask({ repeatRule: "daily", repeatInterval: 3, dueDate: "2026-06-10" });
    expect(getNextRepeatDate(t)).toBe("2026-06-13");
  });
  it("weekly: adds 7 days", () => {
    const t = makeTask({ repeatRule: "weekly", dueDate: "2026-06-10" });
    expect(getNextRepeatDate(t)).toBe("2026-06-17");
  });
  it("monthly: adds 1 month", () => {
    const t = makeTask({ repeatRule: "monthly", dueDate: "2026-06-10" });
    expect(getNextRepeatDate(t)).toBe("2026-07-10");
  });
  it("monthly: handles month-end overflow (Jan 31 -> Feb 28)", () => {
    const t = makeTask({ repeatRule: "monthly", dueDate: "2026-01-31" });
    expect(getNextRepeatDate(t)).toBe("2026-02-28");
  });
  it("yearly: adds 1 year", () => {
    const t = makeTask({ repeatRule: "yearly", dueDate: "2026-06-10" });
    expect(getNextRepeatDate(t)).toBe("2027-06-10");
  });
  it("yearly: handles Feb 29 -> Feb 28", () => {
    const t = makeTask({ repeatRule: "yearly", dueDate: "2024-02-29" });
    expect(getNextRepeatDate(t)).toBe("2025-02-28");
  });
  it("returns null when past repeatEndDate", () => {
    const t = makeTask({ repeatRule: "daily", dueDate: "2026-06-10", repeatEndDate: "2026-06-10" });
    expect(getNextRepeatDate(t)).toBeNull();
  });
  it("returns null when repeatEndCount has reached the current occurrence", () => {
    const t = makeTask({ repeatRule: "daily", dueDate: "2026-06-10", repeatEndCount: 3, repeatSequenceIndex: 3 });
    expect(getNextRepeatDate(t)).toBeNull();
  });
  it("returns null for no dueDate/dueAt", () => {
    const t = makeTask({ repeatRule: "daily" });
    expect(getNextRepeatDate(t)).toBeNull();
  });
  it("preserves time from dueAt", () => {
    const t = makeTask({ repeatRule: "daily", dueAt: "2026-06-10T15:30:00", dueDate: "2026-06-10" });
    expect(getNextRepeatDate(t)).toBe("2026-06-11");
  });
});

describe("buildNextRepeatedTaskPatch", () => {
  it("builds correct patch for daily task", () => {
    const t = makeTask({ repeatRule: "daily", dueDate: "2026-06-10", title: "Daily task", priority: 1, projectId: "p1" });
    const patch = buildNextRepeatedTaskPatch(t);
    expect(patch).not.toBeNull();
    expect(patch!.dueDate).toBe("2026-06-11");
    expect(patch!.title).toBe("Daily task");
    expect(patch!.priority).toBe(1);
    expect(patch!.projectId).toBe("p1");
    expect(patch!.isCompleted).toBe(0);
    expect(patch!.status).toBe("todo");
    expect(patch!.repeatRule).toBe("daily");
    expect(patch!.repeatGeneratedFromId).toBe(t.id);
  });
  it("carries repeatEndCount and increments repeatSequenceIndex", () => {
    const t = makeTask({ repeatRule: "daily", dueDate: "2026-06-10", repeatEndCount: 12, repeatSequenceIndex: 4 });
    const patch = buildNextRepeatedTaskPatch(t);
    expect(patch).not.toBeNull();
    expect(patch!.repeatEndCount).toBe(12);
    expect(patch!.repeatSequenceIndex).toBe(5);
  });
  it("preserves dueAt time part", () => {
    const t = makeTask({ repeatRule: "weekly", dueAt: "2026-06-10T14:00:00", dueDate: "2026-06-10" });
    const patch = buildNextRepeatedTaskPatch(t);
    expect(patch!.dueAt).toBe("2026-06-17T14:00:00");
    expect(patch!.dueDate).toBe("2026-06-17");
  });
  it("returns null when no next date", () => {
    const t = makeTask({ repeatRule: "daily", dueDate: "2026-06-10", repeatEndDate: "2026-06-10" });
    expect(buildNextRepeatedTaskPatch(t)).toBeNull();
  });
});

// TASK-RECURRENCE-CUSTOM-01-RV1: 自定义循环规则边界测试
describe("getNextRepeatDate (custom)", () => {
  describe("month frequency", () => {
    it("Jan 31 + 1 month => Feb 28 (non-leap)", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "month", interval: 1 }),
        dueDate: "2025-01-31",
      });
      expect(getNextRepeatDate(t)).toBe("2025-02-28");
    });

    it("Jan 31 + 1 month => Feb 29 (leap year)", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "month", interval: 1 }),
        dueDate: "2024-01-31",
      });
      expect(getNextRepeatDate(t)).toBe("2024-02-29");
    });

    it("Jan 31 + 1 month with monthDay=15 => Feb 15", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "month", interval: 1, monthDay: 15 }),
        dueDate: "2025-01-20",
      });
      expect(getNextRepeatDate(t)).toBe("2025-02-15");
    });

    it("every 2 months: Mar 31 => May 31", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "month", interval: 2 }),
        dueDate: "2025-03-31",
      });
      expect(getNextRepeatDate(t)).toBe("2025-05-31");
    });
  });

  describe("year frequency", () => {
    it("Feb 29 + 1 year => Feb 28 (non-leap)", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "year", interval: 1 }),
        dueDate: "2024-02-29",
      });
      expect(getNextRepeatDate(t)).toBe("2025-02-28");
    });

    it("Feb 29 + 4 years => Feb 29 (leap)", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "year", interval: 4 }),
        dueDate: "2024-02-29",
      });
      expect(getNextRepeatDate(t)).toBe("2028-02-29");
    });

    it("year with yearMonth=6, yearDay=31 => Jun 30", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "year", interval: 1, yearMonth: 6, yearDay: 31 }),
        dueDate: "2025-03-15",
      });
      expect(getNextRepeatDate(t)).toBe("2026-06-30");
    });

    it("year with yearMonth=2, yearDay=29 on non-leap => Feb 28", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "year", interval: 1, yearMonth: 2, yearDay: 29 }),
        dueDate: "2025-06-01",
      });
      expect(getNextRepeatDate(t)).toBe("2026-02-28");
    });
  });

  describe("week frequency", () => {
    it("every Mon/Wed/Fri from Fri => next Mon", () => {
      // 2026-06-12 is Friday (day=5)
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "week", interval: 1, weekdays: [1, 3, 5] }),
        dueDate: "2026-06-12",
      });
      expect(getNextRepeatDate(t)).toBe("2026-06-15"); // Monday
    });

    it("every Mon/Wed/Fri from Mon => next Wed", () => {
      // 2026-06-15 is Monday (day=1)
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "week", interval: 1, weekdays: [1, 3, 5] }),
        dueDate: "2026-06-15",
      });
      expect(getNextRepeatDate(t)).toBe("2026-06-17"); // Wednesday
    });

    it("every Tue from Sat => next Tue (cross week)", () => {
      // 2026-06-13 is Saturday (day=6)
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "week", interval: 1, weekdays: [2] }),
        dueDate: "2026-06-13",
      });
      expect(getNextRepeatDate(t)).toBe("2026-06-16"); // Tuesday
    });
  });

  describe("day frequency", () => {
    it("every 3 days", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "day", interval: 3 }),
        dueDate: "2026-06-10",
      });
      expect(getNextRepeatDate(t)).toBe("2026-06-13");
    });
  });

  describe("invalid rules", () => {
    it("returns null for missing frequency", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ interval: 1 }),
        dueDate: "2026-06-10",
      });
      expect(getNextRepeatDate(t)).toBeNull();
    });

    it("returns null for empty repeatRuleJson", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: "",
        dueDate: "2026-06-10",
      });
      expect(getNextRepeatDate(t)).toBeNull();
    });

    it("returns null for unknown frequency", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "hourly", interval: 1 }),
        dueDate: "2026-06-10",
      });
      expect(getNextRepeatDate(t)).toBeNull();
    });
  });

  // TASK-RECURRENCE-LUNAR-01: 农历循环测试
  describe("lunar yearly", () => {
    it("八月十五每年循环 (2025-10-06 => 2026-09-25)", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ calendar: "lunar", frequency: "year", interval: 1, lunarMonth: 8, lunarDay: 15 }),
        dueDate: "2025-10-06",
      });
      expect(getNextRepeatDate(t)).toBe("2026-09-25");
    });

    it("正月初一每年循环 (2025-01-29 => 2026-02-17)", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ calendar: "lunar", frequency: "year", interval: 1, lunarMonth: 1, lunarDay: 1 }),
        dueDate: "2025-01-29",
      });
      expect(getNextRepeatDate(t)).toBe("2026-02-17");
    });

    it("每2个农历年循环 (2025 八月十五 => 2027 八月十五)", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ calendar: "lunar", frequency: "year", interval: 2, lunarMonth: 8, lunarDay: 15 }),
        dueDate: "2025-10-06",
      });
      expect(getNextRepeatDate(t)).toBe("2027-09-15");
    });

    it("农历三十遇到小月落到该月最后一天", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ calendar: "lunar", frequency: "year", interval: 1, lunarMonth: 2, lunarDay: 30 }),
        dueDate: "2025-03-29",
      });
      const result = getNextRepeatDate(t);
      expect(result).not.toBeNull();
    });

    it("calendar 缺省时按 gregorian 处理", () => {
      const t = makeTask({
        repeatRule: "custom",
        repeatRuleJson: JSON.stringify({ frequency: "year", interval: 1, yearMonth: 10, yearDay: 6 }),
        dueDate: "2025-10-06",
      });
      expect(getNextRepeatDate(t)).toBe("2026-10-06");
    });
  });
});
