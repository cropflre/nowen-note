import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bookmark,
  BookmarkPlus,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Filter,
  Flag,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { Task, TaskProject } from "@/types";
import {
  createTaskLabel,
  createTaskSavedView,
  deleteTaskLabel,
  deleteTaskSavedView,
  EMPTY_TASK_SAVED_VIEW_FILTERS,
  getTaskMetadata,
  setTaskLabels,
  updateTaskLabel,
  updateTaskSavedView,
  type TaskLabel,
  type TaskMetadataDue,
  type TaskMetadataSnapshot,
  type TaskMetadataStatus,
  type TaskSavedViewFilters,
} from "@/lib/taskMetadataApi";
import {
  countTaskSavedViewFilters,
  filterTasksBySavedView,
  hasTaskSavedViewFilters,
} from "./taskSavedViewFilter";

const COLORS = [
  "#6366f1",
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#6b7280",
];

function emptyFilters(): TaskSavedViewFilters {
  return {
    ...EMPTY_TASK_SAVED_VIEW_FILTERS,
    labelIds: [],
    priorities: [],
    statuses: [],
  };
}

function emptySnapshot(): TaskMetadataSnapshot {
  return { workspaceId: "personal", labels: [], assignments: {}, views: [] };
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.isCompleted !== b.isCompleted) return a.isCompleted - b.isCompleted;
    if (a.priority !== b.priority) return b.priority - a.priority;
    const aDate = a.dueAt || a.dueDate || "9999-12-31";
    const bDate = b.dueAt || b.dueDate || "9999-12-31";
    return aDate.localeCompare(bDate) || a.sortOrder - b.sortOrder;
  });
}

function taskDate(task: Task): string {
  return (task.dueAt || task.dueDate || "").slice(0, 16).replace("T", " ");
}

function Dialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4"
      onMouseDown={onClose}
    >
      <div
        className="max-h-[86vh] w-full max-w-2xl overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function TaskMetadataWorkspace({ children }: { children: React.ReactNode }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.toLowerCase().startsWith("zh");
  const copy = useMemo(() => zh ? {
    smart: "智能视图",
    filter: "筛选",
    saved: "保存的视图",
    noSaved: "暂无保存视图",
    labels: "任务标签",
    manageLabels: "管理标签",
    assignLabels: "标注任务",
    saveView: "保存视图",
    saveAs: "另存视图",
    updateView: "更新视图",
    clear: "清除筛选",
    any: "任一标签",
    all: "全部标签",
    due: "时间范围",
    project: "项目",
    keyword: "关键词",
    anyProject: "全部项目",
    noProject: "无项目",
    priority: "优先级",
    status: "状态",
    pending: "未完成",
    today: "今天到期",
    week: "未来 7 天",
    overdue: "已逾期",
    completed: "已完成",
    todo: "待处理",
    doing: "进行中",
    blocked: "已阻塞",
    done: "已完成",
    high: "高",
    medium: "中",
    low: "低",
    results: "条任务",
    noResults: "没有符合当前条件的任务",
    normal: "返回普通任务中心",
    newLabel: "新建标签",
    labelName: "标签名称",
    viewName: "视图名称",
    taskSearch: "搜索任务…",
    create: "创建",
    save: "保存",
    cancel: "取消",
    close: "关闭",
    edit: "编辑",
    remove: "删除",
    loadFailed: "加载任务标签和保存视图失败",
    updateFailed: "更新失败",
    workspaceHint: "工作区标签为共享资源；保存视图仅属于当前账号。",
  } : {
    smart: "Smart views",
    filter: "Filters",
    saved: "Saved views",
    noSaved: "No saved views",
    labels: "Task labels",
    manageLabels: "Manage labels",
    assignLabels: "Label tasks",
    saveView: "Save view",
    saveAs: "Save as",
    updateView: "Update view",
    clear: "Clear filters",
    any: "Match any",
    all: "Match all",
    due: "Due range",
    project: "Project",
    keyword: "Keyword",
    anyProject: "Any project",
    noProject: "No project",
    priority: "Priority",
    status: "Status",
    pending: "Pending",
    today: "Due today",
    week: "Next 7 days",
    overdue: "Overdue",
    completed: "Completed",
    todo: "To do",
    doing: "Doing",
    blocked: "Blocked",
    done: "Done",
    high: "High",
    medium: "Medium",
    low: "Low",
    results: "tasks",
    noResults: "No tasks match these filters",
    normal: "Return to task center",
    newLabel: "New label",
    labelName: "Label name",
    viewName: "View name",
    taskSearch: "Search tasks…",
    create: "Create",
    save: "Save",
    cancel: "Cancel",
    close: "Close",
    edit: "Edit",
    remove: "Delete",
    loadFailed: "Failed to load task labels and saved views",
    updateFailed: "Update failed",
    workspaceHint: "Workspace labels are shared; saved views belong to your account.",
  }, [zh]);

  const [snapshot, setSnapshot] = useState<TaskMetadataSnapshot>(emptySnapshot);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<TaskProject[]>([]);
  const [filters, setFilters] = useState<TaskSavedViewFilters>(emptyFilters);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [loadingMetadata, setLoadingMetadata] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [labelDialog, setLabelDialog] = useState(false);
  const [assignDialog, setAssignDialog] = useState(false);
  const [viewDialog, setViewDialog] = useState(false);
  const [viewName, setViewName] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState(COLORS[0]);
  const [editingLabel, setEditingLabel] = useState<TaskLabel | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingColor, setEditingColor] = useState(COLORS[0]);
  const [taskQuery, setTaskQuery] = useState("");
  const [assigningTaskId, setAssigningTaskId] = useState<string | null>(null);

  const smartActive = hasTaskSavedViewFilters(filters);
  const filterCount = countTaskSavedViewFilters(filters);

  const loadMetadata = useCallback(async () => {
    setLoadingMetadata(true);
    try {
      const [metadata, projectRows] = await Promise.all([
        getTaskMetadata(),
        api.getTaskProjects(),
      ]);
      setSnapshot(metadata);
      setProjects(projectRows);
    } catch (error) {
      console.error("task metadata load failed", error);
      toast.error(copy.loadFailed);
    } finally {
      setLoadingMetadata(false);
    }
  }, [copy.loadFailed]);

  const loadTasks = useCallback(async () => {
    if (loadingTasks) return;
    setLoadingTasks(true);
    try {
      setTasks(await api.getTasks("all"));
      setTasksLoaded(true);
    } catch (error) {
      console.error("task metadata task load failed", error);
      toast.error(copy.loadFailed);
      setTasksLoaded(true);
    } finally {
      setLoadingTasks(false);
    }
  }, [copy.loadFailed, loadingTasks]);

  useEffect(() => { void loadMetadata(); }, [loadMetadata]);
  useEffect(() => {
    if (smartActive && !tasksLoaded && !loadingTasks) void loadTasks();
  }, [loadTasks, loadingTasks, smartActive, tasksLoaded]);

  const labelMap = useMemo(
    () => new Map(snapshot.labels.map((label) => [label.id, label])),
    [snapshot.labels],
  );
  const projectMap = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const filteredTasks = useMemo(
    () => sortTasks(filterTasksBySavedView(tasks, filters, snapshot.assignments)),
    [filters, snapshot.assignments, tasks],
  );

  const patchFilters = (patch: Partial<TaskSavedViewFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  };
  const toggleValue = <T,>(values: T[], value: T): T[] => (
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
  );

  const clearFilters = () => {
    setFilters(emptyFilters());
    setActiveViewId(null);
    setFilterOpen(false);
  };

  const applyView = (id: string) => {
    const view = snapshot.views.find((item) => item.id === id);
    if (!view) return;
    setFilters({
      ...view.filters,
      labelIds: [...view.filters.labelIds],
      priorities: [...view.filters.priorities],
      statuses: [...view.filters.statuses],
    });
    setActiveViewId(id);
    setFilterOpen(false);
  };

  const createLabel = async () => {
    if (!newLabelName.trim()) return;
    try {
      await createTaskLabel({ name: newLabelName, color: newLabelColor });
      setNewLabelName("");
      await loadMetadata();
    } catch (error) {
      toast.error((error as Error).message || copy.updateFailed);
    }
  };

  const saveLabel = async () => {
    if (!editingLabel || !editingName.trim()) return;
    try {
      await updateTaskLabel(editingLabel.id, { name: editingName, color: editingColor });
      setEditingLabel(null);
      await loadMetadata();
    } catch (error) {
      toast.error((error as Error).message || copy.updateFailed);
    }
  };

  const removeLabel = async (label: TaskLabel) => {
    const confirmed = window.confirm(
      zh ? `删除标签「${label.name}」？任务不会被删除。` : `Delete “${label.name}”? Tasks will remain.`,
    );
    if (!confirmed) return;
    try {
      await deleteTaskLabel(label.id);
      setFilters((current) => ({
        ...current,
        labelIds: current.labelIds.filter((id) => id !== label.id),
      }));
      await loadMetadata();
    } catch (error) {
      toast.error((error as Error).message || copy.updateFailed);
    }
  };

  const openAssignments = async (task?: Task) => {
    setAssignDialog(true);
    setTaskQuery(task?.title || "");
    if (!tasksLoaded) await loadTasks();
  };

  const toggleTaskLabel = async (taskId: string, labelId: string) => {
    if (assigningTaskId) return;
    const previous = snapshot.assignments[taskId] || [];
    const next = previous.includes(labelId)
      ? previous.filter((id) => id !== labelId)
      : [...previous, labelId];
    setAssigningTaskId(taskId);
    setSnapshot((current) => ({
      ...current,
      assignments: { ...current.assignments, [taskId]: next },
    }));
    try {
      await setTaskLabels(taskId, next);
      await loadMetadata();
    } catch (error) {
      setSnapshot((current) => ({
        ...current,
        assignments: { ...current.assignments, [taskId]: previous },
      }));
      toast.error((error as Error).message || copy.updateFailed);
    } finally {
      setAssigningTaskId(null);
    }
  };

  const createView = async () => {
    if (!viewName.trim() || !smartActive) return;
    try {
      const result = await createTaskSavedView({ name: viewName, filters });
      setViewName("");
      setViewDialog(false);
      await loadMetadata();
      setActiveViewId(result.view.id);
    } catch (error) {
      toast.error((error as Error).message || copy.updateFailed);
    }
  };

  const updateView = async () => {
    if (!activeViewId) return;
    try {
      await updateTaskSavedView(activeViewId, { filters });
      await loadMetadata();
    } catch (error) {
      toast.error((error as Error).message || copy.updateFailed);
    }
  };

  const removeView = async (id: string) => {
    const view = snapshot.views.find((item) => item.id === id);
    const confirmed = window.confirm(
      zh ? `删除视图「${view?.name || ""}」？` : `Delete view “${view?.name || ""}”?`,
    );
    if (!confirmed) return;
    try {
      await deleteTaskSavedView(id);
      if (activeViewId === id) clearFilters();
      await loadMetadata();
    } catch (error) {
      toast.error((error as Error).message || copy.updateFailed);
    }
  };

  const toggleComplete = async (task: Task) => {
    try {
      const result = await api.updateTask(task.id, {
        isCompleted: task.isCompleted === 1 ? 0 : 1,
      });
      setTasks((current) => current.map((item) => item.id === task.id ? result.task : item));
    } catch (error) {
      toast.error((error as Error).message || copy.updateFailed);
    }
  };

  const visibleAssignmentTasks = useMemo(() => {
    const query = taskQuery.trim().toLocaleLowerCase();
    return (query
      ? tasks.filter((task) => `${task.title}\n${task.description || ""}`.toLocaleLowerCase().includes(query))
      : tasks
    ).slice(0, 100);
  }, [taskQuery, tasks]);

  const dueOptions: Array<{ value: TaskMetadataDue; label: string }> = [
    { value: "all", label: zh ? "全部" : "All" },
    { value: "pending", label: copy.pending },
    { value: "today", label: copy.today },
    { value: "week", label: copy.week },
    { value: "overdue", label: copy.overdue },
    { value: "completed", label: copy.completed },
  ];
  const statusOptions: Array<{ value: TaskMetadataStatus; label: string }> = [
    { value: "todo", label: copy.todo },
    { value: "doing", label: copy.doing },
    { value: "blocked", label: copy.blocked },
    { value: "done", label: copy.done },
  ];

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-app-bg">
      <div className="shrink-0 border-b border-app-border bg-app-surface">
        <div className="flex min-h-10 items-center gap-2 px-3 md:px-4">
          {snapshot.views.length > 0 && <Bookmark size={14} className="shrink-0 text-accent-primary" />}
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none]">
            {snapshot.views.map((view) => (
              <div key={view.id} className="group flex shrink-0 items-center rounded-full border border-app-border bg-app-bg">
                <button
                  onClick={() => applyView(view.id)}
                  className={cn(
                    "max-w-40 truncate px-2.5 py-1 text-xs",
                    activeViewId === view.id ? "font-medium text-accent-primary" : "text-tx-secondary hover:text-tx-primary",
                  )}
                >{view.name}</button>
                <button
                  onClick={() => void removeView(view.id)}
                  className="mr-1 hidden rounded-full p-0.5 text-tx-tertiary hover:bg-app-hover hover:text-red-500 group-hover:inline-flex"
                  title={copy.remove}
                ><X size={10} /></button>
              </div>
            ))}
          </div>

          <button
            onClick={() => setFilterOpen((value) => !value)}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs",
              filterOpen || smartActive ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover",
            )}
          >
            <Filter size={13} />
            <span className="hidden sm:inline">{copy.filter}</span>
            {filterCount > 0 && <span className="rounded-full bg-accent-primary px-1.5 text-[9px] text-white">{filterCount}</span>}
            <ChevronDown size={11} className={cn("transition-transform", filterOpen && "rotate-180")} />
          </button>
          <button onClick={() => setLabelDialog(true)} className="rounded-md p-1.5 text-tx-secondary hover:bg-app-hover hover:text-accent-primary" title={copy.manageLabels}>
            <Tag size={14} />
          </button>
          <button
            onClick={() => void openAssignments()}
            className="hidden rounded-md p-1.5 text-tx-secondary hover:bg-app-hover hover:text-accent-primary md:block"
            title={copy.assignLabels}
          >
            <Pencil size={14} />
          </button>
          {smartActive && (
            <>
              {activeViewId && (
                <button onClick={() => void updateView()} className="hidden items-center gap-1 rounded-md px-2 py-1.5 text-xs text-accent-primary hover:bg-accent-primary/10 md:flex">
                  <Check size={13} /> {copy.updateView}
                </button>
              )}
              <button onClick={() => setViewDialog(true)} className="hidden items-center gap-1 rounded-md px-2 py-1.5 text-xs text-accent-primary hover:bg-accent-primary/10 md:flex">
                <BookmarkPlus size={13} /> {activeViewId ? copy.saveAs : copy.saveView}
              </button>
              <button onClick={clearFilters} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary" title={copy.clear}>
                <RotateCcw size={14} />
              </button>
            </>
          )}
        </div>

        {filterOpen && (
          <div className="space-y-3 border-t border-app-border px-3 py-3 md:px-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 text-xs font-medium text-tx-secondary">{copy.labels}</span>
              <div className="flex flex-1 flex-wrap gap-1.5">
                {snapshot.labels.map((label) => {
                  const active = filters.labelIds.includes(label.id);
                  return (
                    <button
                      key={label.id}
                      onClick={() => patchFilters({ labelIds: toggleValue(filters.labelIds, label.id) })}
                      className={cn(
                        "flex items-center gap-1 rounded-full border px-2 py-1 text-xs",
                        active ? "border-transparent text-white" : "border-app-border text-tx-secondary hover:bg-app-hover",
                      )}
                      style={active ? { backgroundColor: label.color } : undefined}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: label.color }} />
                      {label.name}
                    </button>
                  );
                })}
                {snapshot.labels.length === 0 && (
                  <button onClick={() => setLabelDialog(true)} className="text-xs text-accent-primary hover:underline">{copy.newLabel}</button>
                )}
              </div>
              {filters.labelIds.length > 1 && (
                <div className="flex overflow-hidden rounded-md border border-app-border text-[10px]">
                  <button onClick={() => patchFilters({ labelMode: "any" })} className={cn("px-2 py-1", filters.labelMode === "any" ? "bg-accent-primary text-white" : "text-tx-tertiary")}>{copy.any}</button>
                  <button onClick={() => patchFilters({ labelMode: "all" })} className={cn("px-2 py-1", filters.labelMode === "all" ? "bg-accent-primary text-white" : "text-tx-tertiary")}>{copy.all}</button>
                </div>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-1">
                <span className="text-xs font-medium text-tx-secondary">{copy.due}</span>
                <select value={filters.due} onChange={(event) => patchFilters({ due: event.target.value as TaskMetadataDue })} className="w-full rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-xs text-tx-primary focus:border-accent-primary focus:outline-none">
                  {dueOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-tx-secondary">{copy.project}</span>
                <select
                  value={filters.projectId === undefined ? "__any__" : filters.projectId === null ? "__none__" : filters.projectId}
                  onChange={(event) => patchFilters({
                    projectId: event.target.value === "__any__" ? undefined : event.target.value === "__none__" ? null : event.target.value,
                  })}
                  className="w-full rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-xs text-tx-primary focus:border-accent-primary focus:outline-none"
                >
                  <option value="__any__">{copy.anyProject}</option>
                  <option value="__none__">{copy.noProject}</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              <label className="space-y-1 md:col-span-2">
                <span className="text-xs font-medium text-tx-secondary">{copy.keyword}</span>
                <div className="flex items-center rounded-md border border-app-border bg-app-bg px-2">
                  <Search size={12} className="text-tx-tertiary" />
                  <input value={filters.keyword} onChange={(event) => patchFilters({ keyword: event.target.value })} className="w-full bg-transparent px-2 py-1.5 text-xs text-tx-primary focus:outline-none" />
                </div>
              </label>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-xs font-medium text-tx-secondary">{copy.priority}</span>
                {[
                  { value: 3, label: copy.high, color: "text-red-500" },
                  { value: 2, label: copy.medium, color: "text-amber-500" },
                  { value: 1, label: copy.low, color: "text-blue-500" },
                ].map((option) => (
                  <button key={option.value} onClick={() => patchFilters({ priorities: toggleValue(filters.priorities, option.value) })} className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-xs", filters.priorities.includes(option.value) ? "border-accent-primary bg-accent-primary/10" : "border-app-border hover:bg-app-hover", option.color)}>
                    <Flag size={11} /> {option.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-medium text-tx-secondary">{copy.status}</span>
                {statusOptions.map((option) => (
                  <button key={option.value} onClick={() => patchFilters({ statuses: toggleValue(filters.statuses, option.value) })} className={cn("rounded-md border px-2 py-1 text-xs", filters.statuses.includes(option.value) ? "border-accent-primary bg-accent-primary/10 text-accent-primary" : "border-app-border text-tx-tertiary hover:bg-app-hover")}>{option.label}</button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-app-border pt-2 md:hidden">
              {smartActive && activeViewId && <button onClick={() => void updateView()} className="text-xs text-accent-primary">{copy.updateView}</button>}
              {smartActive && <button onClick={() => setViewDialog(true)} className="text-xs text-accent-primary">{copy.saveView}</button>}
              <button onClick={() => void openAssignments()} className="text-xs text-accent-primary">{copy.assignLabels}</button>
            </div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {!smartActive ? children : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-app-border px-4 py-2.5 md:px-6">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-tx-primary">
                  <Filter size={14} className="text-accent-primary" />
                  {activeViewId ? snapshot.views.find((view) => view.id === activeViewId)?.name || copy.smart : copy.smart}
                </div>
                <p className="mt-0.5 text-[11px] text-tx-tertiary">{copy.workspaceHint}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-tx-tertiary">{filteredTasks.length} {copy.results}</span>
                <button onClick={clearFilters} className="text-xs text-accent-primary hover:underline">{copy.normal}</button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 md:px-6">
              {loadingTasks ? (
                <div className="flex h-40 items-center justify-center"><Loader2 size={20} className="animate-spin text-tx-tertiary" /></div>
              ) : filteredTasks.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-tx-tertiary"><Filter size={24} />{copy.noResults}</div>
              ) : (
                <div className="mx-auto max-w-5xl space-y-2">
                  {filteredTasks.map((task) => (
                    <div key={task.id} className={cn("group flex items-start gap-3 rounded-lg border border-app-border bg-app-elevated px-3 py-2.5 hover:border-accent-primary/30", task.isCompleted === 1 && "opacity-60") }>
                      <button onClick={() => void toggleComplete(task)} className="mt-0.5 shrink-0">
                        {task.isCompleted === 1 ? <CheckCircle2 size={19} className="text-accent-primary" /> : <Circle size={19} className="text-tx-tertiary hover:text-accent-primary" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className={cn("text-sm text-tx-primary", task.isCompleted === 1 && "line-through text-tx-tertiary")}>{task.title}</div>
                        {task.description && <p className="mt-0.5 line-clamp-1 text-xs text-tx-tertiary">{task.description}</p>}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {task.projectId && projectMap.get(task.projectId) && (
                            <span className="flex items-center gap-1 rounded-full bg-app-hover px-2 py-0.5 text-[10px] text-tx-secondary">
                              <FolderOpen size={9} style={{ color: projectMap.get(task.projectId)?.color }} />
                              {projectMap.get(task.projectId)?.name}
                            </span>
                          )}
                          {(snapshot.assignments[task.id] || []).map((labelId) => {
                            const label = labelMap.get(labelId);
                            return label ? <span key={label.id} className="rounded-full px-2 py-0.5 text-[10px] text-white" style={{ backgroundColor: label.color }}>{label.name}</span> : null;
                          })}
                          {taskDate(task) && <span className="text-[10px] text-tx-tertiary">{taskDate(task)}</span>}
                        </div>
                      </div>
                      <Flag size={13} className={task.priority === 3 ? "text-red-500" : task.priority === 2 ? "text-amber-500" : "text-blue-500"} />
                      <button onClick={() => void openAssignments(task)} className="rounded-md p-1 text-tx-tertiary opacity-0 hover:bg-app-hover hover:text-accent-primary group-hover:opacity-100" title={copy.assignLabels}><Tag size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {labelDialog && (
        <Dialog onClose={() => setLabelDialog(false)}>
          <div className="flex items-center justify-between border-b border-app-border px-5 py-3">
            <div><h3 className="text-sm font-semibold text-tx-primary">{copy.manageLabels}</h3><p className="mt-0.5 text-[11px] text-tx-tertiary">{copy.workspaceHint}</p></div>
            <button onClick={() => setLabelDialog(false)} className="rounded p-1 text-tx-tertiary hover:bg-app-hover"><X size={16} /></button>
          </div>
          <div className="max-h-[72vh] space-y-4 overflow-y-auto p-5">
            <div className="rounded-lg border border-app-border bg-app-bg p-3">
              <div className="flex gap-2">
                <input value={newLabelName} onChange={(event) => setNewLabelName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createLabel(); }} placeholder={copy.labelName} className="min-w-0 flex-1 rounded-md border border-app-border bg-app-surface px-3 py-2 text-sm text-tx-primary focus:border-accent-primary focus:outline-none" />
                <button onClick={() => void createLabel()} className="flex items-center gap-1 rounded-md bg-accent-primary px-3 py-2 text-xs text-white"><Plus size={13} />{copy.create}</button>
              </div>
              <div className="mt-2 flex gap-1.5">{COLORS.map((color) => <button key={color} onClick={() => setNewLabelColor(color)} className={cn("h-5 w-5 rounded-full border-2", newLabelColor === color ? "border-tx-primary" : "border-transparent")} style={{ backgroundColor: color }} />)}</div>
            </div>
            <div className="space-y-2">
              {snapshot.labels.map((label) => (
                <div key={label.id} className="rounded-lg border border-app-border bg-app-elevated p-3">
                  {editingLabel?.id === label.id ? (
                    <div className="space-y-2">
                      <input value={editingName} onChange={(event) => setEditingName(event.target.value)} className="w-full rounded-md border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary focus:border-accent-primary focus:outline-none" />
                      <div className="flex items-center justify-between">
                        <div className="flex gap-1.5">{COLORS.map((color) => <button key={color} onClick={() => setEditingColor(color)} className={cn("h-5 w-5 rounded-full border-2", editingColor === color ? "border-tx-primary" : "border-transparent")} style={{ backgroundColor: color }} />)}</div>
                        <div className="flex gap-2"><button onClick={() => setEditingLabel(null)} className="text-xs text-tx-tertiary">{copy.cancel}</button><button onClick={() => void saveLabel()} className="rounded-md bg-accent-primary px-3 py-1.5 text-xs text-white">{copy.save}</button></div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: label.color }} />
                      <div className="min-w-0 flex-1"><div className="truncate text-sm text-tx-primary">{label.name}</div><div className="text-[10px] text-tx-tertiary">{label.taskCount} {copy.results}</div></div>
                      <button onClick={() => { setEditingLabel(label); setEditingName(label.name); setEditingColor(label.color); }} className="rounded p-1 text-tx-tertiary hover:bg-app-hover hover:text-accent-primary" title={copy.edit}><Pencil size={14} /></button>
                      <button onClick={() => void removeLabel(label)} className="rounded p-1 text-tx-tertiary hover:bg-red-500/10 hover:text-red-500" title={copy.remove}><Trash2 size={14} /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Dialog>
      )}

      {assignDialog && (
        <Dialog onClose={() => setAssignDialog(false)}>
          <div className="flex items-center justify-between border-b border-app-border px-5 py-3">
            <div><h3 className="text-sm font-semibold text-tx-primary">{copy.assignLabels}</h3><p className="mt-0.5 text-[11px] text-tx-tertiary">{copy.workspaceHint}</p></div>
            <button onClick={() => setAssignDialog(false)} className="rounded p-1 text-tx-tertiary hover:bg-app-hover"><X size={16} /></button>
          </div>
          <div className="border-b border-app-border p-4"><div className="flex items-center rounded-md border border-app-border bg-app-bg px-3"><Search size={14} className="text-tx-tertiary" /><input value={taskQuery} onChange={(event) => setTaskQuery(event.target.value)} placeholder={copy.taskSearch} className="w-full bg-transparent px-2 py-2 text-sm text-tx-primary focus:outline-none" /></div></div>
          <div className="max-h-[65vh] space-y-2 overflow-y-auto p-4">
            {loadingTasks ? <div className="flex h-24 items-center justify-center"><Loader2 size={18} className="animate-spin text-tx-tertiary" /></div> : snapshot.labels.length === 0 ? <button onClick={() => { setAssignDialog(false); setLabelDialog(true); }} className="w-full py-10 text-sm text-accent-primary">{copy.newLabel}</button> : visibleAssignmentTasks.map((task) => (
              <div key={task.id} className="rounded-lg border border-app-border bg-app-elevated p-3">
                <div className="flex items-center gap-2"><span className={cn("min-w-0 flex-1 truncate text-sm text-tx-primary", task.isCompleted === 1 && "line-through text-tx-tertiary")}>{task.title}</span>{assigningTaskId === task.id && <Loader2 size={13} className="animate-spin text-accent-primary" />}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">{snapshot.labels.map((label) => {
                  const active = (snapshot.assignments[task.id] || []).includes(label.id);
                  return <button key={label.id} disabled={!!assigningTaskId} onClick={() => void toggleTaskLabel(task.id, label.id)} className={cn("flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] disabled:opacity-50", active ? "border-transparent text-white" : "border-app-border text-tx-secondary hover:bg-app-hover")} style={active ? { backgroundColor: label.color } : undefined}>{active && <Check size={10} />}{label.name}</button>;
                })}</div>
              </div>
            ))}
          </div>
        </Dialog>
      )}

      {viewDialog && (
        <Dialog onClose={() => setViewDialog(false)}>
          <div className="flex items-center justify-between border-b border-app-border px-5 py-3"><h3 className="text-sm font-semibold text-tx-primary">{copy.saveView}</h3><button onClick={() => setViewDialog(false)} className="rounded p-1 text-tx-tertiary hover:bg-app-hover"><X size={16} /></button></div>
          <div className="space-y-4 p-5"><input autoFocus value={viewName} onChange={(event) => setViewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createView(); }} placeholder={copy.viewName} className="w-full rounded-md border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary focus:border-accent-primary focus:outline-none" /><div className="flex justify-end gap-2"><button onClick={() => setViewDialog(false)} className="rounded-md px-3 py-2 text-xs text-tx-secondary hover:bg-app-hover">{copy.cancel}</button><button onClick={() => void createView()} className="rounded-md bg-accent-primary px-3 py-2 text-xs text-white">{copy.save}</button></div></div>
        </Dialog>
      )}

      {loadingMetadata && <div className="pointer-events-none absolute right-3 top-3"><Loader2 size={14} className="animate-spin text-tx-tertiary" /></div>}
    </div>
  );
}
