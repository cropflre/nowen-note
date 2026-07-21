import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskCenter from "../TaskCenter";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
    getTasks: vi.fn(),
    getTaskStats: vi.fn(),
    getTaskDependencies: vi.fn(),
    getReminderOverview: vi.fn(),
    getHabits: vi.fn(),
    getHabitStats: vi.fn(),
    getHabitCheckinLog: vi.fn(),
    createTask: vi.fn(),
    createTaskReminder: vi.fn(),
    toggleTask: vi.fn(),
    deleteTask: vi.fn(),
    updateTask: vi.fn(),
    createTaskDependency: vi.fn(),
    deleteTaskDependency: vi.fn(),
    batchTasks: vi.fn(),
    reorderTasks: vi.fn(),
    getTaskProjects: vi.fn(),
    createTaskProject: vi.fn(),
    updateTaskProject: vi.fn(),
    deleteTaskProject: vi.fn(),
    archiveHabit: vi.fn(),
    deleteHabit: vi.fn(),
    checkInHabit: vi.fn(),
    createHabit: vi.fn(),
    taskAttachmentsBind: vi.fn(),
    childQuickAddTitle: "今天下午3点 子任务 提前3小时",
    statsCenterProps: [] as any[],
}));

const i18nMocks = vi.hoisted(() => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
}));

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: i18nMocks.t, i18n: { language: "zh-CN" } }),
}));

vi.mock("@/lib/toast", () => ({
    toast: {
        success: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock("@/lib/api", () => ({
    getCurrentWorkspace: () => "personal",
    api: {
        getTasks: apiMocks.getTasks,
        getTaskStats: apiMocks.getTaskStats,
        getTaskDependencies: apiMocks.getTaskDependencies,
        getReminderOverview: apiMocks.getReminderOverview,
        getHabits: apiMocks.getHabits,
        getHabitStats: apiMocks.getHabitStats,
        getHabitCheckinLog: apiMocks.getHabitCheckinLog,
        createTask: apiMocks.createTask,
        createTaskReminder: apiMocks.createTaskReminder,
        toggleTask: apiMocks.toggleTask,
        deleteTask: apiMocks.deleteTask,
        updateTask: apiMocks.updateTask,
        createTaskDependency: apiMocks.createTaskDependency,
        deleteTaskDependency: apiMocks.deleteTaskDependency,
        batchTasks: apiMocks.batchTasks,
        reorderTasks: apiMocks.reorderTasks,
        getTaskProjects: apiMocks.getTaskProjects,
        createTaskProject: apiMocks.createTaskProject,
        updateTaskProject: apiMocks.updateTaskProject,
        deleteTaskProject: apiMocks.deleteTaskProject,
        archiveHabit: apiMocks.archiveHabit,
        deleteHabit: apiMocks.deleteHabit,
        checkInHabit: apiMocks.checkInHabit,
        createHabit: apiMocks.createHabit,
        taskAttachments: {
            bind: apiMocks.taskAttachmentsBind,
        },
    },
}));

vi.mock("../tasks/useReminderNotifier", () => ({
    useReminderNotifier: () => { },
}));

vi.mock("../tasks/taskSearch", () => ({
    taskMatchesSearch: () => true,
}));

vi.mock("../tasks/useTaskTree", () => ({
    useTaskTree: (tasks: any[]) => ({
        flatOrderedTasks: tasks.map((node) => ({ node, depth: 0 })),
        expandedTaskIds: new Set<string>(),
        toggleExpand: vi.fn(),
        isTreeMode: false,
    }),
}));

vi.mock("../tasks/useTaskProjects", () => ({
    useTaskProjects: () => ({
        projects: [],
        selectedProjectId: null,
        setSelectedProjectId: vi.fn(),
        createProject: vi.fn(),
        updateProject: vi.fn(),
        deleteProject: vi.fn(),
        refreshCounts: vi.fn(),
        reload: vi.fn(),
    }),
}));

vi.mock("../tasks/TaskOverview", () => ({ TaskOverview: () => null }));
vi.mock("../tasks/TaskTreeRow", () => ({ TaskTreeRow: () => null }));
vi.mock("../tasks/TaskEmptyState", () => ({ TaskEmptyState: () => null }));
vi.mock("../tasks/TaskDetailPanel", () => ({ TaskDetailPanel: () => null }));
vi.mock("../tasks/FlatTaskRow", () => ({
    FlatTaskRow: ({ task, onCreateChild }: any) => (
        <button
            data-testid={`create-child-${task.id}`}
            onClick={() => void onCreateChild(apiMocks.childQuickAddTitle, task.id)}
        >
            create child
        </button>
    ),
}));
vi.mock("../tasks/TaskBoardView", () => ({ TaskBoardView: () => null }));
vi.mock("../tasks/TaskCalendarView", () => ({ TaskCalendarView: () => null }));
vi.mock("../tasks/TaskGanttView", () => ({ default: () => null }));
vi.mock("../tasks/TaskTemplatePicker", () => ({ TaskTemplatePicker: () => null }));
vi.mock("../tasks/ReminderCenter", () => ({ ReminderCenter: () => null }));
vi.mock("../tasks/TaskCalendarFeedSettings", () => ({ TaskCalendarFeedSettings: () => null }));
vi.mock("../tasks/CalendarExportTargetSettings", () => ({ CalendarExportTargetSettings: () => null }));
vi.mock("../tasks/MobileProjectPicker", () => ({
    MobileProjectTrigger: () => null,
    MobileProjectPicker: () => null,
}));
vi.mock("../tasks/HabitStatsOverview", () => ({ HabitStatsOverview: () => null }));
vi.mock("../tasks/HabitRow", () => ({
    HabitRow: ({ habit, onArchiveToggle, onDelete }: any) => (
        <div>
            <span>{habit.title}</span>
            <button data-testid={`archive-toggle-${habit.id}`} onClick={() => void onArchiveToggle(habit, !habit.archivedAt)}>
                archive toggle
            </button>
            <button data-testid={`delete-habit-${habit.id}`} onClick={() => void onDelete(habit)}>
                delete habit
            </button>
        </div>
    ),
}));
vi.mock("../tasks/StatsCenter", () => ({
    StatsCenter: (props: any) => {
        apiMocks.statsCenterProps.push(props);
        return <div data-testid="stats-center">stats center</div>;
    },
}));

vi.mock("../tasks/TaskQuickAdd", () => ({
    TaskQuickAdd: ({ value, onChange, onSubmit, inputRef }: any) => (
        <div>
            <input
                data-testid="quick-add-input"
                ref={inputRef}
                value={value}
                onInput={(e) => onChange((e.target as HTMLInputElement).value)}
            />
            <button data-testid="quick-add-submit" onClick={() => void onSubmit([])}>
                submit
            </button>
        </div>
    ),
}));

function makeTask(overrides: Record<string, any> = {}) {
    return {
        id: "task-1",
        userId: "u1",
        workspaceId: null,
        title: "task",
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
        createdAt: "2026-01-01T00:00:00",
        updatedAt: "2026-01-01T00:00:00",
        ...overrides,
    };
}

function makeHabit(overrides: Record<string, any> = {}) {
    return {
        id: "habit-1",
        userId: "u1",
        workspaceId: null,
        title: "habit",
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

function makeHabitStats() {
    return {
        totalCheckins: 0,
        checkinDays: 0,
        currentStreak: 0,
        successCount: 0,
        partialCount: 0,
        failureCount: 0,
    };
}

function makeHabitCheckinLogItem(overrides: Record<string, any> = {}) {
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
        habitTitle: "habit",
        habitColor: "#10b981",
        habitIcon: "check-circle",
        habitArchivedAt: null,
        canManage: true,
        ...overrides,
    };
}

function makeStats() {
    return { total: 0, completed: 0, pending: 0, today: 0, overdue: 0, week: 0 };
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

async function renderTaskCenter(root: Root) {
    await act(async () => {
        root.render(<TaskCenter />);
        await flush();
    });
}

describe("TaskCenter quick-add integration", () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-08T10:00:00"));

        apiMocks.getTasks.mockResolvedValue([]);
        apiMocks.getTaskStats.mockResolvedValue(makeStats());
        apiMocks.getTaskDependencies.mockResolvedValue([]);
        apiMocks.getReminderOverview.mockResolvedValue({ missed: [], today: [], upcoming: [], disabled: [] });
        apiMocks.getHabits.mockResolvedValue([]);
        apiMocks.getHabitStats.mockResolvedValue(makeHabitStats());
        apiMocks.getHabitCheckinLog.mockResolvedValue([]);
        apiMocks.createTask.mockResolvedValue(makeTask({ id: "new-task" }));
        apiMocks.createTaskReminder.mockResolvedValue({ id: "r1" });
        apiMocks.archiveHabit.mockImplementation(async (id: string, archived: boolean) => makeHabit({ id, archivedAt: archived ? "2026-07-08T00:00:00" : null }));
        apiMocks.deleteHabit.mockResolvedValue({ success: true });
        apiMocks.checkInHabit.mockResolvedValue({ id: "check-1", habitId: "habit-1", status: "success", note: "", checkinDate: "2026-07-08" });
        apiMocks.createHabit.mockResolvedValue(makeHabit({ id: "habit-new" }));
        apiMocks.childQuickAddTitle = "今天下午3点 子任务 提前3小时";
        apiMocks.statsCenterProps.length = 0;

        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        document.body.innerHTML = "";
        Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it("creates task with parsed fields and creates reminders", async () => {
        await renderTaskCenter(root);

        const input = host.querySelector<HTMLInputElement>("[data-testid='quick-add-input']");
        const submit = host.querySelector<HTMLButtonElement>("[data-testid='quick-add-submit']");
        expect(input).not.toBeNull();
        expect(submit).not.toBeNull();

        await act(async () => {
            input!.value = "今天下午3点 开会 提前3小时";
            input!.dispatchEvent(new Event("input", { bubbles: true }));
            await flush();
        });

        await act(async () => {
            submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        expect(apiMocks.createTask).toHaveBeenCalledTimes(1);
        expect(apiMocks.createTask).toHaveBeenCalledWith(expect.objectContaining({
            title: "开会",
            dueDate: "2026-07-08",
            dueAt: "2026-07-08T15:00",
        }));

        expect(apiMocks.createTaskReminder).toHaveBeenCalledTimes(2);
        expect(apiMocks.createTaskReminder).toHaveBeenNthCalledWith(1, "new-task", 0);
        expect(apiMocks.createTaskReminder).toHaveBeenNthCalledWith(2, "new-task", 180);

        expect(input!.value).toBe("");
    });

    it("disables task reorder dragging while offline", async () => {
        Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
        apiMocks.getTasks.mockResolvedValueOnce([makeTask({ id: "offline-task" })]);

        await renderTaskCenter(root);

        expect(host.textContent).toContain("离线时暂不支持拖拽排序");
        expect(host.querySelector("[draggable='true']")).toBeNull();
    });

    it("continues when one reminder creation fails", async () => {
        await renderTaskCenter(root);

        apiMocks.createTaskReminder
            .mockRejectedValueOnce(new Error("network"))
            .mockResolvedValueOnce({ id: "r-ok" });

        const input = host.querySelector<HTMLInputElement>("[data-testid='quick-add-input']");
        const submit = host.querySelector<HTMLButtonElement>("[data-testid='quick-add-submit']");

        await act(async () => {
            input!.value = "今天下午3点 开会 提前3小时";
            input!.dispatchEvent(new Event("input", { bubbles: true }));
            await flush();
        });

        await act(async () => {
            submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        expect(apiMocks.createTask).toHaveBeenCalledTimes(1);
        expect(apiMocks.createTaskReminder).toHaveBeenCalledTimes(2);
        expect(input!.value).toBe("");
    });

    it("creates custom repeat task with object repeatRuleJson payload", async () => {
        await renderTaskCenter(root);

        const input = host.querySelector<HTMLInputElement>("[data-testid='quick-add-input']");
        const submit = host.querySelector<HTMLButtonElement>("[data-testid='quick-add-submit']");

        await act(async () => {
            input!.value = "每个工作日 写日报";
            input!.dispatchEvent(new Event("input", { bubbles: true }));
            await flush();
        });

        await act(async () => {
            submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        expect(apiMocks.createTask).toHaveBeenCalledWith(expect.objectContaining({
            title: "写日报",
            repeatRule: "custom",
            repeatRuleJson: { frequency: "week", interval: 1, weekdays: [1, 2, 3, 4, 5] },
        }));
    });

    it("creates child task with parsed fields and reminders", async () => {
        apiMocks.getTasks.mockResolvedValueOnce([makeTask({ id: "parent-task", title: "parent" })]);

        await renderTaskCenter(root);

        const childButton = host.querySelector<HTMLButtonElement>("[data-testid='create-child-parent-task']");
        expect(childButton).not.toBeNull();

        await act(async () => {
            childButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        expect(apiMocks.createTask).toHaveBeenCalledWith(expect.objectContaining({
            title: "子任务",
            parentId: "parent-task",
            dueDate: "2026-07-08",
            dueAt: "2026-07-08T15:00",
        }));

        expect(apiMocks.createTaskReminder).toHaveBeenCalledTimes(2);
        expect(apiMocks.createTaskReminder).toHaveBeenNthCalledWith(1, "new-task", 0);
        expect(apiMocks.createTaskReminder).toHaveBeenNthCalledWith(2, "new-task", 180);
    });

    it("does not inherit parent recognized fields when child title has none", async () => {
        apiMocks.childQuickAddTitle = "子任务";
        apiMocks.getTasks.mockResolvedValueOnce([
            makeTask({
                id: "parent-task",
                title: "parent",
                projectId: "project-1",
                dueDate: "2026-07-08",
                dueAt: "2026-07-08T15:00",
                repeatRule: "daily",
                repeatInterval: 1,
                repeatRuleJson: JSON.stringify({ frequency: "day", interval: 1 }),
            }),
        ]);

        await renderTaskCenter(root);

        const childButton = host.querySelector<HTMLButtonElement>("[data-testid='create-child-parent-task']");
        expect(childButton).not.toBeNull();

        await act(async () => {
            childButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        const payload = apiMocks.createTask.mock.calls[0][0];
        expect(payload).toMatchObject({
            title: "子任务",
            parentId: "parent-task",
            projectId: "project-1",
        });
        expect(payload).not.toHaveProperty("dueDate");
        expect(payload).not.toHaveProperty("dueAt");
        expect(payload).not.toHaveProperty("repeatRule");
        expect(payload).not.toHaveProperty("repeatInterval");
        expect(payload).not.toHaveProperty("repeatRuleJson");
        expect(apiMocks.createTaskReminder).not.toHaveBeenCalled();
    });

    it("unarchives habit and keeps it visible in active list", async () => {
        apiMocks.getHabits.mockResolvedValueOnce([
            makeHabit({ id: "habit-archived", title: "已归档习惯", archivedAt: "2026-07-07T00:00:00" }),
        ]);
        apiMocks.archiveHabit.mockResolvedValueOnce(
            makeHabit({ id: "habit-archived", title: "已归档习惯", archivedAt: null }),
        );

        await renderTaskCenter(root);

        const habitsTab = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("habits.title"));
        expect(habitsTab).not.toBeUndefined();

        await act(async () => {
            habitsTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        const archivedFilter = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "habits.filters.archived");
        expect(archivedFilter).not.toBeUndefined();

        await act(async () => {
            archivedFilter!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        const toggle = host.querySelector<HTMLButtonElement>("[data-testid='archive-toggle-habit-archived']");
        expect(toggle).not.toBeNull();

        await act(async () => {
            toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        const activeFilter = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "habits.filters.active");
        expect(activeFilter).not.toBeUndefined();

        await act(async () => {
            activeFilter!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        expect(apiMocks.archiveHabit).toHaveBeenCalledWith("habit-archived", false);
        expect(host.textContent).toContain("已归档习惯");
    });

    it("deletes habit from archived list", async () => {
        apiMocks.getHabits.mockResolvedValueOnce([
            makeHabit({ id: "habit-delete", title: "待删除习惯", archivedAt: "2026-07-07T00:00:00" }),
        ]);

        await renderTaskCenter(root);

        const habitsTab = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("habits.title"));
        await act(async () => {
            habitsTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        const archivedFilter = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "habits.filters.archived");
        await act(async () => {
            archivedFilter!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        const del = host.querySelector<HTMLButtonElement>("[data-testid='delete-habit-habit-delete']");
        expect(del).not.toBeNull();

        await act(async () => {
            del!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        expect(apiMocks.deleteHabit).toHaveBeenCalledWith("habit-delete");
        expect(host.textContent).not.toContain("待删除习惯");
    });

    it("loads statistics data and passes it to stats center", async () => {
        vi.useRealTimers();
        apiMocks.getTasks.mockResolvedValue([makeTask({ id: "task-stats", title: "统计任务", completedAt: "2026-07-08T09:00:00" })]);
        apiMocks.getTaskStats.mockResolvedValue({ total: 1, completed: 1, pending: 0, today: 0, overdue: 0, week: 1 });
        apiMocks.getHabits.mockResolvedValue([makeHabit({ id: "habit-stats", title: "统计习惯" })]);
        apiMocks.getHabitStats.mockResolvedValue({ totalCheckins: 2, checkinDays: 2, currentStreak: 2, successCount: 2, partialCount: 0, failureCount: 0 });
        apiMocks.getHabitCheckinLog.mockResolvedValue([makeHabitCheckinLogItem({ habitId: "habit-stats", habitTitle: "统计习惯" })]);

        await renderTaskCenter(root);

        const statsTab = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("stats.title"));
        expect(statsTab).not.toBeUndefined();

        await act(async () => {
            statsTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        await vi.waitFor(() => {
            expect(apiMocks.getHabitCheckinLog).toHaveBeenCalledTimes(1);
            expect(apiMocks.statsCenterProps.at(-1)).toMatchObject({
                tasks: [expect.objectContaining({ id: "task-stats" })],
                habits: [expect.objectContaining({ id: "habit-stats" })],
                checkins: [expect.objectContaining({ habitId: "habit-stats" })],
                loading: false,
            });
        });

        expect(host.querySelector("[data-testid='stats-center']")).not.toBeNull();
    });

    it("reloads statistics data after workspace change while staying on stats tab", async () => {
        vi.useRealTimers();
        let workspacePhase = 0;

        apiMocks.getTasks.mockImplementation(async (filter?: string) => {
            if (filter === "all") {
                return workspacePhase === 0
                    ? [makeTask({ id: "task-old", title: "旧工作区任务", completedAt: "2026-07-08T09:00:00" })]
                    : [makeTask({ id: "task-new", title: "新工作区任务", completedAt: "2026-07-09T09:00:00" })];
            }
            return [];
        });
        apiMocks.getTaskStats.mockImplementation(async () => (
            workspacePhase === 0
                ? { total: 1, completed: 1, pending: 0, today: 0, overdue: 0, week: 1 }
                : { total: 1, completed: 0, pending: 1, today: 0, overdue: 0, week: 0 }
        ));
        apiMocks.getHabits.mockImplementation(async () => (
            workspacePhase === 0
                ? [makeHabit({ id: "habit-old", title: "旧工作区习惯" })]
                : [makeHabit({ id: "habit-new", title: "新工作区习惯" })]
        ));
        apiMocks.getHabitStats.mockImplementation(async () => (
            workspacePhase === 0
                ? { totalCheckins: 1, checkinDays: 1, currentStreak: 1, successCount: 1, partialCount: 0, failureCount: 0 }
                : { totalCheckins: 2, checkinDays: 2, currentStreak: 2, successCount: 2, partialCount: 0, failureCount: 0 }
        ));
        apiMocks.getHabitCheckinLog.mockImplementation(async () => (
            workspacePhase === 0
                ? [makeHabitCheckinLogItem({ id: "check-old", habitId: "habit-old", habitTitle: "旧工作区习惯" })]
                : [makeHabitCheckinLogItem({ id: "check-new", habitId: "habit-new", habitTitle: "新工作区习惯", checkinDate: "2026-07-09" })]
        ));

        await renderTaskCenter(root);

        const statsTab = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("stats.title"));
        expect(statsTab).not.toBeUndefined();

        await act(async () => {
            statsTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await flush();
        });

        await vi.waitFor(() => {
            expect(apiMocks.statsCenterProps.at(-1)).toMatchObject({
                tasks: [expect.objectContaining({ id: "task-old" })],
                habits: [expect.objectContaining({ id: "habit-old" })],
                checkins: [expect.objectContaining({ id: "check-old" })],
            });
        });
        expect(apiMocks.getHabitCheckinLog).toHaveBeenCalledTimes(1);

        workspacePhase = 1;

        await act(async () => {
            window.dispatchEvent(new Event("nowen:workspace-changed"));
            await flush();
        });

        await vi.waitFor(() => {
            expect(apiMocks.getHabitCheckinLog).toHaveBeenCalledTimes(2);
        });
        await act(async () => {
            await flush();
        });
        await vi.waitFor(() => {
            expect(apiMocks.statsCenterProps.at(-1)).toMatchObject({
                tasks: [expect.objectContaining({ id: "task-new" })],
                habits: [expect.objectContaining({ id: "habit-new" })],
                checkins: [expect.objectContaining({ id: "check-new" })],
            });
        });
    });
});
