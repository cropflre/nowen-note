import React, { useState, useMemo, useCallback, useRef } from "react";
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays,
  format, isSameMonth, isSameDay, isToday, addMonths, subMonths,
} from "date-fns";
import { zhCN, enUS } from "date-fns/locale";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Task } from "@/types";
import { isTaskDateOverdue } from "./DateBadge";
import { getTaskDateKey, moveTaskToDate } from "./taskDateUtils";
import { TitleView } from "./taskTitleTokens";

// Re-export for backward compat
export { getTaskDateKey, moveTaskToDate } from "./taskDateUtils";

/** Unified overdue check: supports dueAt-only tasks */
function isCalendarTaskOverdue(task: Task): boolean {
  const dateKey = getTaskDateKey(task);
  return !task.isCompleted && !!dateKey && isTaskDateOverdue(dateKey, task.dueAt);
}

/** Group tasks by date key (YYYY-MM-DD) */
function groupTasksByDate(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = getTaskDateKey(task);
    if (!key) continue;
    const arr = map.get(key) || [];
    arr.push(task);
    map.set(key, arr);
  }
  return map;
}

export function TaskCalendarView({
  tasks,
  onSelect,
  onMoveTaskDate,
}: {
  tasks: Task[];
  onSelect: (task: Task) => void;
  onMoveTaskDate?: (taskId: string, targetDateKey: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === "zh-CN" ? zhCN : enUS;
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const dragTaskRef = useRef<string | null>(null);
  const isMobile = typeof navigator !== "undefined" && /Mobi|Android/i.test(navigator.userAgent);

  const taskMap = useMemo(() => groupTasksByDate(tasks), [tasks]);

  // Build calendar grid (6 weeks x 7 days)
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

    const days: Date[] = [];
    let day = calStart;
    while (day <= calEnd) {
      days.push(day);
      day = addDays(day, 1);
    }
    return days;
  }, [currentMonth]);

  const weekDayLabels = useMemo(() => {
    const labels: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(startOfWeek(new Date(), { weekStartsOn: 1 }), i);
      labels.push(format(d, "EEE", { locale: dateLocale }));
    }
    return labels;
  }, [dateLocale]);

  const selectedDateTasks = useMemo(() => {
    if (!selectedDate) return [];
    const key = format(selectedDate, "yyyy-MM-dd");
    return taskMap.get(key) || [];
  }, [selectedDate, taskMap]);

  const goToToday = useCallback(() => {
    setCurrentMonth(new Date());
    setSelectedDate(new Date());
  }, []);

  const MAX_VISIBLE = 2;

  // --- Drag handlers (desktop only) ---
  const handleDragStart = useCallback((e: React.DragEvent, taskId: string) => {
    dragTaskRef.current = taskId;
    setDraggingTaskId(taskId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", taskId);
  }, []);

  const handleDragEnd = useCallback(() => {
    dragTaskRef.current = null;
    setDraggingTaskId(null);
    setDragOverDate(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, dateKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverDate(dateKey);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverDate(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetDateKey: string) => {
    e.preventDefault();
    setDragOverDate(null);
    setDraggingTaskId(null);
    const taskId = e.dataTransfer.getData("text/plain") || dragTaskRef.current;
    if (!taskId || !onMoveTaskDate) return;
    onMoveTaskDate(taskId, targetDateKey);
  }, [onMoveTaskDate]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header: month nav */}
      <div className="flex items-center justify-between px-4 md:px-6 py-3 border-b border-app-border shrink-0">
        <div className="flex items-center gap-2">
          <button onClick={() => setCurrentMonth((m) => subMonths(m, 1))} className="p-1 rounded hover:bg-app-hover text-tx-secondary transition-colors">
            <ChevronLeft size={18} />
          </button>
          <h2 className="text-sm font-semibold text-tx-primary min-w-[120px] text-center">
            {(i18n.language === "zh-CN" ? format(currentMonth, "yyyy\u5E74M\u6708") : format(currentMonth, "MMMM yyyy", { locale: dateLocale }))}
          </h2>
          <button onClick={() => setCurrentMonth((m) => addMonths(m, 1))} className="p-1 rounded hover:bg-app-hover text-tx-secondary transition-colors">
            <ChevronRight size={18} />
          </button>
        </div>
        <button onClick={goToToday} className="text-xs px-2.5 py-1 rounded-md border border-app-border text-tx-secondary hover:bg-app-hover transition-colors">
          {t("tasks.today")}
        </button>
      </div>

      {/* Calendar grid + selected date panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Grid */}
        <div className="flex-1 flex flex-col min-w-0 overflow-auto">
          {/* Weekday labels */}
          <div className="grid grid-cols-7 border-b border-app-border shrink-0">
            {weekDayLabels.map((label, i) => (
              <div key={i} className="text-center text-[10px] md:text-xs text-tx-tertiary font-medium py-2">
                {label}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 flex-1">
            {calendarDays.map((day, idx) => {
              const dateKey = format(day, "yyyy-MM-dd");
              const dayTasks = taskMap.get(dateKey) || [];
              const inMonth = isSameMonth(day, currentMonth);
              const today = isToday(day);
              const selected = selectedDate ? isSameDay(day, selectedDate) : false;
              const visibleTasks = dayTasks.slice(0, MAX_VISIBLE);
              const overflow = dayTasks.length - MAX_VISIBLE;
              const isDragTarget = dragOverDate === dateKey;

              return (
                <div
                  key={idx}
                  onClick={() => setSelectedDate(day)}
                  onDragOver={isMobile ? undefined : (e) => handleDragOver(e, dateKey)}
                  onDragLeave={isMobile ? undefined : handleDragLeave}
                  onDrop={isMobile ? undefined : (e) => handleDrop(e, dateKey)}
                  className={cn(
                    "flex flex-col border-b border-r border-app-border/50 p-1 md:p-1.5 min-h-[60px] md:min-h-[80px] cursor-pointer transition-colors",
                    !inMonth && "opacity-30",
                    today && "bg-accent-primary/5",
                    selected && "bg-accent-primary/10 ring-1 ring-inset ring-accent-primary/30",
                    !selected && !isDragTarget && "hover:bg-app-hover/50",
                    isDragTarget && "bg-accent-primary/15 ring-2 ring-inset ring-accent-primary/40"
                  )}
                >
                  <span className={cn(
                    "text-[10px] md:text-xs font-medium mb-0.5",
                    today ? "text-accent-primary font-bold" : "text-tx-secondary"
                  )}>
                    {format(day, "d")}
                  </span>

                  {/* Task dots / mini cards */}
                  <div className="flex-1 space-y-0.5 overflow-hidden">
                    {visibleTasks.map((task) => {
                      const overdue = isCalendarTaskOverdue(task);
                      return (
                        <div
                          key={task.id}
                          onClick={(e) => { e.stopPropagation(); onSelect(task); }}
                          draggable={!isMobile}
                          onDragStart={isMobile ? undefined : (e) => handleDragStart(e, task.id)}
                          onDragEnd={isMobile ? undefined : handleDragEnd}
                          className={cn(
                            "text-[9px] md:text-[10px] leading-tight px-1 py-0.5 rounded truncate cursor-pointer transition-colors",
                            draggingTaskId === task.id && "opacity-40",
                            task.isCompleted
                              ? "line-through text-tx-tertiary bg-app-elevated/50"
                              : overdue
                                ? "text-red-600 bg-red-500/10 dark:text-red-400 dark:bg-red-500/10"
                                : "text-tx-primary bg-app-elevated hover:bg-accent-primary/10"
                          )}
                          title={task.title}
                        >
                          {task.title.length > 12 ? task.title.slice(0, 12) + "\u2026" : task.title}
                        </div>
                      );
                    })}
                    {overflow > 0 && (
                      <span className="text-[9px] text-tx-tertiary px-1">+{overflow}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Selected date panel (desktop right side) */}
        {selectedDate && (
          <div className="hidden md:flex w-[260px] shrink-0 flex-col border-l border-app-border bg-app-surface overflow-y-auto">
            <div className="px-4 py-3 border-b border-app-border">
              <span className="text-sm font-semibold text-tx-primary">
                {(i18n.language === "zh-CN" ? format(selectedDate, "M\u6708d\u65E5 EEEE") : format(selectedDate, "EEEE, MMM d", { locale: dateLocale }))}
              </span>
              <span className="ml-2 text-xs text-tx-tertiary">{selectedDateTasks.length}{t("tasks.title")}</span>
            </div>
            <div className="flex-1 p-3 space-y-1.5">
              {selectedDateTasks.length === 0 ? (
                <div className="text-center text-xs text-tx-tertiary py-8">{t("tasks.calendarEmpty") || "\u8FD9\u5929\u6CA1\u6709\u4EFB\u52A1"}</div>
              ) : selectedDateTasks.map((task) => {
                const overdue = isCalendarTaskOverdue(task);
                return (
                  <div
                    key={task.id}
                    onClick={() => onSelect(task)}
                    draggable={!isMobile}
                    onDragStart={isMobile ? undefined : (e) => handleDragStart(e, task.id)}
                    onDragEnd={isMobile ? undefined : handleDragEnd}
                    className={cn(
                      "px-3 py-2 rounded-lg border cursor-pointer transition-all hover:shadow-sm",
                      draggingTaskId === task.id && "opacity-40",
                      task.isCompleted
                        ? "border-app-border/50 bg-app-elevated/30 opacity-60"
                        : overdue
                          ? "border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/30"
                          : "border-app-border bg-app-elevated hover:border-accent-primary/30"
                    )}
                  >
                    <span className={cn(
                      "text-xs leading-relaxed break-words [overflow-wrap:anywhere]",
                      task.isCompleted ? "line-through text-tx-tertiary" : "text-tx-primary"
                    )}>
                      <TitleView title={task.title} compact isCompleted={task.isCompleted === 1} />
                    </span>
                    {task.dueAt && (
                      <span className="block text-[10px] text-tx-tertiary mt-0.5">
                        {task.dueAt.split("T")[1]?.slice(0, 5) || ""}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Mobile: selected date task list at bottom */}
      {selectedDate && (
        <div className="md:hidden border-t border-app-border bg-app-surface overflow-y-auto max-h-[30vh]">
          <div className="px-4 py-2 border-b border-app-border/50">
            <span className="text-xs font-semibold text-tx-primary">
              {(i18n.language === "zh-CN" ? format(selectedDate, "M/d EEE") : format(selectedDate, "EEE, MMM d", { locale: dateLocale }))}
            </span>
            <span className="ml-1 text-[10px] text-tx-tertiary">{selectedDateTasks.length}</span>
          </div>
          <div className="p-2 space-y-1">
            {selectedDateTasks.length === 0 ? (
              <div className="text-center text-xs text-tx-tertiary py-4">{t("tasks.calendarEmpty") || "\u8FD9\u5929\u6CA1\u6709\u4EFB\u52A1"}</div>
            ) : selectedDateTasks.map((task) => {
              const overdue = isCalendarTaskOverdue(task);
              return (
                <div
                  key={task.id}
                  onClick={() => onSelect(task)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer",
                    task.isCompleted ? "opacity-50" : "",
                    overdue ? "bg-red-50/50 dark:bg-red-950/20" : "bg-app-elevated"
                  )}
                >
                  <span className={cn(
                    "text-xs flex-1 truncate",
                    task.isCompleted ? "line-through text-tx-tertiary" : "text-tx-primary"
                  )}>
                    {task.title}
                  </span>
                  {task.dueAt && (
                    <span className="text-[10px] text-tx-tertiary">{task.dueAt.split("T")[1]?.slice(0, 5)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
