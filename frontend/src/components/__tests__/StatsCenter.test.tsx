import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Habit, HabitCheckinListItem, Task } from "@/types";
import { StatsCenter } from "../tasks/StatsCenter";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (typeof params?.defaultValue === "string") return params.defaultValue;
      if (!params || Object.keys(params).length === 0) return key;
      return `${key}:${JSON.stringify(params)}`;
    },
    i18n: { language: "en-US" },
  }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    userId: "u1",
    workspaceId: null,
    title: "Task One",
    description: "",
    isCompleted: 0,
    priority: 2,
    dueDate: null,
    dueAt: null,
    noteId: null,
    parentId: null,
    sortOrder: 0,
    projectId: null,
    status: "todo",
    createdAt: "2026-07-08T08:00:00",
    updatedAt: "2026-07-08T08:00:00",
    completedAt: null,
    ...overrides,
  };
}

function makeHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: "habit-1",
    userId: "u1",
    workspaceId: null,
    title: "Habit One",
    icon: "check-circle",
    color: "#10b981",
    sortOrder: 0,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00",
    updatedAt: "2026-01-01T00:00:00",
    todayStatus: null,
    todayNote: null,
    todayCheckinDate: null,
    canManage: true,
    ...overrides,
  };
}

function makeCheckin(overrides: Partial<HabitCheckinListItem> = {}): HabitCheckinListItem {
  return {
    id: "checkin-1",
    habitId: "habit-1",
    userId: "u1",
    workspaceId: null,
    checkinDate: "2026-07-08",
    status: "success",
    note: "done",
    createdAt: "2026-07-08T08:00:00",
    updatedAt: "2026-07-08T08:00:00",
    habitTitle: "Habit One",
    habitColor: "#10b981",
    habitIcon: "check-circle",
    habitArchivedAt: null,
    canManage: true,
    ...overrides,
  };
}

function renderStats(root: Root, props: Partial<React.ComponentProps<typeof StatsCenter>> = {}) {
  const defaultProps: React.ComponentProps<typeof StatsCenter> = {
    tasks: [],
    projects: [],
    taskStats: { total: 0, completed: 0, pending: 0, today: 0, overdue: 0, week: 0 },
    habits: [],
    habitStats: { totalCheckins: 0, checkinDays: 0, currentStreak: 0, successCount: 0, partialCount: 0, failureCount: 0 },
    checkins: [],
    loading: false,
    onRefresh: vi.fn(),
  };

  return act(async () => {
    root.render(<StatsCenter {...defaultProps} {...props} />);
    await Promise.resolve();
  });
}

function clickButton(host: HTMLDivElement, text: string) {
  const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  expect(button).toBeDefined();
  return act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("StatsCenter", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T10:00:00"));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("renders task records, weekly trends, and heatmap from completedAt", async () => {
    await renderStats(root, {
      tasks: [
        makeTask({ id: "task-a", title: "Task Alpha", createdAt: "2026-07-08T08:00:00", completedAt: "2026-07-08T09:00:00", isCompleted: 1, status: "done" }),
        makeTask({ id: "task-b", title: "Task Beta", createdAt: "2026-06-23T11:00:00", completedAt: "2026-06-25T12:30:00", isCompleted: 1, status: "done" }),
        makeTask({ id: "task-c", title: "Task Gamma", createdAt: "2026-01-03T07:00:00", completedAt: "2026-01-03T07:30:00", isCompleted: 1, status: "done" }),
      ],
      taskStats: { total: 3, completed: 3, pending: 0, today: 0, overdue: 0, week: 1 },
    });

    await clickButton(host, "stats.tabs.tasks");
    await clickButton(host, "stats.task.tabs.records");

    expect(host.textContent).toContain("Task Alpha");
    expect(host.textContent).toContain("Task Beta");
    expect(host.textContent).toContain("stats.task.recordCompleted");
    expect(host.textContent).toContain("stats.task.recordCreated");

    await clickButton(host, "stats.task.tabs.trends");

    expect(host.textContent).toContain("stats.task.trendTitle");
    expect(host.textContent).toContain('stats.task.trendLegend:{"created":1,"completed":1}');

    await clickButton(host, "stats.task.tabs.heatmap");

    expect(host.querySelector('[title="2026-07-08 · 1"]')).not.toBeNull();
    expect(host.querySelector('[title="2026-06-25 · 1"]')).not.toBeNull();
    expect(host.querySelector('[title="2026-01-03 · 1"]')).not.toBeNull();
  });

  it("renders project breakdown with real project names and stable grouping", async () => {
    await renderStats(root, {
      tasks: [
        makeTask({ id: "task-p1a", title: "Task P1 A", projectId: "project-1", isCompleted: 1, status: "done" }),
        makeTask({ id: "task-p1b", title: "Task P1 B", projectId: "project-1" }),
        makeTask({ id: "task-p2", title: "Task P2", projectId: "project-2", isCompleted: 1, status: "done" }),
        makeTask({ id: "task-none", title: "Task None", projectId: null }),
      ],
      projects: [
        { id: "project-1", userId: "u1", workspaceId: null, name: "Alpha", icon: "briefcase", color: "#111827", sortOrder: 0, createdAt: "2026-01-01T00:00:00", updatedAt: "2026-01-01T00:00:00" },
        { id: "project-2", userId: "u1", workspaceId: null, name: "Beta", icon: "briefcase", color: "#1d4ed8", sortOrder: 1, createdAt: "2026-01-01T00:00:00", updatedAt: "2026-01-01T00:00:00" },
      ],
      taskStats: { total: 4, completed: 2, pending: 2, today: 0, overdue: 0, week: 0 },
    });

    await clickButton(host, "stats.tabs.tasks");

    expect(host.textContent).toContain("Alpha");
    expect(host.textContent).toContain("Beta");
    expect(host.textContent).toContain("tasks.noProject");
    expect(host.textContent).toContain("1/2");
    expect(host.textContent).toContain("1/1");
    expect(host.textContent).not.toContain("已归类项目");
  });

  it("renders a completion summary and project progress bars on the dashboard", async () => {
    await renderStats(root, {
      tasks: [
        makeTask({ id: "task-done", isCompleted: 1, status: "done" }),
        makeTask({ id: "task-pending", projectId: "project-1" }),
      ],
      projects: [
        { id: "project-1", userId: "u1", workspaceId: null, name: "Alpha", icon: "briefcase", color: "#1d4ed8", sortOrder: 0, createdAt: "2026-01-01T00:00:00", updatedAt: "2026-01-01T00:00:00" },
      ],
      taskStats: { total: 2, completed: 1, pending: 1, today: 0, overdue: 0, week: 0 },
    });

    expect(host.querySelector('[data-testid="stats-completion-summary"]')).not.toBeNull();

    await clickButton(host, "stats.tabs.tasks");

    expect(host.querySelector('[data-testid="stats-project-progress"]')).not.toBeNull();
  });

  it("renders archived habit logs, active-only week view, and month/year summaries", async () => {
    await renderStats(root, {
      habits: [
        makeHabit({ id: "habit-active", title: "Morning Run", todayStatus: "partial" }),
        makeHabit({ id: "habit-archived", title: "Archived Reading", archivedAt: "2026-07-01T00:00:00" }),
      ],
      habitStats: { totalCheckins: 4, checkinDays: 4, currentStreak: 2, successCount: 2, partialCount: 1, failureCount: 1 },
      checkins: [
        makeCheckin({ id: "check-1", habitId: "habit-active", habitTitle: "Morning Run", checkinDate: "2026-07-06", status: "success", note: "5km" }),
        makeCheckin({ id: "check-2", habitId: "habit-archived", habitTitle: "Archived Reading", checkinDate: "2026-07-07", status: "failure", note: "missed" , habitArchivedAt: "2026-07-01T00:00:00"}),
        makeCheckin({ id: "check-3", habitId: "habit-active", habitTitle: "Morning Run", checkinDate: "2026-07-08", status: "partial", note: "2km" }),
        makeCheckin({ id: "check-4", habitId: "habit-archived", habitTitle: "Archived Reading", checkinDate: "2026-02-03", status: "success", note: "book" , habitArchivedAt: "2026-07-01T00:00:00"}),
      ],
    });

    await clickButton(host, "stats.tabs.habits");
    await clickButton(host, "stats.habit.tabs.log");

    expect(host.textContent).toContain("Archived Reading");
    expect(host.textContent).toContain("missed");

    await clickButton(host, "stats.habit.tabs.week");

    expect(host.textContent).toContain("Morning Run");
    expect(host.textContent).not.toContain("Archived Reading");
    expect(host.textContent).toContain("habits.status.success");
    expect(host.textContent).toContain("habits.status.partial");

    await clickButton(host, "stats.habit.tabs.month");

    expect(host.textContent).toContain("stats.habit.monthTitle");
    expect(host.textContent).toContain("2026 July");
    expect(host.querySelector('[title="2026-07-07 · 1"]')).not.toBeNull();
    expect(host.querySelector('[title="2026-07-08 · 1"]')).not.toBeNull();

    await clickButton(host, "stats.habit.tabs.year");

    expect(host.textContent).toContain("Feb");
    expect(host.textContent).toContain("Jul");
  });
});
