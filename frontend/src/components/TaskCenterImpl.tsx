import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Calendar, ListTodo, Sparkles,
  CalendarDays, AlertTriangle, CheckCheck, Inbox,
  Search, X as XIcon, GripVertical,
  CheckSquare, Trash2, Square,
  LayoutGrid, LayoutList, Calendar as CalendarIcon, BarChart3, FolderOpen, Plus, ChevronRight, Bell, Maximize2, Minimize2,
  Archive, MoreHorizontal, FileText, ClipboardPlus, Sun, CalendarClock, Download, Info, CheckCircle2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Portal as TooltipPortal } from "@radix-ui/react-tooltip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, getCurrentWorkspace } from "@/lib/api";
import { useAIConnectionAvailable } from "@/lib/aiConnection";
import { MOTION_SPRING } from "@/lib/motion";
import { toast } from "@/lib/toast";
import { Task, TaskFilter, TaskStats, TaskStatus, TaskProject, TaskDependency, Habit, HabitStats, HabitCheckinStatus, HabitCheckinListItem } from "@/types";
import { cn } from "@/lib/utils";
import { isTaskBlockedByDependency } from "./tasks/taskDependencyUtils";
import { formatAppTime } from "@/lib/dateTime";
import {
  TASK_CENTER_MAIN_CLASS,
  TASK_CENTER_ROOT_CLASS,
  TASK_MOBILE_FILTER_BAR_CLASS,
} from "@/lib/taskLayout";

// sub-components & utilities
import { useTaskTree } from "./tasks/useTaskTree";
import { buildTaskTree } from "./tasks/taskProgress";
import type { TaskTreeNode } from "./tasks/taskProgress";
import { TaskTreeRow } from "./tasks/TaskTreeRow";
import { TaskQuickAdd } from "./tasks/TaskQuickAdd";
import { TaskEmptyState } from "./tasks/TaskEmptyState";
import { TaskDetailPanel } from "./tasks/TaskDetailPanel";
import { FlatTaskRow } from "./tasks/FlatTaskRow";
import { useTaskProjects } from "./tasks/useTaskProjects";
import { TaskBoardView } from "./tasks/TaskBoardView";
import { TaskCalendarView } from "./tasks/TaskCalendarView";
import TaskGanttView from "./tasks/TaskGanttView";
import { compareTasksByDueTime, moveTaskToDate } from "./tasks/taskDateUtils";
import { haveSameTaskCompletionState, orderTasksCompletedLast } from "./tasks/taskCompletionOrder";
import { TaskTemplatePicker } from "./tasks/TaskTemplatePicker";
import { ReminderCenter } from "./tasks/ReminderCenter";
import { TaskCalendarFeedSettings } from "./tasks/TaskCalendarFeedSettings";
import { CalendarExportTargetSettings } from "./tasks/CalendarExportTargetSettings";
import { MobileProjectTrigger, MobileProjectPicker } from "./tasks/MobileProjectPicker";
import { taskMatchesSearch } from "./tasks/taskSearch";
import { parseTaskQuickAdd, type TaskQuickAddParseResult } from "./tasks/taskSmartRecognition";
import { resolveTaskQuickAddDraft, type TaskQuickAddManualMeta } from "./tasks/taskQuickAddDraft";
import { loadTaskViewMode, saveTaskViewMode, type TaskViewMode } from "./tasks/taskViewMode";
import { loadTaskDueSort, saveTaskDueSort } from "./tasks/taskDueSortPreference";
import { HabitStatsOverview } from "./tasks/HabitStatsOverview";
import { HabitRow } from "./tasks/HabitRow";
import { StatsCenter } from "./tasks/StatsCenter";
import { TaskInboxPanel } from "./tasks/TaskInboxPanel";
import { MyDayPanel } from "./tasks/MyDayPanel";
import { TaskTimePlanner } from "./tasks/TaskTimePlanner";
import { openTaskQuickCapture } from "@/lib/taskInboxApi";
import { openTaskDataTransfer } from "@/lib/taskDataTransferBridge";
import { exportTaskReport } from "@/lib/taskReportExport";
import { consumePendingTaskNotificationTaskId } from "@/lib/taskNotifications";
import { TASK_NOTIFICATION_OPEN_EVENT } from "@/lib/taskNotificationSchedule";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { useContextMenu } from "@/hooks/useContextMenu";
import { SubtaskInput, type SubtaskSchedule } from "./tasks/SubtaskInput";
import { isTaskCenterModuleVisible } from "@/lib/navigationVisibility";
const TaskSaveNoteDialog = React.lazy(() => import("./tasks/TaskSaveNoteDialog").then(module => ({ default: module.TaskSaveNoteDialog })));
const TaskRecurrenceDeleteDialog = React.lazy(() => import("./tasks/TaskRecurrenceDeleteDialog").then(module => ({ default: module.TaskRecurrenceDeleteDialog })));
const TaskContextMenu = React.lazy(() => import("./tasks/TaskContextMenu"));
const TaskComposer = React.lazy(() => import("./tasks/TaskComposer"));

export function formatLocalDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getDefaultTaskPatchForFilter(filter: TaskFilter): Partial<Task> {
  if (filter === "today") {
    return { dueDate: formatLocalDateKey() };
  }
  return {};
}

function getQuickAddCreatePatch(parsed: TaskQuickAddParseResult): Partial<Task> {
  const patch: Partial<Task> & { repeatRuleJson?: unknown } = { ...parsed.taskPatch };
  if (patch.repeatRule === "custom" && typeof patch.repeatRuleJson === "string") {
    try {
      patch.repeatRuleJson = JSON.parse(patch.repeatRuleJson);
    } catch {
      delete patch.repeatRuleJson;
    }
  }
  return patch as Partial<Task>;
}

/* ===== Main Component ===== */
export default function TaskCenter() {
  const { t } = useTranslation();
  const { prefs: userPrefs } = useUserPreferences();
  const aiAvailable = useAIConnectionAvailable();

  type CenterMode = "inbox" | "tasks" | "my-day" | "planner" | "habits" | "stats";
  type HabitListMode = "active" | "archived" | "all";

  const FILTERS: { key: TaskFilter; label: string; icon: React.ReactNode; colorClass: string }[] = [
    { key: "all", label: t("tasks.allTasks"), icon: <Inbox size={16} />, colorClass: "text-sky-500 dark:text-sky-400" },
    { key: "today", label: t("tasks.today"), icon: <CalendarDays size={16} />, colorClass: "text-indigo-500 dark:text-indigo-400" },
    { key: "week", label: t("tasks.next7Days"), icon: <Calendar size={16} />, colorClass: "text-violet-500 dark:text-violet-400" },
    { key: "overdue", label: t("tasks.overdue"), icon: <AlertTriangle size={16} />, colorClass: "text-rose-500 dark:text-rose-400" },
    { key: "completed", label: t("tasks.completed"), icon: <CheckCheck size={16} />, colorClass: "text-emerald-500 dark:text-emerald-400" },
    { key: "completed-today", label: t("tasks.lifecycle.completedToday"), icon: <CheckCheck size={16} />, colorClass: "text-teal-500 dark:text-teal-400" },
    { key: "archived", label: t("tasks.lifecycle.archived"), icon: <Archive size={16} />, colorClass: "text-slate-400 dark:text-slate-400" },
  ];

  const selectTaskFilter = (nextFilter: TaskFilter) => {
    setCenterMode("tasks");
    setFilter(nextFilter);
    setAssignedToMeOnly(false);
    setSelectedTaskId(null);
    setSearchQuery("");
    setSelectedProjectId(null);
  };

  const [tasks, setTasks] = useState<Task[]>([]);
  const [showTaskComposer, setShowTaskComposer] = useState(false);
  useEffect(() => {
    if (!aiAvailable) setShowTaskComposer(false);
  }, [aiAvailable]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [centerMode, setCenterMode] = useState<CenterMode>("tasks");

  useEffect(() => {
    if (!isTaskCenterModuleVisible(centerMode, userPrefs.hiddenTaskCenterModules)) {
      setCenterMode("tasks");
    }
  }, [centerMode, userPrefs.hiddenTaskCenterModules]);

  const [habits, setHabits] = useState<Habit[]>([]);
  const [habitStats, setHabitStats] = useState<HabitStats | null>(null);
  const [habitListMode, setHabitListMode] = useState<HabitListMode>("active");
  const [newHabitTitle, setNewHabitTitle] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [recurrenceDeleteTask, setRecurrenceDeleteTask] = useState<Task | null>(null);
  const { menu: taskMenu, menuRef: taskMenuRef, openMenu: openTaskMenu, openMenuAt: openTaskMenuAt, closeMenu: closeTaskMenu } = useContextMenu();
  const [contextChildTask, setContextChildTask] = useState<Task | null>(null);
  const [contextNoteTask, setContextNoteTask] = useState<Task | null>(null);
  const contextTask = tasks.find(task => task.id === taskMenu.targetId);
  const [newTitle, setNewTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingOrphansRef = useRef<string[]>([]);

  // Phase 4: search
  const [searchQuery, setSearchQuery] = useState("");
  const [workspaceVersion, setWorkspaceVersion] = useState(0);

  const [statsTasks, setStatsTasks] = useState<Task[]>([]);
  const [statsHabits, setStatsHabits] = useState<Habit[]>([]);
  const [statsHabitCheckins, setStatsHabitCheckins] = useState<HabitCheckinListItem[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const statsLoadGenerationRef = useRef(0);

  const activeHabits = useMemo(
    () => habits.filter((habit) => !habit.archivedAt),
    [habits],
  );

  const archivedHabits = useMemo(
    () => habits.filter((habit) => !!habit.archivedAt),
    [habits],
  );

  const visibleHabits = useMemo(() => {
    if (habitListMode === "archived") return archivedHabits;
    if (habitListMode === "all") return habits;
    return activeHabits;
  }, [activeHabits, archivedHabits, habitListMode, habits]);

  const pendingHabitCount = useMemo(
    () => activeHabits.filter((habit) => !habit.todayStatus).length,
    [activeHabits],
  );

  // Phase 5.2: dependencies
  const [dependencies, setDependencies] = useState<TaskDependency[]>([]);

  // Phase 4: projects
  const {
    projects,
    selectedProjectId,
    setSelectedProjectId,
    createProject,
    updateProject,
    deleteProject,
    refreshCounts,
    reload,
  } = useTaskProjects();

  const openTaskFromNotification = useCallback((taskId: string) => {
    if (!taskId) return;
    setCenterMode("tasks");
    setFilter("all");
    setSearchQuery("");
    setSelectedProjectId(null);
    setSelectedTaskId(taskId);
  }, [setSelectedProjectId]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId || "";
      openTaskFromNotification(taskId);
    };
    window.addEventListener(TASK_NOTIFICATION_OPEN_EVENT, onOpen);
    const pendingTaskId = consumePendingTaskNotificationTaskId();
    if (pendingTaskId) queueMicrotask(() => openTaskFromNotification(pendingTaskId));
    return () => window.removeEventListener(TASK_NOTIFICATION_OPEN_EVENT, onOpen);
  }, [openTaskFromNotification]);

  const [viewMode, setViewMode] = useState<TaskViewMode>(loadTaskViewMode);
  const changeViewMode = (mode: TaskViewMode) => {
    setViewMode(mode);
    saveTaskViewMode(mode);
  };

  // Phase 4: new project dialog
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [editingProject, setEditingProject] = useState<TaskProject | null>(null);
  const [editProjectName, setEditProjectName] = useState("");
  const [editProjectColor, setEditProjectColor] = useState("#6366f1");
  const [showProjectMenu, setShowProjectMenu] = useState<string | null>(null);
  const [mobileProjectOpen, setMobileProjectOpen] = useState(false);
  const isMobile = typeof navigator !== "undefined" && /Mobi|Android/i.test(navigator.userAgent);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showReminderCenter, setShowReminderCenter] = useState(false);
  const [taskFullscreen, setTaskFullscreen] = useState(false);
  const [reminderBadgeCount, setReminderBadgeCount] = useState(0);
  const [sortByDueTime, setSortByDueTime] = useState(loadTaskDueSort);
  useEffect(() => { saveTaskDueSort(sortByDueTime); }, [sortByDueTime]);
  const toggleDueSort = () => setSortByDueTime((previous) => !previous);

  // Phase 4: batch select mode
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Phase 4: drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const treeSourceTasks = useMemo(() => {
    const roots = tasks.filter((task) => !task.parentId);
    const children = tasks.filter((task) => task.parentId);
    return [
      ...orderTasksCompletedLast(roots, sortByDueTime ? compareTasksByDueTime : undefined),
      ...orderTasksCompletedLast(children, sortByDueTime ? compareTasksByDueTime : undefined),
    ];
  }, [tasks, sortByDueTime]);

  // tree hook
  const {
    flatOrderedTasks,
    expandedTaskIds,
    toggleExpand,
    isTreeMode,
  } = useTaskTree(treeSourceTasks, filter);

  // getDescendantIds with cycle protection
  const getDescendantIds = useCallback((rootId: string, taskList: Task[], visited = new Set<string>()): string[] => {
    if (visited.has(rootId)) return [];
    visited.add(rootId);
    const ids: string[] = [rootId];
    const children = taskList.filter((t) => t.parentId === rootId);
    for (const child of children) {
      ids.push(...getDescendantIds(child.id, taskList, visited));
    }
    return ids;
  }, []);

  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.find((t) => t.id === selectedTaskId) || null;
  }, [selectedTaskId, tasks]);

  const selectedTreeNode = useMemo<TaskTreeNode | null>(() => {
    if (!selectedTaskId || !isTreeMode) return null;
    const tree = buildTaskTree(tasks);
    const findNode = (nodes: TaskTreeNode[]): TaskTreeNode | null => {
      for (const n of nodes) {
        if (n.id === selectedTaskId) return n;
        const found = findNode(n.children);
        if (found) return found;
      }
      return null;
    };
    return findNode(tree);
  }, [selectedTaskId, tasks, isTreeMode]);

  // filtered tasks by search query
  const displayTasks = useMemo(() => {
    const source = searchQuery.trim() ? tasks.filter((t) => taskMatchesSearch(t, searchQuery)) : tasks;
    if (filter === "completed-today") return [...source].sort((a,b) => Date.parse(b.completedAt || "") - Date.parse(a.completedAt || ""));
    if (viewMode !== "list") {
      return sortByDueTime ? [...source].sort(compareTasksByDueTime) : source;
    }
    return orderTasksCompletedLast(
      source,
      sortByDueTime ? compareTasksByDueTime : undefined,
    );
  }, [tasks, searchQuery, sortByDueTime, viewMode, filter]);

  // recompute flatOrdered for display (search-filtered)
  const displayFlatOrdered = useMemo(() => {
    if (!searchQuery.trim()) return flatOrderedTasks;
    return flatOrderedTasks.filter((item) => taskMatchesSearch(item.node, searchQuery));
  }, [flatOrderedTasks, searchQuery]);

  const [assignedToMeOnly, setAssignedToMeOnly] = useState(false);

  useEffect(() => {
    const onOpenTaskCenter = (event: Event) => {
      const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (taskId) openTaskFromNotification(taskId);
    };
    window.addEventListener("nowen:open-task-center", onOpenTaskCenter);
    return () => window.removeEventListener("nowen:open-task-center", onOpenTaskCenter);
  }, [openTaskFromNotification]);

  useEffect(() => {
    if (getCurrentWorkspace() === "personal") setAssignedToMeOnly(false);
  }, [workspaceVersion]);

  const loadTasks = useCallback(async () => {
    try {
      const assigneeFilter = assignedToMeOnly && getCurrentWorkspace() !== "personal" ? "me" : undefined;
      const [data, statsData] = await Promise.all([
        api.getTasks(filter, undefined, selectedProjectId || undefined, assigneeFilter),
        api.getTaskStats(),
      ]);
      setTasks(data);
      setStats(statsData);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setIsLoading(false);
    }
  }, [filter, selectedProjectId, workspaceVersion, assignedToMeOnly]);

  useEffect(() => {
    let day = formatLocalDateKey();
    const timer = window.setInterval(() => {
      const next = formatLocalDateKey();
      if (next !== day) { day = next; void loadTasks(); }
    }, 30000);
    return () => window.clearInterval(timer);
  }, [loadTasks]);

  const loadHabits = useCallback(async () => {
    try {
      const checkinDate = formatLocalDateKey();
      const [list, statsData] = await Promise.all([
        api.getHabits(true, checkinDate),
        api.getHabitStats(true, checkinDate),
      ]);
      setHabits(list);
      setHabitStats(statsData);
    } catch (err) {
      console.error("Failed to load habits:", err);
    }
  }, []);

  const loadStatsCenter = useCallback(async () => {
    const generation = ++statsLoadGenerationRef.current;
    try {
      setStatsLoading(true);
      const checkinDate = formatLocalDateKey();
      const [taskList, taskStatsData, habitList, habitStatsData, habitCheckins] = await Promise.all([
        api.getTasks("history"),
        api.getTaskStats(),
        api.getHabits(true, checkinDate),
        api.getHabitStats(true, checkinDate),
        api.getHabitCheckinLog({ includeArchived: true }),
      ]);
      if (generation !== statsLoadGenerationRef.current) return;
      setStatsTasks(taskList);
      const completed = taskList.filter((task) => task.isCompleted).length;
      setStats({...taskStatsData,total:taskList.length,completed,pending:taskList.length-completed});
      setStatsHabits(habitList);
      setHabitStats(habitStatsData);
      setStatsHabitCheckins(habitCheckins);
    } catch (err) {
      console.error("Failed to load stats center:", err);
      toast.error(t("stats.loadFailed"));
    } finally {
      if (generation === statsLoadGenerationRef.current) setStatsLoading(false);
    }
  }, [t]);

  const loadDependencies = useCallback(async () => {
    try {
      const deps = await api.getTaskDependencies();
      setDependencies(deps);
    } catch (e) { /* ignore */ }
  }, []);

  const loadReminderBadge = useCallback(async () => {
    try {
      const data = await api.getReminderOverview(7);
      setReminderBadgeCount(data.missed.length + data.today.length);
    } catch { /* ignore */ }
  }, []);

  const handleReminderCountChange = useCallback((taskId: string, activeCount: number) => {
    setTasks((prev) => prev.map((task) => (
      task.id === taskId ? { ...task, activeReminderCount: activeCount } : task
    )));
    loadReminderBadge();
  }, [loadReminderBadge]);

  useEffect(() => { loadTasks(); loadDependencies(); loadReminderBadge(); loadHabits(); }, [loadTasks, loadDependencies, loadReminderBadge, loadHabits]);

  useEffect(() => {
    const onWs = () => {
      closeTaskMenu(); setContextChildTask(null); setContextNoteTask(null);
      setRecurrenceDeleteTask(null);
      setSelectedTaskId(null);
      setSearchQuery("");
      setSelectedIds(new Set());
      setSelectMode(false);
      setSelectedProjectId(null);
      setWorkspaceVersion((v) => v + 1);
      reload();
      loadHabits();
      if (centerMode === "stats") void loadStatsCenter();
    };
    window.addEventListener("nowen:workspace-changed", onWs);
    return () => window.removeEventListener("nowen:workspace-changed", onWs);
  }, [centerMode, loadHabits, loadStatsCenter, loadTasks, closeTaskMenu]);

  useEffect(() => {
    if (centerMode === "stats") {
      loadStatsCenter();
    }
  }, [centerMode, loadStatsCenter]);

  const handleCreateHabit = async (): Promise<boolean> => {
    const title = newHabitTitle.trim();
    if (!title) return false;
    try {
      const checkinDate = formatLocalDateKey();
      const habit = await api.createHabit({ title });
      setHabits((prev) => [habit, ...prev]);
      setNewHabitTitle("");
      const statsData = await api.getHabitStats(true, checkinDate);
      setHabitStats(statsData);
      return true;
    } catch (err) {
      console.error("Failed to create habit:", err);
      toast.error(t("habits.toast.createFailed"));
      return false;
    }
  };

  const handleHabitCheckin = async (habit: Habit, status: HabitCheckinStatus, note: string) => {
    const checkinDate = formatLocalDateKey();
    const updated = await api.checkInHabit(habit.id, { status, note, checkinDate });
    setHabits((prev) => prev.map((item) => (
      item.id === habit.id
        ? { ...item, todayStatus: updated.status, todayNote: updated.note, todayCheckinDate: updated.checkinDate }
        : item
    )));
    const statsData = await api.getHabitStats(true, checkinDate);
    setHabitStats(statsData);
    toast.success(t("habits.toast.checkinUpdated"));
  };

  const handleArchiveHabitToggle = async (habit: Habit, archived: boolean) => {
    const checkinDate = formatLocalDateKey();
    const updated = await api.archiveHabit(habit.id, archived);
    setHabits((prev) => prev.map((item) => (item.id === habit.id ? { ...item, ...updated } : item)));
    const statsData = await api.getHabitStats(true, checkinDate);
    setHabitStats(statsData);
    toast.success(archived ? t("habits.toast.archived") : t("habits.toast.unarchived"));
  };

  const handleDeleteHabit = async (habit: Habit) => {
    await api.deleteHabit(habit.id);
    setHabits((prev) => prev.filter((item) => item.id !== habit.id));
    const statsData = await api.getHabitStats(true, formatLocalDateKey());
    setHabitStats(statsData);
    toast.success(t("habits.toast.deleted"));
  };

  // === Keyboard shortcuts ===
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (taskMenu.isOpen || contextChildTask || contextNoteTask) return;
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;

      if (e.key === "Escape") {
        if (selectMode) { setSelectMode(false); setSelectedIds(new Set()); return; }
        if (selectedTaskId) { setSelectedTaskId(null); return; }
        if (searchQuery) { setSearchQuery(""); return; }
      }
      if (isInput) return;

      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectMode, selectedTaskId, searchQuery, taskMenu.isOpen, contextChildTask, contextNoteTask]);

  useEffect(() => {
    closeTaskMenu(); setContextChildTask(null); setContextNoteTask(null);
  }, [centerMode, filter, selectedProjectId, viewMode, workspaceVersion, closeTaskMenu]);

  // === CRUD Handlers ===
  const handleToggle = async (id: string) => {
    if (tasks.find((task) => task.id === id)?.archivedAt) return;
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, isCompleted: t.isCompleted ? 0 : 1, status: t.isCompleted ? "todo" : "done" } : t))
    );
    try {
      const res = await api.toggleTask(id);
      // Use backend response for accurate state
      setTasks((prev) => {
        let updated = prev.map((t) => (t.id === id ? { ...t, ...res.task } : t));
        if (res.generatedTask) updated = [...updated, res.generatedTask];
        return updated;
      });
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch { loadTasks(); }
  };

  const handleCreate = async (orphanIds: string[] = [], manual: TaskQuickAddManualMeta = {}): Promise<boolean> => {
    if (!newTitle.trim()) return false;
    const titleToCreate = newTitle.trim();
    const parsed = resolveTaskQuickAddDraft(titleToCreate, getDefaultTaskPatchForFilter(filter), manual);
    const createPatch = getQuickAddCreatePatch(parsed);
    const taskTitle = parsed.cleanTitle || titleToCreate;
    try {
      const task = await api.createTask({
        title: taskTitle,
        projectId: selectedProjectId || undefined,
        ...createPatch,
      });
      setTasks((prev) => [task, ...prev]);
      setNewTitle("");
      inputRef.current?.focus();
      if (orphanIds.length) {
        await Promise.all(
          orphanIds.map((id) => api.taskAttachments.bind(id, task.id).catch(() => null))
        );
      }
      if (parsed.reminderOffsets.length) {
        await Promise.all(
          parsed.reminderOffsets.map((offset) =>
            api.createTaskReminder(task.id, offset).catch(() => null)
          )
        );
      }
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
      return true;
    } catch (err) {
      console.error("Failed to create task:", err);
      return false;
    }
  };

  const handleCreateChild = async (title: string, parentId: string, schedule?: SubtaskSchedule): Promise<void> => {
    const childTitleToCreate = title.trim();
    const childParsed = parseTaskQuickAdd(childTitleToCreate);
    const childCreatePatch = getQuickAddCreatePatch(childParsed);
    const childTaskTitle = childParsed.cleanTitle || childTitleToCreate;
    try {
      // Inherit projectId from parent, or use selectedProjectId
      const parentTask = tasks.find((t) => t.id === parentId);
      const childProjectId = parentTask?.projectId || selectedProjectId || undefined;
      const task = await api.createTask({
        title: childTaskTitle,
        parentId,
        projectId: childProjectId,
        ...childCreatePatch,
        ...schedule,
      });
      setTasks((prev) => [task, ...prev]);
      if (childParsed.reminderOffsets.length) {
        await Promise.all(
          childParsed.reminderOffsets.map((offset) =>
            api.createTaskReminder(task.id, offset).catch(() => null)
          )
        );
      }
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch (err) {
      console.error("Failed to create child task:", err);
      toast.error(t("tasks.toast.createFailed"));
    }
  };

  const handleDelete = async (id: string) => {
    const task = tasks.find(task => task.id === id);
    if (task && (task.repeatGroupId || (task.repeatRule && task.repeatRule !== "none"))) {
      setRecurrenceDeleteTask(task); return;
    }
    const descendantIds = getDescendantIds(id, tasks);
    if (descendantIds.length > 1) {
      const ok = window.confirm(t("tasks.confirmDeleteWithChildren", { count: descendantIds.length - 1 }));
      if (!ok) return;
    }
    setTasks((prev) => prev.filter((t) => !descendantIds.includes(t.id)));
    if (selectedTaskId && descendantIds.includes(selectedTaskId)) {
      setSelectedTaskId(null);
    }
    try {
      await api.deleteTask(id);
      await loadTasks();
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch { toast.error(t("tasks.toast.deleteFailed")); loadTasks(); }
  };

  const handleArchive = async (id: string, archived: boolean) => {
    try {
      await api.archiveTask(id, archived);
      setSelectedTaskId(null); await loadTasks(); refreshCounts();
      toast.success(t(archived ? "tasks.lifecycle.archiveSuccess" : "tasks.lifecycle.restoreSuccess"));
    } catch (error) { toast.error(error instanceof Error ? error.message : t("tasks.lifecycle.archiveFailed")); }
  };

  const handleUpdate = async (id: string, data: Partial<Task>) => {
    const isDescriptionUpdate = Object.prototype.hasOwnProperty.call(data, "description");
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...data } : t)));
    try {
      const res = await api.updateTask(id, data);
      if (res.task) setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...res.task } : t)));
      if (res.generatedTask) setTasks((prev) => {
        if (prev.some((t) => t.id === res.generatedTask!.id)) return prev;
        return [...prev, res.generatedTask!];
      });
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
      if (isDescriptionUpdate) toast.success(t("tasks.toast.descriptionUpdated"));
    } catch {
      if (isDescriptionUpdate) toast.error(t("tasks.toast.descriptionUpdateFailed"));
      loadTasks();
    }
  };

  // === Status change (kanban) ===
  const handleStatusChange = async (id: string, status: TaskStatus) => {
    const newIsCompleted = status === "done" ? 1 : 0;
    setTasks((prev) => prev.map((t) => t.id === id ? { ...t, status, isCompleted: newIsCompleted } : t));
    try {
      const res = await api.updateTask(id, { status, isCompleted: newIsCompleted });
      if (res.task) setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...res.task } : t)));
      if (res.generatedTask) setTasks((prev) => {
        if (prev.some((t) => t.id === res.generatedTask!.id)) return prev;
        return [...prev, res.generatedTask!];
      });
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch { loadTasks(); }
  };

  // === Calendar drag: move task to new date ===
  const handleMoveTaskDate = async (taskId: string, targetDateKey: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const patch = moveTaskToDate(task, targetDateKey);
    if (!patch) return; // same date, no-op

    // Optimistic update
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
    try {
      await api.updateTask(taskId, patch);
      await loadTasks();
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch { loadTasks(); }
  };

  // === Gantt drag: move task date range ===
  const handleUpdateTaskDateRange = async (taskId: string, patch: { startDate?: string | null; dueDate?: string | null }) => {
    // Optimistic update
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
    try {
      await api.updateTask(taskId, patch);
      await loadTasks();
    } catch { toast.error(t("tasks.toast.updateFailed")); loadTasks(); }
  };

  // === Create project ===
  const handleCreateProject = async (nameOverride?: string) => {
    const name = nameOverride || newProjectName.trim();
    if (!name) return;
    const p = await createProject(name);
    if (p) {
      setCenterMode("tasks");
      setFilter("all");
      setSelectedTaskId(null);
      setSearchQuery("");
      setSelectedProjectId(p.id);
      setNewProjectName("");
      setShowNewProject(false);
    }
  };

  const handleDeleteProject = async (id: string) => {
    const ok = window.confirm(t("tasks.deleteProjectConfirm"));
    if (!ok) return;
    await deleteProject(id);
    if (selectedProjectId === id) setSelectedProjectId(null);
    setShowProjectMenu(null);
  };

  const handleUpdateProject = async () => {
    if (!editingProject || !editProjectName.trim()) return;
    await updateProject(editingProject.id, { name: editProjectName.trim(), color: editProjectColor });
    setEditingProject(null);
    setShowProjectMenu(null);
  };

  // === Batch operations ===
  const toggleSelectId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    const allIds = new Set(flatOrderedTasks.map((t) => t.node.id));
    setSelectedIds(allIds);
  }, [flatOrderedTasks]);

  const handleDeselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleBatchComplete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setTasks((prev) => prev.map((t) => ids.includes(t.id) ? { ...t, isCompleted: 1, status: "done" as const } : t));
    setSelectMode(false);
    setSelectedIds(new Set());
    try {
      await api.batchTasks(ids, "complete");
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch (err: any) { const detail = err?.message || err?.error || ""; toast.error(detail ? `${t("tasks.toast.bulkCompleteFailed")}: ${detail}` : t("tasks.toast.bulkCompleteFailed")); loadTasks(); }
  };

  const handleBatchDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (tasks.some(task => selectedIds.has(task.id) && (task.repeatGroupId || (task.repeatRule && task.repeatRule !== "none"))) && !window.confirm(t("taskRemoval.bulkSingle"))) return;
    // Collect all descendants
    const idsToRemove = new Set<string>();
    for (const id of ids) {
      for (const did of getDescendantIds(id, tasks)) {
        idsToRemove.add(did);
      }
    }
    if (idsToRemove.size > ids.length) {
      const ok = window.confirm(t("tasks.confirmDeleteWithChildren", { count: idsToRemove.size - ids.length }));
      if (!ok) return;
    }
    setTasks((prev) => prev.filter((t) => !idsToRemove.has(t.id)));
    if (selectedTaskId && idsToRemove.has(selectedTaskId)) setSelectedTaskId(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    try {
      await api.batchTasks(ids, "delete");
      await loadTasks();
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch (err: any) { const detail = err?.message || err?.error || ""; toast.error(detail ? `${t("tasks.toast.bulkDeleteFailed")}: ${detail}` : t("tasks.toast.bulkDeleteFailed")); loadTasks(); }
  };

  // === Drag reorder ===
  const handleDragStart = useCallback((id: string, e: React.DragEvent) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    const img = document.createElement("div");
    img.style.opacity = "0";
    document.body.appendChild(img);
    e.dataTransfer.setDragImage(img, 0, 0);
    requestAnimationFrame(() => document.body.removeChild(img));
  }, []);

  const handleDragOver = useCallback((id: string, e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (id !== dragOverId) setDragOverId(id);
  }, [dragOverId]);

  const handleDrop = useCallback(async (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); setDragOverId(null); return; }
    if (sortByDueTime) { setDragId(null); setDragOverId(null); return; }

    const dragTask = tasks.find((t) => t.id === dragId);
    const targetTask = tasks.find((t) => t.id === targetId);
    if (!dragTask || !targetTask) { setDragId(null); setDragOverId(null); return; }
    if ((dragTask.parentId ?? null) !== (targetTask.parentId ?? null)) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    if (!haveSameTaskCompletionState(dragTask, targetTask)) {
      setDragId(null);
      setDragOverId(null);
      return;
    }

    const siblings = tasks
      .filter((t) => (t.parentId ?? null) === (dragTask.parentId ?? null))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (b.createdAt || "").localeCompare(a.createdAt || ""));
    const without = siblings.filter((t) => t.id !== dragId);
    const targetIdx = without.findIndex((t) => t.id === targetId);
    if (targetIdx < 0) { setDragId(null); setDragOverId(null); return; }
    const reordered = [...without];
    reordered.splice(targetIdx, 0, dragTask);
    const items = reordered.map((task, index) => ({ id: task.id, sortOrder: index }));
    const orderMap = new Map(items.map((item) => [item.id, item.sortOrder]));

    setTasks((prev) => {
      const updated = prev.map((task) =>
        orderMap.has(task.id) ? { ...task, sortOrder: orderMap.get(task.id)! } : task
      );
      const siblingIds = new Set(items.map((item) => item.id));
      const firstSiblingIndex = updated.findIndex((task) => siblingIds.has(task.id));
      if (firstSiblingIndex < 0) return updated;
      const nonSiblings = updated.filter((task) => !siblingIds.has(task.id));
      const reorderedSiblings = items
        .map((item) => updated.find((task) => task.id === item.id))
        .filter((task): task is Task => !!task);
      const result = [...nonSiblings];
      result.splice(firstSiblingIndex, 0, ...reorderedSiblings);
      return result;
    });

    try {
      await api.reorderTasks(items);
    } catch { loadTasks(); }

    setDragId(null);
    setDragOverId(null);
  }, [dragId, tasks, sortByDueTime, loadTasks]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverId(null);
  }, []);

  // filter count helper
  const filterCount = (key: TaskFilter): number => {
    if (!stats) return 0;
    switch (key) {
      case "all": return stats.total;
      case "today": return stats.today;
      case "week": return stats.week;
      case "overdue": return stats.overdue;
      case "completed": return stats.completed;
      case "completed-today": return stats.completedToday ?? 0;
      case "archived": return stats.archived ?? 0;
      default: return 0;
    }
  };

  // Esc 键退出全屏
  useEffect(() => {
    if (!taskFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTaskFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [taskFullscreen]);

  const getContextTaskTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element) || isLoading || centerMode !== "tasks") return null;
    if (target.closest("input, textarea, [contenteditable='true']")) return null;
    return target.closest<HTMLElement>("[data-task-context-id]");
  };
  const contextDescendants = new Set(contextTask ? getDescendantIds(contextTask.id, tasks) : []);
  const canArchiveContextTask = !!contextTask && tasks.every(task => !contextDescendants.has(task.id) || task.isCompleted === 1);
  const handleTaskMenuAction = (action: string) => {
    const task = contextTask;
    closeTaskMenu();
    if (!task) return;
    if (action === "open") { setSelectedTaskId(task.id); return; }
    if (action === "save-note") { setContextNoteTask(task); return; }
    if (action === "export:xlsx" || action === "export:md") {
      const format = action === "export:xlsx" ? "xlsx" : "md";
      void exportTaskReport(format, key => t(key), task.id)
        .catch(error => toast.error(error instanceof Error ? error.message : t("tasks.report.exportFailed")));
      return;
    }
    if (action === "delete") {
      if (getDescendantIds(task.id, tasks).length === 1 && !window.confirm(t("tasks.contextMenu.confirmDelete", { title: task.title }))) return;
      void handleDelete(task.id); return;
    }
    if (action === "restore") { if (task.archivedAt && !task.parentId) void handleArchive(task.id, false); return; }
    if (task.archivedAt) return;
    if (action === "toggle") void handleToggle(task.id);
    else if (action === "add-child") setContextChildTask(task);
    else if (action === "archive" && canArchiveContextTask && !task.parentId) void handleArchive(task.id, true);
    else if (action.startsWith("priority:")) {
      const priority = Number(action.slice(9));
      if (priority === 1 || priority === 2 || priority === 3) void handleUpdate(task.id, { priority });
    } else if (action.startsWith("project:")) {
      const projectId = action.slice(8);
      if (projectId === "none" || projects.some(project => project.id === projectId)) void handleUpdate(task.id, { projectId: projectId === "none" ? null : projectId });
    }
  };

  return (
    <div className={cn(TASK_CENTER_ROOT_CLASS, taskFullscreen && "fixed inset-0 z-[80] bg-app-bg")}
      onContextMenu={event => {
        const target = getContextTaskTarget(event.target);
        if (target) openTaskMenu(event, target.dataset.taskContextId!, "task");
      }}
      onKeyDown={event => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        const target = getContextTaskTarget(event.target);
        if (!target) return;
        event.preventDefault(); event.stopPropagation();
        const rect = target.getBoundingClientRect();
        openTaskMenuAt(rect.left + 16, rect.top + 16, target.dataset.taskContextId!, "task");
      }}
      onClickCapture={event => {
        if (!(event.target instanceof Element) || !event.target.closest("[data-task-menu-trigger]")) return;
        const target = getContextTaskTarget(event.target);
        if (!target) return;
        event.preventDefault(); event.stopPropagation();
        const rect = event.target.closest("button")!.getBoundingClientRect();
        openTaskMenuAt(rect.right, rect.bottom, target.dataset.taskContextId!, "task");
      }}>
      {/* Left: Sidebar Filters + Projects (desktop) */}
      <div className="hidden md:flex w-60 shrink-0 flex-col border-r border-app-border/75 bg-app-surface/85 backdrop-blur-md overflow-y-auto" style={{ paddingTop: "var(--safe-area-top)" }}>
        <nav className="flex-1 px-2.5 py-2.5 space-y-0.5">
          <div className="flex items-center gap-2.5 px-2 pb-3 pt-1">
            <motion.span
              whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
              transition={{ duration: 0.4 }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/20 via-indigo-400/18 to-violet-500/20 text-sky-600 ring-1 ring-sky-500/20 dark:text-sky-300"
            >
              <ListTodo size={16} />
            </motion.span>
            <span className="text-sm font-bold tracking-tight text-tx-primary">{t("tasks.title")}</span>
          </div>
          <button
            style={{ display: isTaskCenterModuleVisible("inbox", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("inbox"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={cn(
              "relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
              centerMode === "inbox" ? "font-semibold text-amber-600 dark:text-amber-300" : "text-tx-secondary hover:bg-app-hover/75 hover:text-tx-primary",
            )}
          >
            {centerMode === "inbox" && (
              <motion.span
                layoutId="task-nav-pill"
                transition={MOTION_SPRING.snappy}
                className="absolute inset-0 rounded-xl bg-amber-500/12 ring-1 ring-amber-500/25"
              />
            )}
            <Inbox size={15} className="relative z-10 text-amber-500 dark:text-amber-400" />
            <span className="relative z-10 flex-1 text-left">{t("tasks.inbox", { defaultValue: "收集箱" })}</span>
          </button>
          {FILTERS.map((f) => {
            const active = centerMode === "tasks" && filter === f.key && !selectedProjectId;
            const count = filterCount(f.key);
            const isOverdueAlert = f.key === "overdue" && count > 0;
            return (
              <button
                key={f.key}
                onClick={() => selectTaskFilter(f.key)}
                className={cn(
                  "relative flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-sm transition-colors",
                  active ? "text-accent-primary font-semibold" : "text-tx-secondary hover:bg-app-hover/75 hover:text-tx-primary",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="task-nav-pill"
                    transition={MOTION_SPRING.snappy}
                    className="absolute inset-0 rounded-xl bg-accent-primary/10 ring-1 ring-accent-primary/20"
                  />
                )}
                <span className={cn("relative z-10 inline-flex shrink-0", active ? "text-accent-primary" : f.colorClass)}>
                  {f.icon}
                </span>
                <span className="relative z-10 flex-1 text-left">{f.label}</span>
                <span className={cn(
                  "relative z-10 text-[11px] min-w-[20px] text-center rounded-full px-1.5 py-0.5 tabular-nums",
                  active
                    ? "bg-accent-primary/15 text-accent-primary font-semibold"
                    : isOverdueAlert
                      ? "bg-rose-500/15 text-rose-600 font-semibold dark:text-rose-300"
                      : "text-tx-tertiary",
                )}>
                  {count}
                </span>
              </button>
            );
          })}

          {getCurrentWorkspace() !== "personal" && (
            <button
              type="button"
              aria-pressed={centerMode === "tasks" && assignedToMeOnly}
              onClick={() => {
                setCenterMode("tasks");
                setSelectedProjectId(null);
                setSelectedTaskId(null);
                setFilter("all");
                setAssignedToMeOnly((prev) => !prev);
              }}
              className={cn(
                "flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-sm transition-colors",
                centerMode === "tasks" && assignedToMeOnly
                  ? "bg-sky-500/15 text-sky-600 dark:text-sky-300 font-semibold ring-1 ring-sky-500/20"
                  : "text-tx-secondary hover:bg-app-hover/75 hover:text-tx-primary",
              )}
            >
              <CheckCircle2 size={15} className="text-sky-500 dark:text-sky-400" />
              <span className="flex-1 text-left">指派给我</span>
            </button>
          )}

          {/* Projects section */}
          <div className="!mt-4 border-t border-app-border/70 px-2 pb-2 pt-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-tx-primary">
                <FolderOpen size={14} className="text-amber-500 dark:text-amber-400" />
                {t("tasks.projects")}
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={t("tasks.projectsHelp")}
                        className="rounded text-tx-tertiary transition-colors hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                      >
                        <Info size={13} />
                      </button>
                    </TooltipTrigger>
                    <TooltipPortal>
                      <TooltipContent side="right" collisionPadding={12} className="max-w-64 font-normal leading-relaxed">
                        {t("tasks.projectsDescription")}
                      </TooltipContent>
                    </TooltipPortal>
                  </Tooltip>
                </TooltipProvider>
              </span>
              <button
                onClick={() => setShowNewProject(true)}
                className="inline-flex items-center gap-1 rounded-xl bg-accent-primary/10 px-2.5 py-1 text-xs font-medium text-accent-primary transition-all hover:bg-accent-primary/18 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                aria-expanded={showNewProject}
              >
                <Plus size={13} />
                {t("tasks.newProject")}
              </button>
            </div>
          </div>

          {showNewProject && (
            <form
              className="px-2 pb-2"
              onSubmit={(e) => { e.preventDefault(); void handleCreateProject(); }}
            >
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setShowNewProject(false); }}
                aria-label={t("tasks.projectName")}
                placeholder={t("tasks.projectName")}
                className="w-full px-2.5 py-1.5 text-sm rounded-xl bg-app-bg border border-app-border/80 text-tx-primary focus:outline-none focus:border-accent-primary"
                autoFocus
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="submit" disabled={!newProjectName.trim()} className="rounded-xl bg-accent-primary px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">
                  {t("tasks.newProject")}
                </button>
                <button type="button" onClick={() => setShowNewProject(false)} className="rounded-xl px-2.5 py-1 text-xs text-tx-secondary hover:bg-app-hover">
                  {t("common.cancel")}
                </button>
              </div>
            </form>
          )}

          {projects.map((p) => (
            <div key={p.id} className="relative">
              <button
                onClick={() => { setCenterMode("tasks"); setSelectedProjectId(p.id); setFilter("all"); setSelectedTaskId(null); setSearchQuery(""); }}
                className={cn(
                  "flex items-center gap-2.5 w-full px-3 py-1.5 rounded-xl text-sm transition-colors group",
                  centerMode === "tasks" && selectedProjectId === p.id ? "bg-accent-primary/10 text-accent-primary font-semibold ring-1 ring-accent-primary/20" : "text-tx-secondary hover:bg-app-hover/75 hover:text-tx-primary"
                )}
              >
                <FolderOpen size={14} style={{ color: p.color }} />
                <span className="flex-1 text-left truncate">{p.name}</span>
                <span className="rounded-full bg-app-hover/80 px-1.5 py-0.2 text-[10px] tabular-nums text-tx-tertiary">{p.completedCount ?? 0}/{p.taskCount ?? 0}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); setShowProjectMenu(showProjectMenu === p.id ? null : p.id); }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded-lg hover:bg-app-hover text-tx-tertiary transition-all"
                >
                  <MoreHorizontal size={12} />
                </button>
              </button>
              {/* Progress bar */}
              {(p.taskCount ?? 0) > 0 && (
                <div className="mx-3 mb-1 h-1 rounded-full bg-app-border/75 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500 transition-all" style={{ width: `${p.progress ?? 0}%` }} />
                </div>
              )}
              {/* Project menu */}
              {showProjectMenu === p.id && (
                <div className="absolute right-0 top-full z-20 mt-1 w-36 rounded-2xl border border-app-border/80 bg-app-elevated/95 shadow-xl backdrop-blur-xl py-1.5 px-1">
                  <button onClick={() => { setEditingProject(p); setEditProjectName(p.name); setEditProjectColor(p.color); setShowProjectMenu(null); }}
                    className="w-full rounded-xl text-left px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary">{t("tasks.projectName")}</button>
                  <button onClick={() => handleDeleteProject(p.id)}
                    className="w-full rounded-xl text-left px-3 py-1.5 text-xs text-rose-500 hover:bg-rose-500/10">{t("tasks.deleteProject")}</button>
                </div>
              )}
            </div>
          ))}

          {(isTaskCenterModuleVisible("my-day", userPrefs.hiddenTaskCenterModules) ||
            isTaskCenterModuleVisible("planner", userPrefs.hiddenTaskCenterModules)) && (
            <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">
              {t("tasks.planning", { defaultValue: "计划" })}
            </div>
          )}
          <button
            style={{ display: isTaskCenterModuleVisible("my-day", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("my-day"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={cn(
              "relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
              centerMode === "my-day" ? "font-semibold text-orange-600 dark:text-orange-300" : "text-tx-secondary hover:bg-app-hover/75 hover:text-tx-primary",
            )}
          >
            {centerMode === "my-day" && (
              <motion.span
                layoutId="task-nav-pill"
                transition={MOTION_SPRING.snappy}
                className="absolute inset-0 rounded-xl bg-orange-500/12 ring-1 ring-orange-500/20"
              />
            )}
            <Sun size={15} className="relative z-10 text-orange-500 dark:text-orange-400" />
            <span className="relative z-10 flex-1 text-left">{t("tasks.myDay", { defaultValue: "我的一天" })}</span>
          </button>
          <button
            style={{ display: isTaskCenterModuleVisible("planner", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("planner"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={cn(
              "relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
              centerMode === "planner" ? "font-semibold text-cyan-600 dark:text-cyan-300" : "text-tx-secondary hover:bg-app-hover/75 hover:text-tx-primary",
            )}
          >
            {centerMode === "planner" && (
              <motion.span
                layoutId="task-nav-pill"
                transition={MOTION_SPRING.snappy}
                className="absolute inset-0 rounded-xl bg-cyan-500/12 ring-1 ring-cyan-500/20"
              />
            )}
            <CalendarClock size={15} className="relative z-10 text-cyan-500 dark:text-cyan-400" />
            <span className="relative z-10 flex-1 text-left">{t("tasks.timePlanning", { defaultValue: "时间规划" })}</span>
          </button>

          <button
            style={{ display: isTaskCenterModuleVisible("habits", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("habits"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={cn(
              "relative flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-sm transition-colors",
              centerMode === "habits" ? "text-fuchsia-600 dark:text-fuchsia-300 font-semibold" : "text-tx-secondary hover:bg-app-hover/75 hover:text-tx-primary"
            )}
          >
            {centerMode === "habits" && (
              <motion.span
                layoutId="task-nav-pill"
                transition={MOTION_SPRING.snappy}
                className="absolute inset-0 rounded-xl bg-fuchsia-500/12 ring-1 ring-fuchsia-500/20"
              />
            )}
            <ListTodo size={15} className="relative z-10 text-fuchsia-500 dark:text-fuchsia-400" />
            <span className="relative z-10 flex-1 text-left">{t("habits.title")}</span>
            <span className={cn(
              "relative z-10 text-[11px] min-w-[20px] text-center rounded-full px-1.5 py-0.5 tabular-nums",
              centerMode === "habits" ? "bg-fuchsia-500/18 text-fuchsia-600 dark:text-fuchsia-300 font-semibold" : "text-tx-tertiary"
            )}>
              {pendingHabitCount}
            </span>
          </button>

          <button
            style={{ display: isTaskCenterModuleVisible("stats", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("stats"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={cn(
              "relative flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-sm transition-colors",
              centerMode === "stats" ? "text-teal-600 dark:text-teal-300 font-semibold" : "text-tx-secondary hover:bg-app-hover/75 hover:text-tx-primary"
            )}
          >
            {centerMode === "stats" && (
              <motion.span
                layoutId="task-nav-pill"
                transition={MOTION_SPRING.snappy}
                className="absolute inset-0 rounded-xl bg-teal-500/12 ring-1 ring-teal-500/20"
              />
            )}
            <BarChart3 size={15} className="relative z-10 text-teal-500 dark:text-teal-400" />
            <span className="relative z-10 flex-1 text-left">{t("stats.title")}</span>
          </button>
        </nav>
      </div>

      {/* Center: Task List */}
      <div className={cn(TASK_CENTER_MAIN_CLASS, "relative")}>
        {/* 柔和极光背景装饰 */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-60 overflow-hidden">
          <div className="absolute -top-24 left-1/5 h-56 w-72 rounded-full bg-sky-400/10 blur-3xl dark:bg-sky-500/12" />
          <div className="absolute -top-16 right-1/4 h-52 w-72 rounded-full bg-indigo-400/10 blur-3xl dark:bg-violet-500/12" />
          <div className="absolute top-6 right-12 h-36 w-52 rounded-full bg-amber-400/8 blur-3xl dark:bg-emerald-500/8" />
        </div>

        {/* Mobile: horizontal filter bar */}
        <div className={cn(TASK_MOBILE_FILTER_BAR_CLASS, "relative z-10 bg-app-bg/75 backdrop-blur-md")}>
          <button
            style={{ display: isTaskCenterModuleVisible("inbox", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("inbox"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              centerMode === "inbox" ? "bg-amber-500/15 text-amber-600" : "bg-app-hover/60 text-tx-secondary active:bg-app-active",
            )}
          >
            <Inbox size={14} /> {t("tasks.inbox", { defaultValue: "收集箱" })}
          </button>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => selectTaskFilter(f.key)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0",
                centerMode === "tasks" && filter === f.key
                  ? "bg-accent-primary/15 text-accent-primary"
                  : "text-tx-secondary bg-app-hover/60 active:bg-app-active"
              )}
            >
              {f.icon}
              {f.label}
              <span className={cn(
                "text-[10px] min-w-[16px] text-center tabular-nums",
                centerMode === "tasks" && filter === f.key ? "text-accent-primary" : "text-tx-tertiary"
              )}>
                {filterCount(f.key)}
              </span>
            </button>
          ))}
          <button
            style={{ display: isTaskCenterModuleVisible("my-day", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("my-day"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              centerMode === "my-day" ? "bg-orange-500/15 text-orange-600" : "bg-app-hover/60 text-tx-secondary active:bg-app-active",
            )}
          >
            <Sun size={14} /> {t("tasks.myDay", { defaultValue: "我的一天" })}
          </button>
          <button
            style={{ display: isTaskCenterModuleVisible("planner", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("planner"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              centerMode === "planner" ? "bg-cyan-500/15 text-cyan-600" : "bg-app-hover/60 text-tx-secondary active:bg-app-active",
            )}
          >
            <CalendarClock size={14} /> {t("tasks.timePlanning", { defaultValue: "时间规划" })}
          </button>
          <button
            style={{ display: isTaskCenterModuleVisible("habits", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("habits"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0",
              centerMode === "habits" ? "bg-fuchsia-500/15 text-fuchsia-600" : "text-tx-secondary bg-app-hover/60 active:bg-app-active"
            )}
          >
            <ListTodo size={14} />
            {t("habits.title")}
            <span className={cn(
              "text-[10px] min-w-[16px] text-center tabular-nums",
              centerMode === "habits" ? "text-fuchsia-600" : "text-tx-tertiary"
            )}>
              {pendingHabitCount}
            </span>
          </button>
          <button
            style={{ display: isTaskCenterModuleVisible("stats", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("stats"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0",
              centerMode === "stats" ? "bg-teal-500/15 text-teal-600" : "text-tx-secondary bg-app-hover/60 active:bg-app-active"
            )}
          >
            <BarChart3 size={14} />
            {t("stats.title")}
          </button>
          {centerMode === "tasks" && (
            <>
              {/* Mobile project trigger */}
              {aiAvailable && <button type="button" onClick={() => setShowTaskComposer(true)} className="flex shrink-0 items-center gap-1 rounded-full bg-violet-500/12 px-3 py-1.5 text-xs text-violet-600 dark:text-violet-300"><Sparkles size={14} />{t("taskComposer.entry")}</button>}
              <button type="button" onClick={openTaskDataTransfer} className="flex shrink-0 items-center gap-1 rounded-full bg-app-hover/60 px-3 py-1.5 text-xs text-tx-secondary"><Download size={14} />{t("tasks.report.open")}</button>
              <MobileProjectTrigger
                selectedProjectId={selectedProjectId}
                projects={projects}
                onClick={() => setMobileProjectOpen(true)}
                t={t}
              />
              {/* 移动端依次切换列表、看板、日历、时间线，并记住选择。 */}
              <button
                onClick={() => changeViewMode(viewMode === "list" ? "board" : viewMode === "board" ? "calendar" : viewMode === "calendar" ? "timeline" : "list")}
                className="flex items-center gap-1 px-2 py-1.5 rounded-full text-xs shrink-0 text-tx-secondary bg-app-hover/60 active:bg-app-active"
                title={viewMode === "list" ? t("tasks.boardView") : viewMode === "board" ? t("tasks.calendarView") : viewMode === "calendar" ? t("tasks.timelineView") : t("tasks.listView")}
                aria-label={t("tasks.view", { defaultValue: "视图" })}
              >
                {viewMode === "list" ? <LayoutGrid size={12} /> : viewMode === "board" ? <CalendarIcon size={12} /> : viewMode === "calendar" ? <CalendarClock size={12} /> : <LayoutList size={12} />}
              </button>
            </>
          )}
        </div>

        {centerMode === "habits" && !isLoading && (
          <HabitStatsOverview stats={habitStats} />
        )}

        {/* Header desktop with batch controls */}
        {centerMode === "tasks" ? (
          <div className="relative z-10 hidden shrink-0 flex-wrap items-center gap-3 border-b border-app-border/75 bg-app-bg/70 px-5 py-3.5 backdrop-blur-md md:flex">
            <div className="flex min-w-0 flex-1 basis-40 items-center gap-3">
              <motion.span
                whileHover={{ rotate: [0, -8, 8, 0], scale: 1.07 }}
                transition={{ duration: 0.4 }}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 via-indigo-400/18 to-violet-500/20 text-sky-600 shadow-xs ring-1 ring-sky-500/20 dark:text-sky-300"
              >
                {selectedProjectId ? <FolderOpen size={18} /> : (FILTERS.find((f) => f.key === filter)?.icon || <Inbox size={18} />)}
              </motion.span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-lg font-bold tracking-tight text-tx-primary">
                    {selectedProjectId
                      ? projects.find((p) => p.id === selectedProjectId)?.name || t("tasks.allTasks")
                      : FILTERS.find((f) => f.key === filter)?.label || t("tasks.allTasks")}
                  </h1>
                  <span className="inline-flex shrink-0 items-center rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-sky-700 dark:border-sky-400/25 dark:bg-sky-400/15 dark:text-sky-300">
                    {t("tasks.visibleTaskCount", { count: displayTasks.length, defaultValue: `${displayTasks.length} 条任务` })}
                  </span>
                </div>
              </div>
            </div>
            <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2 whitespace-nowrap">
              {selectMode ? (
                <>
                  <span className="rounded-full bg-accent-primary/12 px-2.5 py-1 text-xs font-semibold text-accent-primary">{t("tasks.selectedCount", { count: selectedIds.size })}</span>
                  <button
                    onClick={selectedIds.size === flatOrderedTasks.length ? handleDeselectAll : handleSelectAll}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-xl border border-app-border/75 bg-app-elevated/85 text-tx-secondary hover:bg-app-surface hover:text-tx-primary transition-colors"
                  >
                    <CheckSquare size={14} />
                    {selectedIds.size === flatOrderedTasks.length ? t("tasks.deselectAll") : t("tasks.selectAll")}
                  </button>
                  <button
                    onClick={handleBatchComplete}
                    disabled={selectedIds.size === 0}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-xl bg-emerald-500/12 text-emerald-600 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors dark:text-emerald-300"
                  >
                    <CheckSquare size={14} /> {t("tasks.batchComplete")}
                  </button>
                  <button
                    onClick={handleBatchDelete}
                    disabled={selectedIds.size === 0}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-xl bg-rose-500/12 text-rose-600 hover:bg-rose-500/20 disabled:opacity-40 transition-colors dark:text-rose-300"
                  >
                    <Trash2 size={14} /> {t("tasks.batchDelete")}
                  </button>
                  <button
                    onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                    className="text-xs text-tx-tertiary hover:text-tx-primary px-2.5 py-1.5 rounded-xl hover:bg-app-hover transition-colors"
                  >
                    {t("tasks.batchCancel")}
                  </button>
                </>
              ) : (
                <>
                  <motion.button
                    type="button"
                    whileHover={{ y: -1 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => openTaskQuickCapture({ sourceType: "manual" })}
                    className="inline-flex h-8.5 items-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-3 text-xs font-semibold text-white shadow-sm shadow-sky-500/20 transition-all hover:from-sky-400 hover:to-indigo-400"
                  >
                    <ClipboardPlus size={14} />
                    {t("tasks.quickCaptureToInbox", { defaultValue: "快速捕获" })}
                  </motion.button>
                  {aiAvailable && (
                    <button
                      type="button"
                      onClick={() => setShowTaskComposer(true)}
                      className="inline-flex h-8.5 items-center gap-1.5 whitespace-nowrap rounded-xl border border-violet-500/30 bg-violet-500/10 px-3 text-xs font-medium text-violet-600 transition-colors hover:bg-violet-500/18 dark:text-violet-300"
                    >
                      <Sparkles size={14} />
                      {t("taskComposer.entry")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={openTaskDataTransfer}
                    className="inline-flex h-8.5 items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-elevated/85 px-3 text-xs font-medium text-tx-secondary shadow-xs transition-colors hover:border-accent-primary/35 hover:bg-app-surface hover:text-tx-primary"
                  >
                    <Download size={14} />
                    {t("tasks.report.open")}
                  </button>
                  <label className="flex h-8.5 items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-elevated/85 px-2.5 text-xs text-tx-secondary shadow-xs transition-colors hover:border-accent-primary/35">
                    <span className="text-tx-tertiary">{t("tasks.view", { defaultValue: "视图" })}</span>
                    <select
                      value={viewMode}
                      onChange={(event) => changeViewMode(event.target.value as TaskViewMode)}
                      className="cursor-pointer bg-transparent text-xs font-medium text-tx-primary outline-none"
                    >
                      <option value="list">{t("tasks.listView")}</option>
                      <option value="board">{t("tasks.boardView")}</option>
                      <option value="calendar">{t("tasks.calendarView")}</option>
                      <option value="timeline">{t("tasks.timelineView")}</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={toggleDueSort}
                    aria-pressed={sortByDueTime}
                    className={cn(
                      "inline-flex h-8.5 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition-all active:scale-95",
                      sortByDueTime
                        ? "border-accent-primary/35 bg-accent-primary/12 text-accent-primary"
                        : "border-app-border/80 bg-app-elevated/85 text-tx-secondary shadow-xs hover:border-accent-primary/35 hover:text-tx-primary",
                    )}
                    title={sortByDueTime ? t("tasks.backToManualOrder") : t("tasks.sortByDueTime")}
                  >
                    <CalendarDays size={14} />
                    <span>{sortByDueTime ? t("tasks.dueSoonFirst") : t("tasks.sortByDueTime")}</span>
                  </button>
                  <button
                    onClick={() => setSelectMode(true)}
                    className="flex h-8.5 w-8.5 items-center justify-center rounded-xl border border-app-border/80 bg-app-elevated/85 text-tx-secondary shadow-xs transition-colors hover:border-accent-primary/35 hover:bg-app-surface hover:text-tx-primary"
                    title={t("tasks.selectMode")}
                  >
                    <CheckSquare size={14} />
                  </button>
                  <button
                    onClick={() => setTaskFullscreen((v) => !v)}
                    className="flex h-8.5 w-8.5 items-center justify-center rounded-xl border border-app-border/80 bg-app-elevated/85 text-tx-secondary shadow-xs transition-colors hover:border-accent-primary/35 hover:bg-app-surface hover:text-tx-primary"
                    title={taskFullscreen ? t("tasks.exitFullscreen") : t("tasks.enterFullscreen")}
                  >
                    {taskFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </button>
                </>
              )}
            </div>
          </div>
        ) : centerMode === "habits" ? (
          <div className="relative z-10 hidden md:flex items-center justify-between px-5 py-3.5 border-b border-app-border/75 bg-app-bg/70 backdrop-blur-md">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-fuchsia-500/14 text-fuchsia-600 ring-1 ring-fuchsia-500/20 dark:text-fuchsia-300">
                <ListTodo size={17} />
              </span>
              <h1 className="text-lg font-bold tracking-tight text-tx-primary">{t("habits.title")}</h1>
            </div>
            <div className="text-xs text-tx-tertiary">{t("habits.summary")}</div>
          </div>
        ) : centerMode === "stats" ? (
          <div className="relative z-10 hidden md:flex items-center justify-between px-5 py-3.5 border-b border-app-border/75 bg-app-bg/70 backdrop-blur-md">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-teal-500/14 text-teal-600 ring-1 ring-teal-500/20 dark:text-teal-300">
                <BarChart3 size={17} />
              </span>
              <h1 className="text-lg font-bold tracking-tight text-tx-primary">{t("stats.title")}</h1>
            </div>
            <div className="text-xs text-tx-tertiary">{t("stats.subtitle")}</div>
          </div>
        ) : null}

        {/* Search bar */}
        {centerMode === "tasks" ? (
          <div className="relative z-10 flex items-center gap-2 px-4 md:px-5 py-1.5 border-b border-app-border/75">
            <Search size={14} className="text-tx-tertiary shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("tasks.searchPlaceholder")}
              className="flex-1 bg-transparent text-sm text-tx-primary placeholder:text-tx-tertiary focus:outline-none"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="rounded-full p-0.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors">
                <XIcon size={13} />
              </button>
            )}
          </div>
        ) : centerMode === "habits" ? (
          <div className="relative z-10 flex items-center gap-2 px-4 md:px-5 py-2.5 border-b border-app-border/75">
            <div className="flex flex-1 items-center gap-2">
              <input
                type="text"
                value={newHabitTitle}
                onChange={(e) => setNewHabitTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateHabit(); }}
                placeholder={t("habits.createPlaceholder")}
                className="flex-1 rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-sm text-tx-primary placeholder:text-tx-tertiary focus:outline-none focus:border-accent-primary"
              />
              <button
                onClick={handleCreateHabit}
                className="rounded-xl bg-gradient-to-r from-fuchsia-500 to-indigo-500 px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:opacity-90 active:scale-95"
              >
                {t("habits.add")}
              </button>
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-app-border/75 bg-app-elevated/80 p-1">
              {(["active", "archived", "all"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setHabitListMode(mode)}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                    habitListMode === mode ? "bg-accent-primary text-white shadow-xs" : "text-tx-secondary hover:bg-app-hover"
                  )}
                >
                  {mode === "active" ? t("habits.filters.active") : mode === "archived" ? t("habits.filters.archived") : t("habits.filters.all")}
                </button>
              ))}
            </div>
          </div>
        ) : centerMode === "stats" ? (
          <div className="relative z-10 border-b border-app-border/75 px-4 md:px-5 py-2 text-xs text-tx-tertiary">
            {t("stats.summaryHint")}
          </div>
        ) : null}

        {centerMode === "tasks" && (filter === "completed-today" || filter === "archived") && <div className="relative z-10 mx-4 mt-3 rounded-2xl border border-app-border/75 bg-app-elevated/75 px-4 py-3 text-sm text-tx-secondary backdrop-blur-sm md:mx-5">
          <strong className="text-tx-primary">{filter === "completed-today" ? `${t("tasks.lifecycle.completedToday")} ${displayTasks.length}` : t("tasks.lifecycle.archived")}</strong>
          <p className="mt-1 text-xs">{t(filter === "completed-today" ? "tasks.lifecycle.todayHint" : "tasks.lifecycle.archiveHint")}</p>
        </div>}

        {/* Quick Add */}
        {centerMode === "tasks" && filter !== "archived" && filter !== "completed-today" && (
          <div className="relative z-30 px-4 md:px-5 py-2 border-b border-app-border/70">
            <TaskQuickAdd
              value={newTitle}
              onChange={setNewTitle}
              onSubmit={handleCreate}
              defaults={getDefaultTaskPatchForFilter(filter)}
              inputRef={inputRef}
            />
            <div className="mt-2 flex items-center justify-between gap-2 md:justify-end">
              {/* In compact layouts the desktop sorting control is not visible. */}
              <button
                type="button"
                onClick={toggleDueSort}
                aria-pressed={sortByDueTime}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs transition-colors md:hidden",
                  sortByDueTime
                    ? "bg-accent-primary/12 font-medium text-accent-primary"
                    : "text-tx-secondary hover:bg-app-hover",
                )}
                title={sortByDueTime ? t("tasks.backToManualOrder") : t("tasks.sortByDueTime")}
              >
                <CalendarDays size={13} />
                <span>{sortByDueTime ? t("tasks.dueSoonFirst") : t("tasks.sortByDueTime")}</span>
              </button>
              <details className="group relative">
                <summary className="flex cursor-pointer list-none items-center gap-1 rounded-xl px-2.5 py-1 text-xs font-medium text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-secondary">
                  <MoreHorizontal size={13} />
                  {t("tasks.moreTools", { defaultValue: "更多工具" })}
                  {reminderBadgeCount > 0 && (
                    <span className="min-w-[16px] rounded-full bg-amber-500 px-1 text-center text-[9px] leading-4 text-white">
                      {reminderBadgeCount}
                    </span>
                  )}
                </summary>
                <div className="absolute right-0 top-full z-30 mt-1 flex w-56 flex-col gap-1 rounded-2xl border border-app-border/80 bg-app-elevated/95 p-2 shadow-2xl backdrop-blur-xl">
                  <button
                    type="button"
                    onClick={() => setShowTemplatePicker(true)}
                    className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-medium text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                  >
                    <FileText size={14} className="text-sky-500" /> {t("tasks.templates.button")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowReminderCenter(true)}
                    className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-medium text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                  >
                    <Bell size={14} className="text-amber-500" /> {t("tasks.reminderCenter.open")}
                  </button>
                  <div className="border-t border-app-border/70 pt-1">
                    <TaskCalendarFeedSettings />
                    <CalendarExportTargetSettings />
                  </div>
                </div>
              </details>
            </div>
          </div>
        )}

        {/* Task List / Board / Calendar View */}
        {centerMode === "inbox" ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-app-bg">
            <TaskInboxPanel
              initiallyExpanded
              standalone
              onTaskMutated={() => setWorkspaceVersion((value) => value + 1)}
            />
          </div>
        ) : centerMode === "my-day" ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-app-bg">
            <MyDayPanel
              initiallyExpanded
              standalone
              onTaskMutated={() => setWorkspaceVersion((value) => value + 1)}
            />
          </div>
        ) : centerMode === "planner" ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-app-bg">
            <TaskTimePlanner
              initiallyExpanded
              standalone
              onTaskMutated={() => setWorkspaceVersion((value) => value + 1)}
            />
          </div>
        ) : centerMode === "stats" ? (
          <StatsCenter
            tasks={statsTasks}
            projects={projects}
            taskStats={stats}
            habits={statsHabits}
            habitStats={habitStats}
            checkins={statsHabitCheckins}
            loading={statsLoading}
            onRefresh={loadStatsCenter}
          />
        ) : centerMode === "habits" ? (
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-5 py-3">
            {visibleHabits.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-tx-tertiary">
                {t("habits.empty")}
              </div>
            ) : (
              <div className="space-y-2.5">
                {visibleHabits.map((habit) => (
                  <HabitRow
                    key={habit.id}
                    habit={habit}
                    onCheckin={handleHabitCheckin}
                    onArchiveToggle={handleArchiveHabitToggle}
                    onDelete={handleDeleteHabit}
                  />
                ))}
              </div>
            )}
          </div>
        ) : filter !== "archived" && filter !== "completed-today" && viewMode === "board" && !isLoading && displayTasks.length > 0 ? (
          <TaskBoardView
            tasks={displayTasks}
            onSelect={(task) => setSelectedTaskId(task.id)}
            onStatusChange={handleStatusChange}
          />
        ) : filter !== "archived" && filter !== "completed-today" && viewMode === "calendar" && !isLoading ? (
          <TaskCalendarView
            tasks={displayTasks}
            onSelect={(task) => setSelectedTaskId(task.id)}
            onMoveTaskDate={handleMoveTaskDate}
          />
        ) : filter !== "archived" && filter !== "completed-today" && viewMode === "timeline" && !isLoading ? (
          <TaskGanttView
            tasks={displayTasks}
            projects={projects}
            dependencies={dependencies}
            onSelect={(task) => setSelectedTaskId(task.id)}
            onUpdateTaskDateRange={handleUpdateTaskDateRange}
          />
        ) : (
          <div className="relative z-10 flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-5 py-3">
            {isLoading ? (
              <div className="space-y-2.5" aria-label={t("common.loading")}>
                {[0, 1, 2].map((index) => (
                  <div key={index} className="flex animate-pulse items-center gap-3 rounded-2xl border border-app-border/70 bg-app-elevated/75 px-3.5 py-3">
                    <div className="h-5 w-5 rounded-full bg-app-hover/85" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3.5 w-48 rounded-md bg-app-hover/90" />
                      <div className="h-2.5 w-28 rounded-md bg-app-hover/65" />
                    </div>
                  </div>
                ))}
              </div>
            ) : displayTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-tx-tertiary">
                {searchQuery ? (
                  <TaskEmptyState type="no-search" compact onAction={() => setSearchQuery("")} />
                ) : (
                  filter === "archived" || filter === "completed-today"
                    ? <TaskEmptyState type="no-tasks" title={t(filter === "archived" ? "tasks.lifecycle.noArchived" : "tasks.lifecycle.noCompletedToday")} description={t(filter === "archived" ? "tasks.lifecycle.archiveHint" : "tasks.lifecycle.todayHint")} />
                    : <TaskEmptyState type="no-tasks" onAction={() => inputRef.current?.focus()} />
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <AnimatePresence mode="popLayout">
                  {isTreeMode ? (
                    displayFlatOrdered.map((item) => (
                      <div
                        key={item.node.id}
                        data-task-context-id={item.node.id}
                        tabIndex={0}
                        className={cn(
                          "relative",
                          dragOverId === item.node.id && dragId !== item.node.id && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent-primary before:rounded-full before:-translate-y-1"
                        )}
                        draggable={filter !== "archived" && filter !== "completed-today" && !selectMode && !sortByDueTime && !isMobile}
                        onDragStart={(e) => handleDragStart(item.node.id, e)}
                        onDragOver={(e) => handleDragOver(item.node.id, e)}
                        onDrop={() => handleDrop(item.node.id)}
                        onDragEnd={handleDragEnd}
                      >
                        {selectMode && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleSelectId(item.node.id); }}
                            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-1"
                          >
                            {selectedIds.has(item.node.id)
                              ? <CheckSquare size={16} className="text-accent-primary" />
                              : <Square size={16} className="text-tx-tertiary" />}
                          </button>
                        )}
                        <TaskTreeRow
                          task={item.node}
                          depth={item.depth}
                          isExpanded={expandedTaskIds.has(item.node.id)}
                          hasChildren={item.node.children.length > 0}
                          onToggle={handleToggle}
                          onSelect={(task) => { if (!selectMode) setSelectedTaskId(task.id); else toggleSelectId(task.id); }}
                          onDelete={handleDelete}
                          onToggleExpand={toggleExpand}
                          onCreateChild={handleCreateChild}
                          blockedByDependency={isTaskBlockedByDependency(item.node.id, dependencies, tasks)}
                        />
                      </div>
                    ))
                  ) : (
                    displayTasks.map((task) => (
                      <div
                        key={task.id}
                        data-task-context-id={task.id}
                        tabIndex={0}
                        className={cn(
                          "relative",
                          dragOverId === task.id && dragId !== task.id && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent-primary before:rounded-full before:-translate-y-1"
                        )}
                        draggable={filter !== "archived" && filter !== "completed-today" && !selectMode && !sortByDueTime && !isMobile}
                        onDragStart={(e) => handleDragStart(task.id, e)}
                        onDragOver={(e) => handleDragOver(task.id, e)}
                        onDrop={() => handleDrop(task.id)}
                        onDragEnd={handleDragEnd}
                      >
                        {selectMode && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleSelectId(task.id); }}
                            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-1"
                          >
                            {selectedIds.has(task.id)
                              ? <CheckSquare size={16} className="text-accent-primary" />
                              : <Square size={16} className="text-tx-tertiary" />}
                          </button>
                        )}
                        {filter === "completed-today" && <div className="px-3 pt-2 text-xs text-tx-tertiary">{task.parentTitle ? `${task.parentTitle} · ` : ""}{task.completedAt ? formatAppTime(task.completedAt, {hour:"2-digit",minute:"2-digit"}, "", []) : ""}</div>}
                        <FlatTaskRow
                          task={task}
                          onToggle={handleToggle}
                          onSelect={(task) => { if (!selectMode) setSelectedTaskId(task.id); else toggleSelectId(task.id); }}
                          onDelete={handleDelete}
                          allTasks={tasks}
                          onCreateChild={handleCreateChild}
                          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
                          blockedByDependency={isTaskBlockedByDependency(task.id, dependencies, tasks)}
                        />
                      </div>
                    ))
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        )}

        {/* Mobile: batch action bar at bottom */}
        {selectMode && (
          <div className="md:hidden flex items-center justify-between gap-2 px-4 py-3 border-t border-app-border bg-app-surface">
            <span className="text-xs text-tx-tertiary">{t("tasks.selectedCount", { count: selectedIds.size })}</span>
            <div className="flex items-center gap-2">
              <button onClick={selectedIds.size === flatOrderedTasks.length ? handleDeselectAll : handleSelectAll}
                className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-full text-tx-secondary hover:bg-app-hover">
                <CheckSquare size={14} />
                {selectedIds.size === flatOrderedTasks.length ? t("tasks.deselectAll") : t("tasks.selectAll")}
              </button>
              <button onClick={handleBatchComplete} disabled={selectedIds.size === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-full bg-accent-primary/10 text-accent-primary disabled:opacity-40">
                <CheckSquare size={14} /> {t("tasks.batchComplete")}
              </button>
              <button onClick={handleBatchDelete} disabled={selectedIds.size === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-full bg-red-500/10 text-red-500 disabled:opacity-40">
                <Trash2 size={14} /> {t("tasks.batchDelete")}
              </button>
              <button onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                className="text-xs text-tx-tertiary px-2 py-1.5">
                {t("tasks.batchCancel")}
              </button>
            </div>
          </div>
        )}
      </div>

      {taskMenu.isOpen && contextTask && <React.Suspense fallback={null}><TaskContextMenu menu={taskMenu} menuRef={taskMenuRef} task={contextTask} projects={projects} canArchive={canArchiveContextTask} onAction={handleTaskMenuAction} /></React.Suspense>}
      {contextNoteTask && <React.Suspense fallback={null}><TaskSaveNoteDialog task={contextNoteTask} draft={{ title: contextNoteTask.title, description: contextNoteTask.description || "" }} onClose={() => setContextNoteTask(null)} /></React.Suspense>}
      {recurrenceDeleteTask && <React.Suspense fallback={null}><TaskRecurrenceDeleteDialog task={recurrenceDeleteTask} onClose={() => setRecurrenceDeleteTask(null)} onConfirm={async mode => {
        if (mode === "stop") await api.stopTaskRecurrence(recurrenceDeleteTask.id);
        else await api.deleteTask(recurrenceDeleteTask.id,mode);
        setSelectedTaskId(null); await loadTasks(); refreshCounts();
      }} /></React.Suspense>}
      {contextChildTask && <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" onClick={() => setContextChildTask(null)}>
        <div role="dialog" aria-modal="true" aria-labelledby="task-context-child-title" className="w-full max-w-md rounded-xl border border-app-border bg-app-surface p-4 shadow-xl" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") setContextChildTask(null); }}>
          <h2 id="task-context-child-title" className="font-semibold text-tx-primary">{t("tasks.addChild")}</h2>
          <p className="mb-3 truncate text-sm text-tx-secondary">{contextChildTask.title}</p>
          <SubtaskInput parentId={contextChildTask.id} onSubmit={handleCreateChild} onCancel={() => setContextChildTask(null)} />
        </div>
      </div>}

      {/* Project edit dialog */}
      {editingProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setEditingProject(null)}>
          <div className="bg-app-surface rounded-xl border border-app-border shadow-xl p-5 w-72 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-tx-primary">{t("tasks.projectName")}</h3>
            <input type="text" value={editProjectName} onChange={(e) => setEditProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleUpdateProject(); }}
              className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary"
              autoFocus />
            <div className="flex items-center gap-2">
              <span className="text-xs text-tx-tertiary">{t("tasks.projectColor")}</span>
              {["#6366f1", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280"].map((c) => (
                <button key={c} onClick={() => setEditProjectColor(c)}
                  className={cn("w-5 h-5 rounded-full border-2 transition-all", editProjectColor === c ? "border-tx-primary scale-110" : "border-transparent")}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setEditingProject(null)} className="px-3 py-1.5 text-xs text-tx-secondary rounded-md hover:bg-app-hover">{t("tasks.batchCancel")}</button>
              <button onClick={handleUpdateProject} className="px-3 py-1.5 text-xs text-white bg-accent-primary rounded-md hover:opacity-90">{t("tasks.save")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile project picker */}
      {mobileProjectOpen && (
        <MobileProjectPicker
          projects={projects}
          selectedProjectId={selectedProjectId}
          onClose={() => setMobileProjectOpen(false)}
          onSelect={(id) => { setSelectedProjectId(id); setFilter("all"); setSelectedTaskId(null); setSearchQuery(""); setMobileProjectOpen(false); }}
          onCreate={async (name) => { await handleCreateProject(name); setMobileProjectOpen(false); }}
          t={t}
        />
      )}

      {/* Right: Detail Panel — direct flex sibling, no AnimatePresence to avoid layout gap */}
      {aiAvailable && showTaskComposer && <React.Suspense fallback={null}><TaskComposer projects={projects} initialProjectId={selectedProjectId} onClose={() => setShowTaskComposer(false)} onCreated={() => { void loadTasks(); void refreshCounts(); }} onView={selectTaskFilter} /></React.Suspense>}
      {centerMode === "tasks" && selectedTask && (
        <TaskDetailPanel
          key={selectedTask.id}
          task={selectedTask}
          treeNode={selectedTreeNode}
          onClose={() => setSelectedTaskId(null)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onArchive={handleArchive}
          allTasks={tasks}
          onToggle={handleToggle}
          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
          onCreated={async () => { await loadTasks(); const s = await api.getTaskStats(); setStats(s); refreshCounts(); }}
          onReminderCountChange={handleReminderCountChange}
          dependencies={dependencies}
          onCreateDependency={async (predId, succId) => { try { await api.createTaskDependency({ predecessorTaskId: predId, successorTaskId: succId }); await loadDependencies(); toast.success(t("tasks.toast.dependencyCreated")); } catch { toast.error(t("tasks.toast.dependencyCreateFailed")); } }}
          onDeleteDependency={async (id) => { try { await api.deleteTaskDependency(id); await loadDependencies(); toast.success(t("tasks.toast.dependencyDeleted")); } catch { toast.error(t("tasks.toast.dependencyDeleteFailed")); } }}
        />
      )}

      {/* Template Picker */}
      <AnimatePresence>
        {showTemplatePicker && (
          <TaskTemplatePicker
            projects={projects}
            onClose={() => setShowTemplatePicker(false)}
            onApplied={async () => { setShowTemplatePicker(false); await loadTasks(); const s = await api.getTaskStats(); setStats(s); refreshCounts(); toast.success(t("tasks.toast.templateApplied")); }}
          />
        )}
      </AnimatePresence>

      {/* Reminder Center */}
      <AnimatePresence>
        {showReminderCenter && (
          <ReminderCenter
            open={showReminderCenter}
            onClose={() => setShowReminderCenter(false)}
            onSelectTask={(taskId) => setSelectedTaskId(taskId)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
