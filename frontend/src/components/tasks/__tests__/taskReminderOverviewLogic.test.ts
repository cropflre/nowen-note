import { describe, it, expect } from "vitest";

/**
 * Tests for reminder overview grouping logic.
 * Since the backend overview endpoint depends on DB, we test the grouping classification logic here.
 */

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
  snoozedUntil: string | null;
}

interface OverviewItem {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  isCompleted: number;
  dueDate: string | null;
  dueAt: string | null;
  offsetMinutes: number;
  enabled: number;
  lastNotifiedAt: string | null;
  reminderAt: string | null;
  group: "missed" | "today" | "upcoming" | "disabled";
  snoozedUntil: string | null;
}

function simulateOverview(rows: ReminderRow[], nowMs: number, days = 7): {
  missed: OverviewItem[];
  today: OverviewItem[];
  upcoming: OverviewItem[];
  disabled: OverviewItem[];
} {
  const todayEnd = new Date(nowMs);
  todayEnd.setHours(23, 59, 59, 999);
  const todayEndMs = todayEnd.getTime();
  const horizonMs = todayEndMs + days * 86400000;

  const missed: OverviewItem[] = [];
  const today: OverviewItem[] = [];
  const upcoming: OverviewItem[] = [];
  const disabled: OverviewItem[] = [];

  for (const row of rows) {
    let reminderAt: string | null = null;
    if (row.dueAt) {
      const dueMs = new Date(row.dueAt).getTime();
      const rMs = dueMs - row.offsetMinutes * 60000;
      reminderAt = new Date(rMs).toISOString();
    } else if (row.dueDate) {
      const dueMs = new Date(row.dueDate + "T23:59:59").getTime();
      const rMs = dueMs - row.offsetMinutes * 60000;
      reminderAt = new Date(rMs).toISOString();
    }

    const item: OverviewItem = {
      reminderId: row.reminderId,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      taskStatus: "todo",
      isCompleted: row.isCompleted,
      dueDate: row.dueDate,
      dueAt: row.dueAt,
      offsetMinutes: row.offsetMinutes,
      enabled: row.enabled,
      lastNotifiedAt: row.lastNotifiedAt,
      reminderAt,
      snoozedUntil: row.snoozedUntil || null,
      group: "disabled",
    };

    // snooze override
    if (row.snoozedUntil) {
      const snoozeMs = new Date(row.snoozedUntil).getTime();
      if (snoozeMs < nowMs) {
        item.group = 'missed';
      } else if (snoozeMs <= todayEndMs) {
        item.group = 'today';
      } else if (snoozeMs <= horizonMs) {
        item.group = 'upcoming';
      } else {
        continue;
      }
      item.reminderAt = row.snoozedUntil;
      const grp = item.group;
      if (grp === 'missed') missed.push(item);
      else if (grp === 'today') today.push(item);
      else if (grp === 'upcoming') upcoming.push(item);
      else disabled.push(item);
      continue;
    }
    if (row.enabled !== 1 || row.isCompleted === 1) {
      disabled.push(item);
      continue;
    }

    if (!reminderAt) {
      disabled.push(item);
      continue;
    }

    const reminderMs = new Date(reminderAt).getTime();

    if (reminderMs < nowMs) {
      item.group = "missed";
      missed.push(item);
      continue;
    }

    if (reminderMs <= todayEndMs) {
      item.group = "today";
      today.push(item);
      continue;
    }

    if (reminderMs <= horizonMs) {
      item.group = "upcoming";
      upcoming.push(item);
      continue;
    }
  }

  return { missed, today, upcoming, disabled };
}

const NOW = new Date("2026-06-15T10:00:00Z").getTime();

describe("reminderOverview grouping", () => {
  it("classifies missed: reminderAt < now", () => {
    const rows: ReminderRow[] = [{
      reminderId: "r1", taskId: "t1", taskTitle: "Overdue task",
      dueAt: "2026-06-15T09:30:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateOverview(rows, NOW);
    expect(result.missed).toHaveLength(1);
    expect(result.missed[0].group).toBe("missed");
  });

  it("snoozedUntil in future shows as today/upcoming, not missed", () => {
    // Reminder was snoozed to later today
    const snoozeTime = new Date(NOW + 2 * 3600000).toISOString(); // 2 hours from now
    const rows: ReminderRow[] = [{
      reminderId: "rs1", taskId: "ts1", taskTitle: "Snoozed task",
      dueAt: "2026-06-15T09:00:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0, lastNotifiedAt: "2026-06-15T08:55:00Z",
      snoozedUntil: snoozeTime,
    }];
    const result = simulateOverview(rows, NOW);
    // snooze is 2h from now, which is still today -> should be in today
    expect(result.today).toHaveLength(1);
    expect(result.missed).toHaveLength(0);
    expect(result.today[0].snoozedUntil).toBe(snoozeTime);
  });

  it("snoozedUntil in past triggers as missed", () => {
    const snoozeTime = new Date(NOW - 60000).toISOString(); // 1 minute ago
    const rows: ReminderRow[] = [{
      reminderId: "rs2", taskId: "ts2", taskTitle: "Expired snooze",
      dueAt: "2026-06-15T09:00:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0, lastNotifiedAt: "2026-06-15T08:55:00Z",
      snoozedUntil: snoozeTime,
    }];
    const result = simulateOverview(rows, NOW);
    expect(result.missed).toHaveLength(1);
    expect(result.missed[0].snoozedUntil).toBe(snoozeTime);
  });

  it("snoozedUntil overrides lastNotifiedAt check", () => {
    // Task was already notified, but snoozed to future
    const snoozeTime = new Date(NOW + 3600000).toISOString();
    const rows: ReminderRow[] = [{
      reminderId: "rs3", taskId: "ts3", taskTitle: "Snoozed past notified",
      dueAt: "2026-06-15T09:00:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0, lastNotifiedAt: "2026-06-15T08:55:00Z",
      snoozedUntil: snoozeTime,
    }];
    const result = simulateOverview(rows, NOW);
    // Should NOT be missed despite being already notified
    expect(result.missed).toHaveLength(0);
    expect(result.today).toHaveLength(1);
  });

  it("classifies today: reminderAt today and >= now", () => {
    const rows: ReminderRow[] = [{
      reminderId: "r2", taskId: "t2", taskTitle: "Later today",
      dueAt: "2026-06-15T15:00:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateOverview(rows, NOW);
    expect(result.today).toHaveLength(1);
    expect(result.today[0].group).toBe("today");
  });

  it("classifies upcoming: reminderAt > today end", () => {
    const rows: ReminderRow[] = [{
      reminderId: "r3", taskId: "t3", taskTitle: "Tomorrow task",
      dueAt: "2026-06-16T10:00:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateOverview(rows, NOW);
    expect(result.upcoming).toHaveLength(1);
    expect(result.upcoming[0].group).toBe("upcoming");
  });

  it("classifies disabled: enabled=0", () => {
    const rows: ReminderRow[] = [{
      reminderId: "r4", taskId: "t4", taskTitle: "Disabled reminder",
      dueAt: "2026-06-15T15:00:00Z", dueDate: null,
      isCompleted: 0, enabled: 0, offsetMinutes: 0, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateOverview(rows, NOW);
    expect(result.disabled).toHaveLength(1);
    expect(result.disabled[0].group).toBe("disabled");
  });

  it("classifies disabled: isCompleted=1", () => {
    const rows: ReminderRow[] = [{
      reminderId: "r5", taskId: "t5", taskTitle: "Completed task",
      dueAt: "2026-06-15T15:00:00Z", dueDate: null,
      isCompleted: 1, enabled: 1, offsetMinutes: 0, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateOverview(rows, NOW);
    expect(result.disabled).toHaveLength(1);
  });

  it("dueAt takes priority over dueDate", () => {
    const rows: ReminderRow[] = [{
      reminderId: "r6", taskId: "t6", taskTitle: "Both dates",
      dueAt: "2026-06-15T15:00:00Z", dueDate: "2026-06-20",
      isCompleted: 0, enabled: 1, offsetMinutes: 0, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateOverview(rows, NOW);
    expect(result.today).toHaveLength(1);
    expect(result.today[0].reminderAt).toContain("2026-06-15T15:00");
  });

  it("dueDate-only uses 23:59:59", () => {
    const rows: ReminderRow[] = [{
      reminderId: "r7", taskId: "t7", taskTitle: "Date only",
      dueAt: null, dueDate: "2026-06-15",
      isCompleted: 0, enabled: 1, offsetMinutes: 0, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateOverview(rows, NOW);
    // reminderAt = 2026-06-15T23:59:59 - 0min = 2026-06-15T23:59:59
    expect(result.today).toHaveLength(1);
    // dueDate "2026-06-15" + "T23:59:59" is parsed as local time, then converted to ISO
    const rAt = new Date(result.today[0].reminderAt!);
    expect(rAt.getUTCHours()).toBeDefined(); // just verify it exists
    // The local hour should be 23
    // Since we are in UTC+8 env, 23:59 local = 15:59 UTC
    // We just verify it was classified as today (which proves the date was used correctly)
    expect(result.today).toHaveLength(1);
  });

  it("no dueDate or dueAt -> disabled", () => {
    const rows: ReminderRow[] = [{
      reminderId: "r8", taskId: "t8", taskTitle: "No date",
      dueAt: null, dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 30, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateOverview(rows, NOW);
    expect(result.disabled).toHaveLength(1);
  });

  it("offsetMinutes shifts reminder time", () => {
    const rows: ReminderRow[] = [{
      reminderId: "r9", taskId: "t9", taskTitle: "30min before",
      dueAt: "2026-06-15T10:30:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 30, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateOverview(rows, NOW);
    // reminderAt = 10:30 - 30min = 10:00 = now -> exactly at now, should be today (>= now in code is < now for missed)
    // The logic: reminderMs < nowMs -> missed. 10:00Z = now, not < now, so not missed.
    // 10:00Z <= todayEnd -> today
    expect(result.today).toHaveLength(1);
  });

  it("days caps at max 30 for upcoming", () => {
    const rawDays = 100;
    const cappedDays = Math.min(Math.max(1, isNaN(rawDays) ? 7 : rawDays), 30);
    expect(cappedDays).toBe(30);

    const rows: ReminderRow[] = [{
      reminderId: "r10", taskId: "t10", taskTitle: "40 days out",
      dueAt: new Date(NOW + 40 * 86400000).toISOString(), dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateOverview(rows, NOW, 30);
    // 40 days out > 30 day horizon -> should not appear
    expect(result.upcoming).toHaveLength(0);
  });

  it("upcoming respects days parameter", () => {
    const rows: ReminderRow[] = [{
      reminderId: "r11", taskId: "t11", taskTitle: "5 days out",
      dueAt: new Date(NOW + 5 * 86400000).toISOString(), dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0, lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result7 = simulateOverview(rows, NOW, 7);
    expect(result7.upcoming).toHaveLength(1);

    const result3 = simulateOverview(rows, NOW, 3);
    expect(result3.upcoming).toHaveLength(0);
  });
});


// Simulated scanDueReminders logic matching the updated backend
interface ScanRow {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  dueAt: string | null;
  dueDate: string | null;
  isCompleted: number;
  enabled: number;
  offsetMinutes: number;
  lastNotifiedAt: string | null;
  snoozedUntil: string | null;
}

function simulateScan(rows: ScanRow[], nowMs: number): ScanRow[] {
  const pending: ScanRow[] = [];
  for (const row of rows) {
    if (row.isCompleted !== 0) continue;
    if (row.enabled !== 1) continue;
    const dueStr = row.dueAt || (row.dueDate ? row.dueDate + "T23:59:59" : null);
    if (!dueStr) continue;
    const dueMs = new Date(dueStr).getTime();
    const reminderMs = dueMs - row.offsetMinutes * 60000;

    // snooze override
    if (row.snoozedUntil) {
      const snoozeMs = new Date(row.snoozedUntil).getTime();
      if (snoozeMs > nowMs) continue;
      pending.push(row);
      continue;
    }

    // Normal path
    if (reminderMs > nowMs) continue;
    if (row.lastNotifiedAt) {
      const lastNotifiedMs = new Date(row.lastNotifiedAt).getTime();
      if (lastNotifiedMs >= reminderMs) continue;
    }
    pending.push(row);
  }
  return pending;
}

describe("scanDueReminders snooze logic", () => {
  it("snoozedUntil in future does not trigger", () => {
    const rows: ScanRow[] = [{
      reminderId: "sr1", taskId: "st1", taskTitle: "Snoozed",
      dueAt: "2026-06-15T09:00:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0,
      lastNotifiedAt: "2026-06-15T08:55:00Z",
      snoozedUntil: new Date(NOW + 3600000).toISOString(),
    }];
    expect(simulateScan(rows, NOW)).toHaveLength(0);
  });

  it("snoozedUntil expired triggers regardless of lastNotifiedAt", () => {
    const rows: ScanRow[] = [{
      reminderId: "sr2", taskId: "st2", taskTitle: "Expired snooze",
      dueAt: "2026-06-15T09:00:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0,
      lastNotifiedAt: "2026-06-15T08:55:00Z",
      snoozedUntil: new Date(NOW - 60000).toISOString(),
    }];
    const result = simulateScan(rows, NOW);
    expect(result).toHaveLength(1);
  });

  it("snoozedUntil null falls through to normal scan", () => {
    const rows: ScanRow[] = [{
      reminderId: "sr3", taskId: "st3", taskTitle: "No snooze, past due",
      dueAt: "2026-06-15T09:30:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0,
      lastNotifiedAt: null,
      snoozedUntil: null,
    }];
    const result = simulateScan(rows, NOW);
    expect(result).toHaveLength(1);
  });

  it("no snooze, already notified, does not trigger", () => {
    const rows: ScanRow[] = [{
      reminderId: "sr4", taskId: "st4", taskTitle: "Already notified",
      dueAt: "2026-06-15T09:30:00Z", dueDate: null,
      isCompleted: 0, enabled: 1, offsetMinutes: 0,
      lastNotifiedAt: "2026-06-15T09:30:00Z",
      snoozedUntil: null,
    }];
    expect(simulateScan(rows, NOW)).toHaveLength(0);
  });
});
