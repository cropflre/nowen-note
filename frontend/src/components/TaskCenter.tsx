import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Calendar, ListTodo,
  CalendarDays, AlertTriangle, CheckCheck, Inbox,
  Search, X as XIcon, GripVertical,
  CheckSquare, Trash2, Square,
  LayoutGrid, LayoutList, Calendar as CalendarIcon, BarChart3, FolderOpen, Plus, ChevronRight, Bell, Maximize2, Minimize2,
  MoreHorizontal, Trash2 as TrashIcon, FileText,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Task, TaskFilter, TaskStats, TaskStatus, TaskProject, TaskDependency } from "@/types";
import { cn } from "@/lib/utils";
import { isTaskBlockedByDependency } from "./tasks/taskDependencyUtils";
import {
  TASK_CENTER_MAIN_CLASS,
  TASK_CENTER_ROOT_CLASS,
  TASK_MOBILE_FILTER_BAR_CLASS,
} from "@/lib/taskLayout";

// sub-components & utilities
import { useTaskTree } from "./tasks/useTaskTree";
import { buildTaskTree } from "./tasks/taskProgress";
import type { TaskTreeNode } from "./tasks/taskProgress";
import { TaskOverview } from "./tasks/TaskOverview";
import { TaskTreeRow } from "./tasks/TaskTreeRow";
import { TaskQuickAdd } from "./tasks/TaskQuickAdd";
import { TaskEmptyState } from "./tasks/TaskEmptyState";
import { TaskDetailPanel } from "./tasks/TaskDetailPanel";
import { FlatTaskRow } from "./tasks/FlatTaskRow";
import { useReminderNotifier } from "./tasks/useReminderNotifier";
import { useTaskProjects } from "./tasks/useTaskProjects";
import { TaskBoardView } from "./tasks/TaskBoardView";
import { TaskCalendarView } from "./tasks/TaskCalendarView";
import TaskGanttView from "./tasks/TaskGanttView";
import { compareTasksByDueTime, moveTaskToDate } from "./tasks/taskDateUtils";
import { TaskTemplatePicker } from "./tasks/TaskTemplatePicker";
import { ReminderCenter } from "./tasks/ReminderCenter";
import { TaskCalendarFeedSettings } from "./tasks/TaskCalendarFeedSettings";
import { CalendarExportTargetSettings } from "./tasks/CalendarExportTargetSettings";
import { MobileProjectTrigger, MobileProjectPicker } from "./tasks/MobileProjectPicker";
import { taskMatchesSearch } from "./tasks/taskSearch";

/* ===== Main Component ===== */
export default function TaskCenter() {
  const { t } = useTranslation();

  const FILTERS: { key: TaskFilter; label: string; icon: React.ReactNode }[] = [
    { key: "all", label: t("tasks.allTasks"), icon: <Inbox size={16} /> },
    { key: "today", label: t("tasks.today"), icon: <CalendarDays size={16} /> },
    { key: "week", label: t("tasks.next7Days"), icon: <Calendar size={16} /> },
    { key: "overdue", label: t("tasks.overdue"), icon: <AlertTriangle size={16} /> },
    { key: "completed", label: t("tasks.completed"), icon: <CheckCheck size={16} /> },
  ];

  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingOrphansRef = useRef<string[]>([]);

  // Phase 4: search
  const [searchQuery, setSearchQuery] = useState("");
  const [workspaceVersion, setWorkspaceVersion] = useState(0);

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

  // Phase 4: view mode (list / board)
  type ViewMode = "list" | "board" | "calendar" | "timeline";
  const [viewMode, setViewMode] = useState<ViewMode>("list");

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
  const [sortByDueTime, setSortByDueTime] = useState(false);

  // Phase 4: batch select mode
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Phase 4: drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const treeSourceTasks = useMemo(() => {
    if (!sortByDueTime) return tasks;
    const roots = tasks.filter((task) => !task.parentId).sort(compareTasksByDueTime);
    const children = tasks.filter((task) => task.parentId);
    return [...roots, ...children];
  }, [tasks, sortByDueTime]);

  // tree hook
  const {
    flatOrderedTasks,
    expandedTaskIds,
    toggleExpand,
    isTreeMode,
  } = useTaskTree(treeSourceTasks, filter);

  // background reminder notifier
  useReminderNotifier();

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
    return sortByDueTime ? [...source].sort(compareTasksByDueTime) : source;
  }, [tasks, searchQuery, sortByDueTime]);

  // recompute flatOrdered for display (search-filtered)
  const displayFlatOrdered = useMemo(() => {
    if (!searchQuery.trim()) return flatOrderedTasks;
    return flatOrderedTasks.filter((item) => taskMatchesSearch(item.node, searchQuery));
  }, [flatOrderedTasks, searchQuery]);

  const loadTasks = useCallback(async () => {
    try {
      const [data, statsData] = await Promise.all([
        api.getTasks(filter, undefined, selectedProjectId || undefined),
        api.getTaskStats(),
      ]);
      setTasks(data);
      setStats(statsData);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setIsLoading(false);
    }
  }, [filter, selectedProjectId, workspaceVersion]);

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

  useEffect(() => { loadTasks(); loadDependencies(); loadReminderBadge(); }, [loadTasks, loadDependencies, loadReminderBadge]);

  useEffect(() => {
    const onWs = () => { setSelectedTaskId(null); setSearchQuery(""); setSelectedIds(new Set()); setSelectMode(false); setSelectedProjectId(null); setWorkspaceVersion((v) => v + 1); reload(); };
    window.addEventListener("nowen:workspace-changed", onWs);
    return () => window.removeEventListener("nowen:workspace-changed", onWs);
  }, [loadTasks]);

  // === Keyboard shortcuts ===
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
  }, [selectMode, selectedTaskId, searchQuery]);

  // === CRUD Handlers ===
  const handleToggle = async (id: string) => {
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

  const handleCreate = async (orphanIds: string[] = []): Promise<boolean> => {
    if (!newTitle.trim()) return false;
    const titleToCreate = newTitle.trim();
    try {
      const task = await api.createTask({ title: titleToCreate, projectId: selectedProjectId || undefined });
      setTasks((prev) => [task, ...prev]);
      setNewTitle("");
      inputRef.current?.focus();
      if (orphanIds.length) {
        await Promise.all(
          orphanIds.map((id) => api.taskAttachments.bind(id, task.id).catch(() => null))
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

  const handleCreateChild = async (title: string, parentId: string): Promise<void> => {
    try {
      // Inherit projectId from parent, or use selectedProjectId
      const parentTask = tasks.find((t) => t.id === parentId);
      const childProjectId = parentTask?.projectId || selectedProjectId || undefined;
      const task = await api.createTask({ title, parentId, projectId: childProjectId });
      setTasks((prev) => [task, ...prev]);
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch (err) {
      console.error("Failed to create child task:", err);
      toast.error(t("tasks.toast.createFailed"));
    }
  };

  const handleDelete = async (id: string) => {
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
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch { toast.error(t("tasks.toast.deleteFailed")); loadTasks(); }
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
    const allIds = new Set(flatOrderedTasks.map((t) => t.id));
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
    } catch { toast.error(t("tasks.toast.bulkCompleteFailed")); loadTasks(); }
  };

  const handleBatchDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
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
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch { toast.error(t("tasks.toast.bulkDeleteFailed")); loadTasks(); }
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

  return (
    <div className={cn(TASK_CENTER_ROOT_CLASS, taskFullscreen && "fixed inset-0 z-[80] bg-app-bg")}>
      {/* Left: Sidebar Filters + Projects (desktop) */}
      <div className="hidden md:flex w-56 shrink-0 flex-col border-r border-app-border bg-app-surface overflow-y-auto" style={{ paddingTop: "var(--safe-area-top)" }}>
        <div className="px-4 py-3 border-b border-app-border">
          <span className="text-xs font-semibold text-tx-tertiary uppercase tracking-wider">{t("tasks.title")}</span>
        </div>
        <nav className="flex-1 px-2 py-1.5 space-y-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
              className={cn(
                "flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm transition-colors",
                filter === f.key && !selectedProjectId ? "bg-accent-primary/10 text-accent-primary font-medium" : "text-tx-secondary hover:bg-app-hover"
              )}
            >
              {f.icon}
              <span className="flex-1 text-left">{f.label}</span>
              <span className={cn(
                "text-xs min-w-[20px] text-center rounded-full px-1.5 py-0.5",
                filter === f.key && !selectedProjectId ? "bg-accent-primary/20 text-accent-primary" : "text-tx-tertiary"
              )}>
                {filterCount(f.key)}
              </span>
            </button>
          ))}

          {/* Projects section */}
          <div className="mt-3 mb-0.5 px-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-tx-tertiary uppercase tracking-wider">{t("tasks.projects")}</span>
              <button
                onClick={() => setShowNewProject(true)}
                className="p-0.5 rounded hover:bg-app-hover text-tx-tertiary hover:text-accent-primary transition-colors"
                title={t("tasks.newProject")}
              >
                <Plus size={12} />
              </button>
            </div>
          </div>

          {showNewProject && (
            <div className="px-2 pb-1">
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateProject(); if (e.key === "Escape") setShowNewProject(false); }}
                placeholder={t("tasks.projectName")}
                className="w-full px-2 py-1 text-xs rounded-md bg-app-bg border border-app-border text-tx-primary focus:outline-none focus:border-accent-primary"
                autoFocus
              />
            </div>
          )}

          {projects.map((p) => (
            <div key={p.id} className="relative">
              <button
                onClick={() => { setSelectedProjectId(p.id); setFilter("all"); setSelectedTaskId(null); setSearchQuery(""); }}
                className={cn(
                  "flex items-center gap-2.5 w-full px-3 py-1.5 rounded-lg text-sm transition-colors group",
                  selectedProjectId === p.id ? "bg-accent-primary/10 text-accent-primary font-medium" : "text-tx-secondary hover:bg-app-hover"
                )}
              >
                <FolderOpen size={14} style={{ color: p.color }} />
                <span className="flex-1 text-left truncate">{p.name}</span>
                <span className="text-[10px] text-tx-tertiary">{p.completedCount ?? 0}/{p.taskCount ?? 0}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); setShowProjectMenu(showProjectMenu === p.id ? null : p.id); }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-app-hover text-tx-tertiary transition-all"
                >
                  <MoreHorizontal size={12} />
                </button>
              </button>
              {/* Progress bar */}
              {(p.taskCount ?? 0) > 0 && (
                <div className="mx-3 mb-1 h-1 rounded-full bg-app-border overflow-hidden">
                  <div className="h-full rounded-full bg-accent-primary transition-all" style={{ width: `${p.progress ?? 0}%` }} />
                </div>
              )}
              {/* Project menu */}
              {showProjectMenu === p.id && (
                <div className="absolute right-0 top-full z-20 mt-1 w-36 rounded-lg border border-app-border bg-app-surface shadow-lg py-1">
                  <button onClick={() => { setEditingProject(p); setEditProjectName(p.name); setEditProjectColor(p.color); setShowProjectMenu(null); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover">{t("tasks.projectName")}</button>
                  <button onClick={() => handleDeleteProject(p.id)}
                    className="w-full text-left px-3 py-1.5 text-xs text-accent-danger hover:bg-accent-danger/10">{t("tasks.deleteProject")}</button>
                </div>
              )}
            </div>
          ))}
        </nav>
      </div>

      {/* Center: Task List */}
      <div className={TASK_CENTER_MAIN_CLASS}>
        {/* Mobile: horizontal filter bar */}
        <div className={TASK_MOBILE_FILTER_BAR_CLASS}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setSelectedTaskId(null); setSearchQuery(""); }}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0",
                filter === f.key
                  ? "bg-accent-primary/15 text-accent-primary"
                  : "text-tx-secondary bg-app-hover/50 active:bg-app-active"
              )}
            >
              {f.icon}
              {f.label}
              <span className={cn(
                "text-[10px] min-w-[16px] text-center",
                filter === f.key ? "text-accent-primary" : "text-tx-tertiary"
              )}>
                {filterCount(f.key)}
              </span>
            </button>
          ))}
          {/* Mobile project trigger */}
          <MobileProjectTrigger
            selectedProjectId={selectedProjectId}
            projects={projects}
            onClick={() => setMobileProjectOpen(true)}
            t={t}
          />
          {/* Mobile view toggle (cycle: list -> board -> calendar -> list) */}
          <button
            onClick={() => setViewMode(viewMode === "list" ? "board" : viewMode === "board" ? "calendar" : "list")}
            className="flex items-center gap-1 px-2 py-1.5 rounded-full text-xs shrink-0 text-tx-secondary bg-app-hover/50 active:bg-app-active"
            title={viewMode === "list" ? t("tasks.boardView") : viewMode === "board" ? t("tasks.calendarView") : t("tasks.listView")}
          >
            {viewMode === "list" ? <LayoutGrid size={12} /> : viewMode === "board" ? <CalendarIcon size={12} /> : <LayoutList size={12} />}
          </button>
        </div>

        {/* Overview cards only in all filter */}
        {filter === "all" && !isLoading && (
          <TaskOverview tasks={tasks} stats={stats} />
        )}

        {/* Header desktop with batch controls */}
        <div className="hidden md:flex items-center justify-between px-5 py-3 border-b border-app-border">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-tx-primary">
              {selectedProjectId
                ? projects.find((p) => p.id === selectedProjectId)?.name || t("tasks.allTasks")
                : FILTERS.find((f) => f.key === filter)?.label || t("tasks.allTasks")}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {/* View mode toggle */}
            <div className="flex items-center rounded-md border border-app-border overflow-hidden">
              <button
                onClick={() => setViewMode("list")}
                className={cn("p-1.5 transition-colors", viewMode === "list" ? "bg-accent-primary/10 text-accent-primary" : "text-tx-tertiary hover:text-tx-secondary")}
                title={t("tasks.listView")}
              >
                <LayoutList size={14} />
              </button>
              <button
                onClick={() => setViewMode("board")}
                className={cn("p-1.5 transition-colors", viewMode === "board" ? "bg-accent-primary/10 text-accent-primary" : "text-tx-tertiary hover:text-tx-secondary")}
                title={t("tasks.boardView")}
              >
                <LayoutGrid size={14} />
              </button>
              <button
                onClick={() => setViewMode("calendar")}
                className={cn("p-1.5 transition-colors", viewMode === "calendar" ? "bg-accent-primary/10 text-accent-primary" : "text-tx-tertiary hover:text-tx-secondary")}
                title={t("tasks.calendarView")}
              >
                <CalendarIcon size={14} />
              </button>
              <button
                onClick={() => setViewMode("timeline")}
                className={cn("p-1.5 transition-colors", viewMode === "timeline" ? "bg-accent-primary/10 text-accent-primary" : "text-tx-tertiary hover:text-tx-secondary")}
                title={t("tasks.timelineView")}
              >
                <BarChart3 size={14} />
              </button>
            </div>
            <button
              onClick={() => setSortByDueTime((v) => !v)}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                sortByDueTime ? "bg-accent-primary/10 text-accent-primary" : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover"
              )}
              title={t("tasks.sortByDueTime")}
            >
              <CalendarDays size={14} />
            </button>
            <button
              onClick={() => setTaskFullscreen((v) => !v)}
              className="p-1.5 rounded-md transition-colors text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover"
              title={taskFullscreen ? t("tasks.exitFullscreen") : t("tasks.enterFullscreen")}
            >
              {taskFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
          <div className="flex items-center gap-2">
            {selectMode ? (
              <>
                <span className="text-xs text-tx-tertiary">{t("tasks.selectedCount", { count: selectedIds.size })}</span>
                <button
                  onClick={selectedIds.size === flatOrderedTasks.length ? handleDeselectAll : handleSelectAll}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-tx-secondary hover:bg-app-hover transition-colors"
                >
                  <CheckSquare size={14} />
                  {selectedIds.size === flatOrderedTasks.length ? t("tasks.deselectAll") : t("tasks.selectAll")}
                </button>
                <button
                  onClick={handleBatchComplete}
                  disabled={selectedIds.size === 0}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 disabled:opacity-40 transition-colors"
                >
                  <CheckSquare size={14} /> {t("tasks.batchComplete")}
                </button>
                <button
                  onClick={handleBatchDelete}
                  disabled={selectedIds.size === 0}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-red-500/10 text-red-500 hover:bg-red-500/20 disabled:opacity-40 transition-colors"
                >
                  <Trash2 size={14} /> {t("tasks.batchDelete")}
                </button>
                <button
                  onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                  className="text-xs text-tx-tertiary hover:text-tx-secondary px-2 py-1 transition-colors"
                >
                  {t("tasks.batchCancel")}
                </button>
              </>
            ) : (
              <button
                onClick={() => setSelectMode(true)}
                className="flex items-center gap-1 px-2 py-1 text-xs text-tx-tertiary hover:text-tx-secondary rounded-md hover:bg-app-hover transition-colors"
                title={t("tasks.selectMode")}
              >
                <CheckSquare size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Search bar */}
        <div className="flex items-center gap-2 px-4 md:px-5 py-1.5 border-b border-app-border">
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
            <button onClick={() => setSearchQuery("")} className="text-tx-tertiary hover:text-tx-secondary transition-colors">
              <XIcon size={14} />
            </button>
          )}
        </div>

        {/* Quick Add */}
        <div className="px-4 md:px-5 py-2 border-b border-app-border">
          <TaskQuickAdd
            value={newTitle}
            onChange={setNewTitle}
            onSubmit={handleCreate}
            inputRef={inputRef}
          />
          <div className="flex items-center gap-1 mt-2">
            <button
              type="button"
              onClick={() => setShowTemplatePicker(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-tx-tertiary hover:text-accent-primary rounded-md hover:bg-accent-primary/5 transition-colors"
            >
              <FileText size={13} />
              {t("tasks.templates.button")}
            </button>
            <button
              type="button"
              onClick={() => setShowReminderCenter(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-tx-tertiary hover:text-accent-primary rounded-md hover:bg-accent-primary/5 transition-colors relative"
            >
              <Bell size={13} />
              {t("tasks.reminderCenter.open")}
              {reminderBadgeCount > 0 && (
                <span className="absolute -top-1 -right-1 text-[9px] min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-500 text-white flex items-center justify-center">
                  {reminderBadgeCount}
                </span>
              )}
            </button>
            <TaskCalendarFeedSettings />
            <CalendarExportTargetSettings />
          </div>
        </div>

        {/* Task List / Board / Calendar View */}
        {viewMode === "board" && !isLoading && displayTasks.length > 0 ? (
          <TaskBoardView
            tasks={displayTasks}
            onSelect={(task) => setSelectedTaskId(task.id)}
            onStatusChange={handleStatusChange}
          />
        ) : viewMode === "calendar" && !isLoading ? (
          <TaskCalendarView
            tasks={displayTasks}
            onSelect={(task) => setSelectedTaskId(task.id)}
            onMoveTaskDate={handleMoveTaskDate}
          />
        ) : viewMode === "timeline" && !isLoading ? (
          <TaskGanttView
            tasks={displayTasks}
            projects={projects}
            dependencies={dependencies}
            onSelect={(task) => setSelectedTaskId(task.id)}
            onUpdateTaskDateRange={handleUpdateTaskDateRange}
          />
        ) : (
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-5 py-2">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-tx-tertiary text-sm">
              {t("common.loading")}
            </div>
          ) : displayTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-tx-tertiary">
              {searchQuery ? (
                <TaskEmptyState type="no-search" compact onAction={() => setSearchQuery("")} />
              ) : (
                <TaskEmptyState type="no-tasks" onAction={() => inputRef.current?.focus()} />
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <AnimatePresence mode="popLayout">
                {isTreeMode ? (
                  displayFlatOrdered.map((item) => (
                    <div
                      key={item.node.id}
                      className={cn(
                        "relative",
                        dragOverId === item.node.id && dragId !== item.node.id && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent-primary before:rounded-full before:-translate-y-1"
                      )}
                      draggable={!selectMode && !sortByDueTime && !isMobile}
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
                      className={cn(
                        "relative",
                        dragOverId === task.id && dragId !== task.id && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent-primary before:rounded-full before:-translate-y-1"
                      )}
                      draggable={!selectMode && !sortByDueTime && !isMobile}
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
              {["#6366f1","#ef4444","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ec4899","#6b7280"].map((c) => (
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
      {selectedTask && (
        <TaskDetailPanel
          key={selectedTask.id}
          task={selectedTask}
          treeNode={selectedTreeNode}
          onClose={() => setSelectedTaskId(null)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
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
