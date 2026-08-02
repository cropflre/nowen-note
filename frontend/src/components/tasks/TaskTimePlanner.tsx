import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { Task } from "@/types";
import {
  createTaskTimeBlock,
  deleteTaskTimeBlock,
  getTaskTimeBlocks,
  updateTaskEstimate,
  updateTaskTimeBlock,
  type TaskTimeBlock,
} from "@/lib/taskTimePlanningApi";
import { cn } from "@/lib/utils";
import {
  addMinutesIso,
  combineLocalDateAndTime,
  findConflictingBlockIds,
  formatLocalDateKey,
  formatMinutes,
  localDayRange,
  minutesBetween,
  nextHalfHour,
  occupiedMinutes,
} from "./taskTimePlanning";

type PlannedTask = Task & { estimatedMinutes?: number | null };

const ESTIMATE_PRESETS = [15, 30, 45, 60, 90, 120, 180];
const DAY_CAPACITY_MINUTES = 8 * 60;

interface TaskTimePlannerProps {
  onTaskMutated?: () => void;
}

function dateInputValue(date: Date): string {
  return formatLocalDateKey(date);
}

function moveDate(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return dateInputValue(new Date(year, month - 1, day + days));
}

function timeText(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dateLabel(dateKey: string, chinese: boolean): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat(chinese ? "zh-CN" : undefined, {
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

export function TaskTimePlanner({ onTaskMutated }: TaskTimePlannerProps) {
  const { i18n } = useTranslation();
  const chinese = i18n.language.toLowerCase().startsWith("zh");
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem("nowen-task-time-planner-expanded") === "true";
    } catch {
      return false;
    }
  });
  const [dateKey, setDateKey] = useState(() => formatLocalDateKey());
  const [tasks, setTasks] = useState<PlannedTask[]>([]);
  const [blocks, setBlocks] = useState<TaskTimeBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [startTime, setStartTime] = useState(() => nextHalfHour());
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStartTime, setEditStartTime] = useState("");
  const [editDurationMinutes, setEditDurationMinutes] = useState(30);

  const labels = useMemo(() => chinese ? {
    title: "时间规划",
    subtitle: "把任务放进日程，不修改截止时间",
    today: "今天",
    task: "选择任务",
    chooseTask: "选择一个未完成任务…",
    estimate: "预估时长",
    clearEstimate: "清除预估",
    start: "开始时间",
    duration: "时间块",
    add: "加入日程",
    scheduled: "已安排",
    capacity: "日容量",
    conflicts: "时间冲突",
    noBlocks: "这一天还没有安排时间块",
    noTasks: "当前空间没有可安排的未完成任务",
    loadFailed: "加载时间规划失败",
    saveFailed: "保存时间规划失败",
    estimateFailed: "更新预估时长失败",
    deleteFailed: "删除时间块失败",
    edit: "调整",
    cancel: "取消",
    save: "保存",
    delete: "删除",
    completed: "已完成",
    overCapacity: "当天安排已超过 8 小时容量",
    conflictHint: "存在重叠时间块，请调整安排",
    refresh: "刷新",
  } : {
    title: "Time planning",
    subtitle: "Schedule tasks without changing their deadlines",
    today: "Today",
    task: "Task",
    chooseTask: "Choose an unfinished task…",
    estimate: "Estimate",
    clearEstimate: "Clear estimate",
    start: "Start",
    duration: "Time block",
    add: "Schedule",
    scheduled: "Scheduled",
    capacity: "Daily capacity",
    conflicts: "Conflicts",
    noBlocks: "No time blocks scheduled for this day",
    noTasks: "No unfinished tasks are available in this space",
    loadFailed: "Failed to load time planning",
    saveFailed: "Failed to save time planning",
    estimateFailed: "Failed to update estimate",
    deleteFailed: "Failed to delete time block",
    edit: "Adjust",
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    completed: "Completed",
    overCapacity: "This day exceeds the 8-hour planning capacity",
    conflictHint: "Some time blocks overlap",
    refresh: "Refresh",
  }, [chinese]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const range = localDayRange(dateKey);
      const [taskRows, blockRows] = await Promise.all([
        api.getTasks("all") as Promise<PlannedTask[]>,
        getTaskTimeBlocks(range.from, range.to),
      ]);
      setTasks(taskRows);
      setBlocks(blockRows.blocks);
      setSelectedTaskId((current) => {
        if (current && taskRows.some((task) => task.id === current && !task.isCompleted)) return current;
        return taskRows.find((task) => !task.isCompleted)?.id || "";
      });
    } catch (error) {
      console.error("[TaskTimePlanner] load failed", error);
      toast.error(labels.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [dateKey, labels.loadFailed]);

  useEffect(() => {
    if (!expanded) return;
    void load();
  }, [expanded, load]);

  useEffect(() => {
    try {
      localStorage.setItem("nowen-task-time-planner-expanded", String(expanded));
    } catch {
      // Keep the state in memory when storage is unavailable.
    }
  }, [expanded]);

  const availableTasks = useMemo(() => tasks
    .filter((task) => !task.isCompleted)
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return (a.dueAt || a.dueDate || "9999").localeCompare(b.dueAt || b.dueDate || "9999");
    }), [tasks]);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null;
  const conflictIds = useMemo(() => findConflictingBlockIds(blocks), [blocks]);
  const totalMinutes = useMemo(
    () => blocks.reduce((sum, block) => sum + minutesBetween(block.startAt, block.endAt), 0),
    [blocks],
  );
  const occupied = useMemo(() => occupiedMinutes(blocks), [blocks]);
  const capacityPercent = Math.min(100, Math.round((totalMinutes / DAY_CAPACITY_MINUTES) * 100));
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  const chooseTask = (taskId: string) => {
    setSelectedTaskId(taskId);
    const task = tasks.find((item) => item.id === taskId);
    if (task?.estimatedMinutes) setDurationMinutes(task.estimatedMinutes);
  };

  const setEstimate = async (minutes: number | null) => {
    if (!selectedTaskId) return;
    try {
      await updateTaskEstimate(selectedTaskId, minutes);
      setTasks((current) => current.map((task) => (
        task.id === selectedTaskId ? { ...task, estimatedMinutes: minutes } : task
      )));
      if (minutes) setDurationMinutes(minutes);
      onTaskMutated?.();
    } catch (error) {
      console.error("[TaskTimePlanner] estimate update failed", error);
      toast.error(labels.estimateFailed);
    }
  };

  const addBlock = async () => {
    if (!selectedTaskId || saving) return;
    const startAt = combineLocalDateAndTime(dateKey, startTime);
    const endAt = addMinutesIso(startAt, durationMinutes);
    setSaving(true);
    try {
      const block = await createTaskTimeBlock({
        taskId: selectedTaskId,
        startAt,
        endAt,
        timeZone,
      });
      setBlocks((current) => [...current, block].sort((a, b) => a.startAt.localeCompare(b.startAt)));
      setStartTime(timeText(endAt));
    } catch (error) {
      console.error("[TaskTimePlanner] create block failed", error);
      toast.error(labels.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const beginEdit = (block: TaskTimeBlock) => {
    setEditingId(block.id);
    setEditStartTime(timeText(block.startAt));
    setEditDurationMinutes(minutesBetween(block.startAt, block.endAt));
  };

  const saveEdit = async (block: TaskTimeBlock) => {
    if (saving) return;
    const startAt = combineLocalDateAndTime(dateKey, editStartTime);
    const endAt = addMinutesIso(startAt, editDurationMinutes);
    setSaving(true);
    try {
      const updated = await updateTaskTimeBlock(block.id, { startAt, endAt, timeZone });
      setBlocks((current) => current
        .map((item) => item.id === block.id ? updated : item)
        .sort((a, b) => a.startAt.localeCompare(b.startAt)));
      setEditingId(null);
    } catch (error) {
      console.error("[TaskTimePlanner] update block failed", error);
      toast.error(labels.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const removeBlock = async (id: string) => {
    try {
      await deleteTaskTimeBlock(id);
      setBlocks((current) => current.filter((block) => block.id !== id));
      if (editingId === id) setEditingId(null);
    } catch (error) {
      console.error("[TaskTimePlanner] delete block failed", error);
      toast.error(labels.deleteFailed);
    }
  };

  return (
    <section className="shrink-0 border-b border-app-border bg-app-surface">
      <div className="flex items-center gap-3 px-4 md:px-5 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
            <CalendarClock size={17} />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold text-tx-primary">{labels.title}</span>
              <span className="text-[10px] text-tx-tertiary">{dateLabel(dateKey, chinese)}</span>
            </span>
            <span className="hidden truncate text-[11px] text-tx-tertiary sm:block">{labels.subtitle}</span>
          </span>
        </button>

        <div className="hidden items-center gap-2 text-[11px] sm:flex">
          <span className={cn(
            "rounded-full px-2 py-1",
            totalMinutes > DAY_CAPACITY_MINUTES
              ? "bg-red-500/10 text-red-500"
              : "bg-app-elevated text-tx-secondary",
          )}>
            {labels.capacity} {formatMinutes(totalMinutes, chinese)} / 8h
          </span>
          {conflictIds.size > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-amber-600 dark:text-amber-400">
              <AlertTriangle size={11} /> {labels.conflicts} {conflictIds.size}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="rounded-md p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
        >
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-app-border/70 px-4 md:px-5 pb-4 pt-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-app-border bg-app-bg p-1">
              <button type="button" onClick={() => setDateKey((value) => moveDate(value, -1))} className="rounded p-1 text-tx-secondary hover:bg-app-hover">
                <ChevronLeft size={15} />
              </button>
              <input
                type="date"
                value={dateKey}
                onChange={(event) => setDateKey(event.target.value || formatLocalDateKey())}
                className="bg-transparent px-1 text-xs text-tx-primary outline-none"
              />
              <button type="button" onClick={() => setDateKey((value) => moveDate(value, 1))} className="rounded p-1 text-tx-secondary hover:bg-app-hover">
                <ChevronRight size={15} />
              </button>
              <button type="button" onClick={() => setDateKey(formatLocalDateKey())} className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent-primary hover:bg-accent-primary/10">
                <RotateCcw size={11} /> {labels.today}
              </button>
            </div>
            <button type="button" onClick={() => void load()} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary">
              <RotateCcw size={11} /> {labels.refresh}
            </button>
          </div>

          {loading ? (
            <div className="flex h-24 items-center justify-center text-tx-tertiary">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[minmax(280px,380px)_1fr]">
              <div className="rounded-xl border border-app-border bg-app-bg p-3">
                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium text-tx-tertiary">{labels.task}</span>
                    <select
                      value={selectedTaskId}
                      onChange={(event) => chooseTask(event.target.value)}
                      className="w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-tx-primary outline-none focus:border-accent-primary"
                    >
                      <option value="">{availableTasks.length ? labels.chooseTask : labels.noTasks}</option>
                      {availableTasks.map((task) => (
                        <option key={task.id} value={task.id}>
                          {task.priority === 3 ? "● " : task.priority === 2 ? "• " : ""}{task.title}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-medium text-tx-tertiary">{labels.estimate}</span>
                      {selectedTask?.estimatedMinutes ? (
                        <button type="button" onClick={() => void setEstimate(null)} className="flex items-center gap-1 text-[10px] text-tx-tertiary hover:text-accent-danger">
                          <X size={10} /> {labels.clearEstimate}
                        </button>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {ESTIMATE_PRESETS.map((minutes) => (
                        <button
                          key={minutes}
                          type="button"
                          disabled={!selectedTaskId}
                          onClick={() => void setEstimate(minutes)}
                          className={cn(
                            "rounded-full border px-2 py-1 text-[11px] transition-colors disabled:opacity-40",
                            selectedTask?.estimatedMinutes === minutes
                              ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
                              : "border-app-border text-tx-secondary hover:border-accent-primary/40",
                          )}
                        >
                          {formatMinutes(minutes, chinese)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label>
                      <span className="mb-1 block text-[11px] font-medium text-tx-tertiary">{labels.start}</span>
                      <input
                        type="time"
                        value={startTime}
                        onChange={(event) => setStartTime(event.target.value)}
                        className="w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-tx-primary outline-none focus:border-accent-primary"
                      />
                    </label>
                    <label>
                      <span className="mb-1 block text-[11px] font-medium text-tx-tertiary">{labels.duration}</span>
                      <select
                        value={durationMinutes}
                        onChange={(event) => setDurationMinutes(Number(event.target.value))}
                        className="w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-tx-primary outline-none focus:border-accent-primary"
                      >
                        {[15, 30, 45, 60, 90, 120, 180, 240].map((minutes) => (
                          <option key={minutes} value={minutes}>{formatMinutes(minutes, chinese)}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <button
                    type="button"
                    onClick={() => void addBlock()}
                    disabled={!selectedTaskId || saving}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-primary px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                    {labels.add}
                  </button>
                </div>
              </div>

              <div className="min-w-0 rounded-xl border border-app-border bg-app-bg">
                <div className="border-b border-app-border px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-tx-primary">{labels.scheduled}</h3>
                      <p className="text-[10px] text-tx-tertiary">
                        {formatMinutes(totalMinutes, chinese)} · {blocks.length} {chinese ? "个时间块" : "blocks"}
                        {occupied !== totalMinutes ? ` · ${chinese ? "实际占用" : "occupied"} ${formatMinutes(occupied, chinese)}` : ""}
                      </p>
                    </div>
                    <div className="w-32">
                      <div className="mb-1 flex justify-between text-[9px] text-tx-tertiary">
                        <span>0h</span><span>8h</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-app-border">
                        <div
                          className={cn("h-full rounded-full", totalMinutes > DAY_CAPACITY_MINUTES ? "bg-red-500" : "bg-accent-primary")}
                          style={{ width: `${capacityPercent}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  {totalMinutes > DAY_CAPACITY_MINUTES && (
                    <p className="mt-2 flex items-center gap-1 text-[10px] text-red-500"><AlertTriangle size={11} />{labels.overCapacity}</p>
                  )}
                  {conflictIds.size > 0 && (
                    <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400"><AlertTriangle size={11} />{labels.conflictHint}</p>
                  )}
                </div>

                <div className="max-h-[320px] space-y-2 overflow-y-auto p-3">
                  {blocks.length === 0 ? (
                    <div className="flex h-28 flex-col items-center justify-center gap-2 text-tx-tertiary">
                      <Clock3 size={20} />
                      <span className="text-xs">{labels.noBlocks}</span>
                    </div>
                  ) : blocks.map((block) => {
                    const duration = minutesBetween(block.startAt, block.endAt);
                    const isEditing = editingId === block.id;
                    const conflicted = conflictIds.has(block.id);
                    return (
                      <div
                        key={block.id}
                        className={cn(
                          "rounded-lg border bg-app-surface p-3",
                          conflicted ? "border-amber-400/60" : "border-app-border",
                          block.isCompleted ? "opacity-60" : "",
                        )}
                      >
                        {isEditing ? (
                          <div className="grid gap-2 sm:grid-cols-[110px_130px_1fr] sm:items-end">
                            <label>
                              <span className="mb-1 block text-[10px] text-tx-tertiary">{labels.start}</span>
                              <input type="time" value={editStartTime} onChange={(event) => setEditStartTime(event.target.value)} className="w-full rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-xs text-tx-primary outline-none" />
                            </label>
                            <label>
                              <span className="mb-1 block text-[10px] text-tx-tertiary">{labels.duration}</span>
                              <select value={editDurationMinutes} onChange={(event) => setEditDurationMinutes(Number(event.target.value))} className="w-full rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-xs text-tx-primary outline-none">
                                {[15, 30, 45, 60, 90, 120, 180, 240].map((minutes) => <option key={minutes} value={minutes}>{formatMinutes(minutes, chinese)}</option>)}
                              </select>
                            </label>
                            <div className="flex justify-end gap-1">
                              <button type="button" onClick={() => setEditingId(null)} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-tx-secondary hover:bg-app-hover"><X size={12} />{labels.cancel}</button>
                              <button type="button" onClick={() => void saveEdit(block)} className="flex items-center gap-1 rounded-md bg-accent-primary px-2 py-1.5 text-[11px] text-white"><Save size={12} />{labels.save}</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-3">
                            <div className="w-[92px] shrink-0">
                              <div className="text-sm font-semibold text-tx-primary">{timeText(block.startAt)}</div>
                              <div className="text-[10px] text-tx-tertiary">{timeText(block.endAt)} · {formatMinutes(duration, chinese)}</div>
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className={cn("truncate text-sm text-tx-primary", block.isCompleted ? "line-through" : "")}>{block.taskTitle}</div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-tx-tertiary">
                                {block.estimatedMinutes ? <span>{labels.estimate} {formatMinutes(block.estimatedMinutes, chinese)}</span> : null}
                                {block.isCompleted ? <span>{labels.completed}</span> : null}
                                {conflicted ? <span className="text-amber-600 dark:text-amber-400">{labels.conflicts}</span> : null}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button type="button" onClick={() => beginEdit(block)} title={labels.edit} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-accent-primary"><Pencil size={13} /></button>
                              <button type="button" onClick={() => void removeBlock(block.id)} title={labels.delete} className="rounded-md p-1.5 text-tx-tertiary hover:bg-red-500/10 hover:text-red-500"><Trash2 size={13} /></button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}