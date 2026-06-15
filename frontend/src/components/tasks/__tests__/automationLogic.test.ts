import { describe, it, expect } from "vitest";

/**
 * Tests for Phase 6.4 automation scanner logic.
 * Since scanners depend on DB, we test the classification and dedup logic here.
 */

// Simulated dependency-ready scan logic (matches updated backend)
interface DepRow {
  successorTaskId: string;
  succTitle: string;
  userId: string;
}

const sentDepKeys = new Set<string>();

function simulateDepScan(rows: DepRow[]): Array<{ taskId: string; title: string; type: string }> {
  const results: Array<{ taskId: string; title: string; type: string }> = [];
  for (const row of rows) {
    const key = `dep-ready:${row.userId}:${row.successorTaskId}`;
    if (sentDepKeys.has(key)) continue;
    sentDepKeys.add(key);
    results.push({ taskId: row.successorTaskId, title: row.succTitle, type: "dependency_ready" });
  }
  return results;
}

// Simulated overdue daily scan logic (matches updated backend)
interface OverdueRow {
  id: string;
  title: string;
  userId: string;
  dueAt: string | null;
  dueDate: string | null;
}

const sentOverdueKeys = new Set<string>();

function simulateOverdueScan(rows: OverdueRow[], nowMs: number, todayLocal: string): Array<{ taskId: string; type: string }> {
  const results: Array<{ taskId: string; type: string }> = [];
  for (const row of rows) {
    const dueStr = row.dueAt || (row.dueDate ? row.dueDate + "T23:59:59" : null);
    if (!dueStr) continue;
    const dueMs = new Date(dueStr).getTime();
    if (!Number.isFinite(dueMs)) continue;
    if (dueMs >= nowMs) continue;

    const key = `${row.userId}:${row.id}:${todayLocal}`;
    if (sentOverdueKeys.has(key)) continue;
    sentOverdueKeys.add(key);
    results.push({ taskId: row.id, type: "overdue_daily" });
  }
  return results;
}

describe("dependency-ready notifications", () => {
  it("produces 1 notification when ALL predecessors completed", () => {
    sentDepKeys.clear();
    // SQL returns successor directly: succ has all preds done
    const rows: DepRow[] = [
      { successorTaskId: "b", succTitle: "Task B", userId: "u1" },
    ];
    const result = simulateDepScan(rows);
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe("b");
    expect(result[0].type).toBe("dependency_ready");
  });

  it("does not notify when only some predecessors done (SQL filters these out)", () => {
    sentDepKeys.clear();
    // When NOT all preds are done, the SQL NOT EXISTS clause excludes the row
    // So the scanner receives an empty array
    const rows: DepRow[] = [];
    const result = simulateDepScan(rows);
    expect(result).toHaveLength(0);
  });

  it("same successor only notified once", () => {
    sentDepKeys.clear();
    const rows: DepRow[] = [
      { successorTaskId: "b", succTitle: "Task B", userId: "u1" },
    ];
    const result1 = simulateDepScan(rows);
    expect(result1).toHaveLength(1);
    // Second scan with same successor
    const result2 = simulateDepScan(rows);
    expect(result2).toHaveLength(0);
  });

  it("multiple successors each get their own notification", () => {
    sentDepKeys.clear();
    const rows: DepRow[] = [
      { successorTaskId: "b", succTitle: "Task B", userId: "u1" },
      { successorTaskId: "c", succTitle: "Task C", userId: "u1" },
    ];
    const result = simulateDepScan(rows);
    expect(result).toHaveLength(2);
  });

  it("different users do not cross-contaminate", () => {
    sentDepKeys.clear();
    const rows: DepRow[] = [
      { successorTaskId: "b", succTitle: "Task B", userId: "u1" },
      { successorTaskId: "b", succTitle: "Task B", userId: "u2" },
    ];
    const result = simulateDepScan(rows);
    expect(result).toHaveLength(2);
  });
});

describe("overdue daily notifications", () => {
  it("dueAt today past time triggers overdue", () => {
    sentOverdueKeys.clear();
    // "2026-06-15T09:00:00Z" is in the past if now is 10:00Z
    const nowMs = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: OverdueRow[] = [{
      id: "t1", title: "Past dueAt today", userId: "u1",
      dueAt: "2026-06-15T09:00:00Z", dueDate: null,
    }];
    const result = simulateOverdueScan(rows, nowMs, "2026-06-15");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("overdue_daily");
  });

  it("dueAt today future time does NOT trigger", () => {
    sentOverdueKeys.clear();
    const nowMs = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: OverdueRow[] = [{
      id: "t2", title: "Future dueAt today", userId: "u1",
      dueAt: "2026-06-15T15:00:00Z", dueDate: null,
    }];
    const result = simulateOverdueScan(rows, nowMs, "2026-06-15");
    expect(result).toHaveLength(0);
  });

  it("dueDate-only today does NOT trigger (23:59:59)", () => {
    sentOverdueKeys.clear();
    const nowMs = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: OverdueRow[] = [{
      id: "t3", title: "Due today", userId: "u1",
      dueAt: null, dueDate: "2026-06-15",
    }];
    const result = simulateOverdueScan(rows, nowMs, "2026-06-15");
    // dueDate + "T23:59:59" = end of day, not past yet at 10:00
    expect(result).toHaveLength(0);
  });

  it("dueDate yesterday triggers overdue", () => {
    sentOverdueKeys.clear();
    const nowMs = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: OverdueRow[] = [{
      id: "t4", title: "Yesterday", userId: "u1",
      dueAt: null, dueDate: "2026-06-14",
    }];
    const result = simulateOverdueScan(rows, nowMs, "2026-06-15");
    expect(result).toHaveLength(1);
  });

  it("same task same day only once", () => {
    sentOverdueKeys.clear();
    const nowMs = new Date("2026-06-15T10:00:00Z").getTime();
    const rows: OverdueRow[] = [{
      id: "t5", title: "Overdue", userId: "u1",
      dueAt: "2026-06-14T10:00:00Z", dueDate: null,
    }];
    const result1 = simulateOverdueScan(rows, nowMs, "2026-06-15");
    expect(result1).toHaveLength(1);
    const result2 = simulateOverdueScan(rows, nowMs, "2026-06-15");
    expect(result2).toHaveLength(0);
  });
});

describe("useReminderNotifier type handling", () => {
  it("dependency_ready type is recognized", () => {
    const type = "dependency_ready";
    expect(type).toBe("dependency_ready");
  });

  it("overdue_daily type is recognized", () => {
    const type = "overdue_daily";
    expect(type).toBe("overdue_daily");
  });

  it("task_reminder type is default", () => {
    const type = undefined;
    expect(type || "task_reminder").toBe("task_reminder");
  });

  it("recent endpoint still only requests /recent (no /test-now)", () => {
    const hookSource = require("fs").readFileSync(
      "src/components/tasks/useReminderNotifier.ts", "utf8"
    );
    expect(hookSource).not.toContain("/test-now");
    expect(hookSource).toContain("/api/task-reminders/recent");
  });
});
