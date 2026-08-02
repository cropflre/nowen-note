import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Star,
  Sun,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "@/types";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  getTaskDayPlan,
  saveTaskDayPlan,
  type TaskDayPlan,
} from "@/lib/taskDayPlanApi";
import {
  formatMyDayDate,
  getMyDaySuggestions,
  isTaskDueToday,
  isTaskOverdue,
  normalizeMyDayPlan,
  orderMyDayTasks,
} from "./taskMyDay";

interface MyDayPanelProps {
  onTaskMutated?: () => void;
}

function emptyPlan(date: string): TaskDayPlan {
  return {
    date,
    workspaceId: "personal",
    taskIds: [],
    focusTaskIds: [],
    updatedAt: null,
  };
}

export function MyDayPanel({ onTaskMutated }: MyDayPanelProps) {
  const { i18n } = useTranslation();
  const chinese = i18n.language.toLowerCase().startsWith("zh");
  const today = useMemo(() => formatMyDayDate(), []);
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem("nowen-my-day-expanded") !== "false";
    } catch {
      return true;
    }
  });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [plan, setPlan] = useState<TaskDayPlan>(() => emptyPlan(today));
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);

  const labels = useMemo(() => chinese
    ? {
        title: "我的一天",
        subtitle: "主动选择今天要完成的任务，不修改原截止日期",
        focus: "今日重点",
        planned: "今日计划",
        suggestions: "建议加入",
        searchResults: "搜索结果",
        search: "搜索其他任务加入今天…",
        empty: "今天还没有安排任务",
        emptyHint: "从下方建议中加入，或搜索任意未完成任务。",
        completed: "已完成",
        refresh: "刷新任务",
        remove: "移出今日计划",
        add: "加入今天",
        setFocus: "设为今日重点",
        unsetFocus: "取消重点",
        focusLimit: "今日重点最多选择 3 个",
        loadFailed: "加载今日计划失败",
        saveFailed: "保存今日计划失败",
        updateFailed: "更新任务失败",
        overdue: "已逾期",
        dueToday: "今天到期",
        noSuggestions: "没有需要优先处理的建议任务",
      }
    : {
        title: "My Day",
        subtitle: "Choose what to do today without changing task deadlines",
        focus: "Focus",
        planned: "Today's plan",
        suggestions: "Suggested",
        searchResults: "Search results",
        search: "Search unfinished tasks…",
        empty: "Nothing planned for today",
        emptyHint: "Add a suggestion below or search for any unfinished task.",
        completed: "completed",
        refresh: "Refresh tasks",
        remove: "Remove from My Day",
        add: "Add to My Day",
        setFocus: "Mark as focus",
        unsetFocus: "Remove focus",
        focusLimit: "You can choose up to 3 focus tasks",
        loadFailed: "Failed to load My Day",
        saveFailed: "Failed to save My Day",
        updateFailed: "Failed to update task",
        overdue: "Overdue",
        dueToday: "Due today",
        noSuggestions: "No urgent suggestions right now",
      }, [chinese]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [taskRows, storedPlan] = await Promise.all([
        api.getTasks("all"),
        getTaskDayPlan(today),
      ]);
      const existingIds = new Set(taskRows.map((task) => task.id));
      const normalized = normalizeMyDayPlan(
        storedPlan.taskIds,
        storedPlan.focusTaskIds,
        existingIds,
      );
      setTasks(taskRows);
      setPlan({ ...storedPlan, ...normalized });
    } catch (error) {
      console.error("[MyDay] load failed", error);
      toast.error(labels.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [labels.loadFailed, today]);

  useEffect(() => {
    void load();
    const refreshOnFocus = () => void load();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem("nowen-my-day-expanded", String(expanded));
    } catch {
      // Storage can be unavailable in privacy mode; expansion remains session-local.
    }
  }, [expanded]);

  const plannedTasks = useMemo(
    () => orderMyDayTasks(tasks, plan),
    [plan, tasks],
  );
  const completedCount = plannedTasks.filter((task) => !!task.isCompleted).length;
  const progress = plannedTasks.length === 0
    ? 0
    : Math.round((completedCount / plannedTasks.length) * 100);
  const suggestions = useMemo(
    () => getMyDaySuggestions(tasks, today, plan.taskIds),
    [plan.taskIds, tasks, today],
  );
  const availableTasks = useMemo(() => {
    const planned = new Set(plan.taskIds);
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return suggestions.slice(0, 6);
    return tasks
      .filter((task) => !task.isCompleted && !planned.has(task.id))
      .filter((task) => task.title.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 8);
  }, [plan.taskIds, query, suggestions, tasks]);

  const persist = useCallback(async (taskIds: string[], focusTaskIds: string[]) => {
    if (saving) return;
    const previous = plan;
    const normalized = normalizeMyDayPlan(taskIds, focusTaskIds, new Set(tasks.map((task) => task.id)));
    const optimistic = { ...plan, ...normalized };
    setPlan(optimistic);
    setSaving(true);
    try {
      const saved = await saveTaskDayPlan({
        date: today,
        taskIds: normalized.taskIds,
        focusTaskIds: normalized.focusTaskIds,
      });
      setPlan(saved);
    } catch (error) {
      console.error("[MyDay] save failed", error);
      setPlan(previous);
      toast.error(labels.saveFailed);
    } finally {
      setSaving(false);
    }
  }, [labels.saveFailed, plan, saving, tasks, today]);

  const addTask = (taskId: string) => {
    void persist([...plan.taskIds, taskId], plan.focusTaskIds);
    setQuery("");
  };

  const removeTask = (taskId: string) => {
    void persist(
      plan.taskIds.filter((id) => id !== taskId),
      plan.focusTaskIds.filter((id) => id !== taskId),
    );
  };

  const toggleFocus = (taskId: string) => {
    if (plan.focusTaskIds.includes(taskId)) {
      void persist(plan.taskIds, plan.focusTaskIds.filter((id) => id !== taskId));
      return;
    }
    if (plan.focusTaskIds.length >= 3) {
      toast.error(labels.focusLimit);
      return;
    }
    void persist(plan.taskIds, [...plan.focusTaskIds, taskId]);
  };

  const toggleComplete = async (task: Task) => {
    if (completingId) return;
    setCompletingId(task.id);
    try {
      const result = await api.updateTask(task.id, {
        isCompleted: task.isCompleted ? 0 : 1,
      });
      setTasks((current) => current.map((item) => item.id === task.id ? result.task : item));
      onTaskMutated?.();
    } catch (error) {
      console.error("[MyDay] update task failed", error);
      toast.error(labels.updateFailed);
    } finally {
      setCompletingId(null);
    }
  };

  const dateLabel = useMemo(() => new Intl.DateTimeFormat(
    chinese ? "zh-CN" : "en-US",
    { month: "long", day: "numeric", weekday: "short" },
  ).format(new Date(`${today}T12:00:00`)), [chinese, today]);

  return (
    <section className="shrink-0 border-b border-border bg-background/95 backdrop-blur">
      <div className="flex min-h-14 items-center gap-3 px-3 py-2 sm:px-5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <Sun size={19} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <strong className="truncate text-sm text-foreground">{labels.title}</strong>
              <span className="shrink-0 text-xs text-muted-foreground">{dateLabel}</span>
            </span>
            <span className="mt-1 flex items-center gap-2">
              <span className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-amber-500 transition-[width]"
                  style={{ width: `${progress}%` }}
                />
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {completedCount}/{plannedTasks.length} {labels.completed}
              </span>
            </span>
          </span>
          {expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
        </button>

        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          onClick={() => void load()}
          disabled={loading}
          title={labels.refresh}
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {expanded && (
        <div className="max-h-[42vh] overflow-y-auto border-t border-border/60 px-3 py-3 sm:px-5">
          <p className="mb-3 text-xs text-muted-foreground">{labels.subtitle}</p>

          {loading ? (
            <div className="flex h-24 items-center justify-center text-muted-foreground">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.42fr)]">
              <div className="min-w-0">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {labels.planned}
                  </h3>
                  {plan.focusTaskIds.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-300">
                      <Star size={12} fill="currentColor" />
                      {labels.focus} {plan.focusTaskIds.length}/3
                    </span>
                  )}
                </div>

                {plannedTasks.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
                    <CalendarDays size={22} className="mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm font-medium text-foreground">{labels.empty}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{labels.emptyHint}</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {plannedTasks.map((task) => {
                      const focused = plan.focusTaskIds.includes(task.id);
                      const overdue = isTaskOverdue(task, today);
                      const dueToday = isTaskDueToday(task, today);
                      return (
                        <div
                          key={task.id}
                          className="group flex items-center gap-2 rounded-xl border border-border/70 bg-card px-2.5 py-2 shadow-sm"
                        >
                          <button
                            type="button"
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                              task.isCompleted
                                ? "border-emerald-500 bg-emerald-500 text-white"
                                : "border-muted-foreground/50 hover:border-emerald-500"
                            }`}
                            onClick={() => void toggleComplete(task)}
                            disabled={completingId === task.id}
                            aria-label={task.title}
                          >
                            {completingId === task.id
                              ? <Loader2 size={12} className="animate-spin" />
                              : task.isCompleted ? <Check size={12} strokeWidth={3} /> : null}
                          </button>

                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className={`truncate text-sm ${task.isCompleted ? "text-muted-foreground line-through" : "text-foreground"}`}>
                                {task.title}
                              </span>
                              {focused && <Star size={12} className="shrink-0 text-amber-500" fill="currentColor" />}
                            </div>
                            {(overdue || dueToday) && (
                              <span className={`mt-0.5 inline-flex items-center gap-1 text-[10px] ${overdue ? "text-destructive" : "text-muted-foreground"}`}>
                                {overdue ? <AlertTriangle size={10} /> : <CalendarDays size={10} />}
                                {overdue ? labels.overdue : labels.dueToday}
                              </span>
                            )}
                          </div>

                          <button
                            type="button"
                            className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                              focused
                                ? "text-amber-500 hover:bg-amber-500/10"
                                : "text-muted-foreground opacity-60 hover:bg-muted hover:text-amber-500 group-hover:opacity-100"
                            }`}
                            onClick={() => toggleFocus(task.id)}
                            disabled={saving}
                            title={focused ? labels.unsetFocus : labels.setFocus}
                          >
                            <Star size={14} fill={focused ? "currentColor" : "none"} />
                          </button>
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground opacity-60 hover:bg-muted hover:text-destructive group-hover:opacity-100"
                            onClick={() => removeTask(task.id)}
                            disabled={saving}
                            title={labels.remove}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="min-w-0">
                <label className="relative block">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={labels.search}
                    className="h-9 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                  />
                </label>
                <h3 className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {query.trim() ? labels.searchResults : labels.suggestions}
                </h3>

                {availableTasks.length === 0 ? (
                  <p className="rounded-xl bg-muted/50 px-3 py-4 text-center text-xs text-muted-foreground">
                    {labels.noSuggestions}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {availableTasks.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted disabled:opacity-50"
                        onClick={() => addTask(task.id)}
                        disabled={saving}
                        title={labels.add}
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <Plus size={13} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{task.title}</span>
                        {isTaskOverdue(task, today) && (
                          <AlertTriangle size={12} className="shrink-0 text-destructive" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default MyDayPanel;
