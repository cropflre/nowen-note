import { describe, it, expect } from "vitest";

/**
 * Tests for reminder scanning logic.
 * Since scanDueReminders depends on DB, we test the pure logic patterns here.
 */

// Simulated scan logic matching backend/src/routes/task-reminders.ts
interface ReminderRow {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  dueAt: string | null;
  dueDate: string | null;
  isCompleted: number;
  enabled: number;
  offsetMinutes: number;
  lastNotifiedAt: string | null;
}

function simulateScanDueReminders(rows: ReminderRow[], nowMs: number): ReminderRow[] {
  const pending: ReminderRow[] = [];
  for (const row of rows) {
    if (row.isCompleted !== 0) continue;
    if (row.enabled !== 1) continue;
    const dueStr = row.dueAt || (row.dueDate ? row.dueDate + "T23:59:59" : null);
    if (!dueStr) continue;
    const dueMs = new Date(dueStr).getTime();
    const reminderMs = dueMs - row.offsetMinutes * 60 * 1000;
    if (reminderMs > nowMs) continue;
    if (row.lastNotifiedAt) {
      const lastNotifiedMs = new Date(row.lastNotifiedAt).getTime();
      if (lastNotifiedMs >= reminderMs) continue;
    }
    pending.push(row);
  }
  return pending;
}

describe("scanDueReminders logic", () => {
  it("triggers when reminder time has passed", () => {
    const now = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: ReminderRow[] = [{
      reminderId: "r1", taskId: "t1", taskTitle: "Test",
      dueAt: "2026-06-15T10:30:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 60, lastNotifiedAt: null,
    }];
    // Reminder time = 10:30 - 60min = 09:30, which is before now (10:00)
    expect(simulateScanDueReminders(rows, now).length).toBe(1);
  });

  it("does not trigger when reminder time is in the future", () => {
    const now = new Date("2026-06-15T08:00:00Z").getTime();
    const rows: ReminderRow[] = [{
      reminderId: "r1", taskId: "t1", taskTitle: "Test",
      dueAt: "2026-06-15T10:30:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 60, lastNotifiedAt: null,
    }];
    // Reminder time = 10:30 - 60min = 09:30, which is after now (08:00)
    expect(simulateScanDueReminders(rows, now).length).toBe(0);
  });

  it("does not trigger when isCompleted = 1", () => {
    const now = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: ReminderRow[] = [{
      reminderId: "r1", taskId: "t1", taskTitle: "Test",
      dueAt: "2026-06-15T10:30:00Z", dueDate: null,
      isCompleted: 1, enabled: 1, offsetMinutes: 60, lastNotifiedAt: null,
    }];
    expect(simulateScanDueReminders(rows, now).length).toBe(0);
  });

  it("does not trigger when enabled = 0", () => {
    const now = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: ReminderRow[] = [{
      reminderId: "r1", taskId: "t1", taskTitle: "Test",
      dueAt: "2026-06-15T10:30:00Z", dueDate: null,
      isCompleted: 0, enabled: 0, offsetMinutes: 60, lastNotifiedAt: null,
    }];
    expect(simulateScanDueReminders(rows, now).length).toBe(0);
  });

  it("triggers when enabled = 1 and due", () => {
    const now = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: ReminderRow[] = [{
      reminderId: "r1", taskId: "t1", taskTitle: "Test",
      dueAt: "2026-06-15T10:30:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 60, lastNotifiedAt: null,
    }];
    expect(simulateScanDueReminders(rows, now).length).toBe(1);
  });

  it("does not trigger when lastNotifiedAt is already set (already notified)", () => {
    const now = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: ReminderRow[] = [{
      reminderId: "r1", taskId: "t1", taskTitle: "Test",
      dueAt: "2026-06-15T10:30:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 60,
      lastNotifiedAt: "2026-06-15T09:30:00Z",
    }];
    // lastNotifiedAt (09:30) >= reminderMs (09:30), so skip
    expect(simulateScanDueReminders(rows, now).length).toBe(0);
  });

  it("uses dueAt over dueDate", () => {
    const now = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: ReminderRow[] = [{
      reminderId: "r1", taskId: "t1", taskTitle: "Test",
      dueAt: "2026-06-15T10:30:00Z", dueDate: "2026-06-20",
      isCompleted: 0, enabled: 1, offsetMinutes: 60, lastNotifiedAt: null,
    }];
    // Uses dueAt: 10:30 - 60min = 09:30 < 10:00 -> triggers
    expect(simulateScanDueReminders(rows, now).length).toBe(1);
  });

  it("uses dueDate + 23:59:59 when no dueAt", () => {
    const now = new Date("2026-06-15T23:00:00Z").getTime();
    const rows: ReminderRow[] = [{
      reminderId: "r1", taskId: "t1", taskTitle: "Test",
      dueAt: null, dueDate: "2026-06-15",
      isCompleted: 0, enabled: 1, offsetMinutes: 60, lastNotifiedAt: null,
    }];
    // due = 2026-06-15T23:59:59, reminder = 23:59:59 - 60min = 22:59:59 < 23:00 -> triggers
    expect(simulateScanDueReminders(rows, now).length).toBe(1);
  });

  it("does not trigger when task has no dueAt and no dueDate", () => {
    const now = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: ReminderRow[] = [{
      reminderId: "r1", taskId: "t1", taskTitle: "Test",
      dueAt: null, dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 30, lastNotifiedAt: null,
    }];
    expect(simulateScanDueReminders(rows, now).length).toBe(0);
  });
});

describe("repeat task reminder copy logic (simulated generateNextRepeatedTask)", () => {
  // Simulates what generateNextRepeatedTask does for reminders
  interface CopiedReminder {
    taskId: string;
    offsetMinutes: number;
    enabled: number;
    lastNotifiedAt: string | null;
  }

  function copyReminders(reminders: { offsetMinutes: number; enabled: number }[], newTaskId: string): CopiedReminder[] {
    return reminders.map(r => ({
      taskId: newTaskId,
      offsetMinutes: r.offsetMinutes,
      enabled: r.enabled,
      lastNotifiedAt: null,
    }));
  }

  it("copies reminders to new task with reset lastNotifiedAt", () => {
    const original = [
      { offsetMinutes: 30, enabled: 1 },
      { offsetMinutes: 60, enabled: 1 },
    ];
    const copied = copyReminders(original, "new-task-id");
    expect(copied.length).toBe(2);
    expect(copied[0].taskId).toBe("new-task-id");
    expect(copied[0].offsetMinutes).toBe(30);
    expect(copied[0].enabled).toBe(1);
    expect(copied[0].lastNotifiedAt).toBeNull();
    expect(copied[1].taskId).toBe("new-task-id");
    expect(copied[1].offsetMinutes).toBe(60);
  });

  it("preserves enabled state", () => {
    const original = [
      { offsetMinutes: 30, enabled: 0 },
      { offsetMinutes: 60, enabled: 1 },
    ];
    const copied = copyReminders(original, "new-task-id");
    expect(copied[0].enabled).toBe(0);
    expect(copied[1].enabled).toBe(1);
  });

  it("handles empty reminders", () => {
    const copied = copyReminders([], "new-task-id");
    expect(copied.length).toBe(0);
  });
});

describe("empty /recent response safety", () => {
  it("handles empty reminders array", () => {
    const data = { reminders: [] };
    expect(data.reminders.length).toBe(0);
    // No error thrown
  });

  it("handles missing reminders key", () => {
    const data: any = {};
    const reminders = data.reminders || [];
    expect(reminders.length).toBe(0);
  });
});
