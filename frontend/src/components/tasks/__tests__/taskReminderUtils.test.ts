import { describe, expect, it } from "vitest";
import {
  buildCustomReminderOffset,
  hasEnabledReminder,
  sortRemindersByOffset,
} from "../taskReminderUtils";
import type { Task, TaskReminder } from "@/types";

function reminder(overrides: Partial<TaskReminder>): TaskReminder {
  return {
    id: overrides.id || crypto.randomUUID(),
    taskId: overrides.taskId || "task-1",
    userId: overrides.userId || "user-1",
    offsetMinutes: overrides.offsetMinutes ?? 0,
    enabled: overrides.enabled ?? 1,
    lastNotifiedAt: null,
    snoozedUntil: null,
    createdAt: "2026-01-01T00:00:00",
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}

describe("task reminder helpers", () => {
  it("builds custom offsets from days, hours, and minutes", () => {
    expect(buildCustomReminderOffset({ days: 1, hours: 2, minutes: 30 })).toBe(1590);
    expect(buildCustomReminderOffset({ days: 0, hours: 0, minutes: 0 })).toBeNull();
  });

  it("sorts reminders by offset minutes", () => {
    const sorted = sortRemindersByOffset([
      reminder({ id: "hour", offsetMinutes: 60 }),
      reminder({ id: "due", offsetMinutes: 0 }),
      reminder({ id: "day", offsetMinutes: 1440 }),
    ]).map((r) => r.id);

    expect(sorted).toEqual(["due", "hour", "day"]);
  });

  it("detects enabled reminder badges from list row data", () => {
    expect(hasEnabledReminder({ activeReminderCount: 1 } as Task)).toBe(true);
    expect(hasEnabledReminder({ activeReminderCount: 0 } as Task)).toBe(false);
    expect(hasEnabledReminder({} as Task)).toBe(false);
  });
});
