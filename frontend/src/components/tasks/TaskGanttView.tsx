import { useState, useMemo, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskProject, TaskDependency } from "../../types";
import { getTaskStartDate, getTaskEndDate, moveTaskDateRange, isTaskScheduled, buildTimelineDays, getVisibleTaskBar, resizeTaskDateRange } from "./taskGanttUtils";
import { buildTaskRowIndex, getDependencyLinePoints, isTaskBlockedByDependency, getDependencyScheduleWarnings } from "./taskDependencyUtils";
import { format, addDays, startOfWeek, startOfMonth, addWeeks, addMonths, isToday, isBefore } from "date-fns";
import { TaskEmptyState } from "./TaskEmptyState";

interface Props {
  tasks: Task[];
  projects: TaskProject[];
  onSelect: (task: Task) => void;
  onUpdateTaskDateRange: (taskId: string, patch: { startDate?: string | null; dueDate?: string | null }) => void;
  dependencies?: TaskDependency[];
}

export default function TaskGanttView({ tasks, projects, onSelect, onUpdateTaskDateRange, dependencies = [] }: Props) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState<"week" | "month">("week");
  const [cursor, setCursor] = useState(startOfWeek(new Date()));
  const [dragState, setDragState] = useState<{
    taskId: string;
    startX: number;
    startDate: string;
    diffDays: number;
    mode: "move" | "resize-start" | "resize-end";
  } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const scheduledTasks = useMemo(() => tasks.filter(isTaskScheduled), [tasks]);
  const rowIndexMap = useMemo(() => buildTaskRowIndex(scheduledTasks), [scheduledTasks]);
  const unscheduledTasks = useMemo(() => tasks.filter((t) => !isTaskScheduled(t)), [tasks]);

  const days = useMemo(() => {
    const count = zoom === "week" ? 7 : 30;
    return buildTimelineDays(cursor, count);
  }, [cursor, zoom]);

  const handlePrev = useCallback(() => {
    setCursor((prev) => (zoom === "week" ? addWeeks(prev, -1) : addMonths(prev, -1)));
  }, [zoom]);

  const handleNext = useCallback(() => {
    setCursor((prev) => (zoom === "week" ? addWeeks(prev, 1) : addMonths(prev, 1)));
  }, [zoom]);

  const handleToday = useCallback(() => {
    setCursor(startOfWeek(new Date()));
  }, []);

  const handleDragStart = useCallback((taskId: string, e: React.MouseEvent, mode: "move" | "resize-start" | "resize-end" = "move") => {
    if (e.button !== 0) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const startDate = getTaskStartDate(task) || getTaskEndDate(task);
    if (!startDate) return;
    setDragState({ taskId, startX: e.clientX, startDate, diffDays: 0, mode });
    e.preventDefault();
  }, [tasks]);

  const handleDragMove = useCallback((e: React.MouseEvent) => {
    if (!dragState || !gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const dayWidth = rect.width / days.length;
    const diffDays = Math.round((e.clientX - dragState.startX) / dayWidth);
    if (diffDays === dragState.diffDays) return;
    setDragState((prev) => prev ? { ...prev, diffDays } : null);
  }, [dragState, days]);

  const handleDragEnd = useCallback(() => {
    if (!dragState) return;
    const { taskId, startDate, diffDays, mode } = dragState;
    if (diffDays !== 0) {
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        if (mode === "move") {
          const newStart = addDays(new Date(startDate + "T00:00:00"), diffDays);
          const newStartStr = format(newStart, "yyyy-MM-dd");
          const result = moveTaskDateRange(task, newStartStr);
          if (result) onUpdateTaskDateRange(taskId, result);
        } else {
          const targetDate = format(addDays(new Date(startDate + "T00:00:00"), diffDays), "yyyy-MM-dd");
          const side = mode === "resize-start" ? "start" : "end";
          const result = resizeTaskDateRange(task, side, targetDate);
          if (result) onUpdateTaskDateRange(taskId, result);
        }
      }
    }
    setDragState(null);
  }, [dragState, tasks, onUpdateTaskDateRange]);

  const getBar = useCallback((task: Task) => getVisibleTaskBar(task, days), [days]);

  const getProjectColor = useCallback((projectId: string | null) => {
    if (!projectId) return "#6b7280";
    const project = projects.find((p) => p.id === projectId);
    return project?.color || "#6b7280";
  }, [projects]);

  return (
    <div className="flex flex-col h-full bg-app-surface">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-app-border">
        <div className="flex items-center gap-2">
          <button onClick={handlePrev} className="px-2 py-1 text-xs rounded bg-app-bg hover:bg-app-bg/80">{t("tasks.gantt.prev")}</button>
          <button onClick={handleToday} className="px-2 py-1 text-xs rounded bg-app-bg hover:bg-app-bg/80">{t("tasks.gantt.today")}</button>
          <button onClick={handleNext} className="px-2 py-1 text-xs rounded bg-app-bg hover:bg-app-bg/80">{t("tasks.gantt.next")}</button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setZoom("week")} className={`px-2 py-1 text-xs rounded ${zoom === "week" ? "bg-accent-primary text-white" : "bg-app-bg hover:bg-app-bg/80"}`}>{t("tasks.gantt.week")}</button>
          <button onClick={() => setZoom("month")} className={`px-2 py-1 text-xs rounded ${zoom === "month" ? "bg-accent-primary text-white" : "bg-app-bg hover:bg-app-bg/80"}`}>{t("tasks.gantt.month")}</button>
        </div>
      </div>

      {/* Main content */}
      {scheduledTasks.length === 0 && unscheduledTasks.length === 0 ? (
        <TaskEmptyState type="no-scheduled" />
      ) : (
      <>
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: task list */}
        <div className="w-64 border-r border-app-border overflow-y-auto">
          {scheduledTasks.map((task) => (
            <div
              key={task.id}
              data-task-context-id={task.id}
              tabIndex={0}
              className="flex items-center gap-2 px-3 py-2 border-b border-app-border hover:bg-app-bg cursor-pointer"
              style={{ opacity: task.isCompleted ? 0.5 : 1 }}
              onClick={() => onSelect(task)}
            >
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: getProjectColor(task.projectId) }} />
              <span className="text-sm truncate text-tx-primary">{task.title}</span>
              {task.priority === 3 && <span className="text-xs text-red-500">&#x25cf;</span>}
            </div>
          ))}
        </div>

        {/* Right panel: timeline */}
        <div
          ref={gridRef}
          className="flex-1 overflow-x-auto"
          onMouseMove={handleDragMove}
          onMouseUp={handleDragEnd}
          onMouseLeave={handleDragEnd}
        >
          {/* Day headers */}
          <div className="flex border-b border-app-border">
            {days.map((day, i) => (
              <div
                key={i}
                className="flex-shrink-0 text-center py-2 text-xs border-r border-app-border"
                style={{ width: `${100 / days.length}%` }}
              >
                <div className={`text-tx-secondary ${isToday(day) ? "font-bold text-accent-primary" : ""}`}>
                  {format(day, zoom === "week" ? "EEE" : "d")}
                </div>
                <div className="text-tx-tertiary text-[10px]">{format(day, "MMM")}</div>
              </div>
            ))}
          </div>

          {/* Task bars */}
          <div className="relative">
            {scheduledTasks.map((task) => {
              const bar = getBar(task);
              if (!bar) return null;
              const isDragging = dragState?.taskId === task.id;
              const isOverdue = !task.isCompleted && task.dueDate && isBefore(new Date(task.dueDate + "T23:59:59"), new Date());
              const isBlocked = isTaskBlockedByDependency(task.id, dependencies, tasks);
              const scheduleWarning = getDependencyScheduleWarnings(task.id, dependencies, tasks);
              const dragOffset = isDragging && dragState ? (dragState.diffDays / days.length) * 100 : 0;
              const roundedClass = `${bar.clippedStart ? "rounded-l-none" : "rounded-l"} ${bar.clippedEnd ? "rounded-r-none" : "rounded-r"}`;
              return (
                <div key={task.id} data-task-context-id={task.id} tabIndex={0} className="relative h-8 border-b border-app-border">
                  <div
                    className={`absolute top-1 h-6 cursor-grab active:cursor-grabbing ${roundedClass}`}
                    style={{
                      left: `${(bar.left / days.length) * 100 + dragOffset}%`,
                      width: `${(bar.width / days.length) * 100}%`,
                      backgroundColor: isOverdue ? "#ef4444" : getProjectColor(task.projectId),
                      opacity: task.isCompleted ? 0.4 : 0.8,
                    }}
                    onMouseDown={(e) => handleDragStart(task.id, e, "move")}
                    onClick={() => onSelect(task)}
                    title={task.title + (isBlocked ? " (" + t("tasks.dependencies.blocked") + ")" : "") + (scheduleWarning ? " (" + t("tasks.dependencies.suggestReschedule") + ")" : "")}
                  >
                    {isBlocked && !task.isCompleted && (
                      <div className="absolute -top-1 -left-1 w-3.5 h-3.5 rounded-full bg-amber-500 flex items-center justify-center" title={t("tasks.dependencies.blockedByIncomplete")}>
                        <svg viewBox="0 0 12 12" className="w-2 h-2 fill-white"><path d="M8.5 5V3.5a2.5 2.5 0 0 0-5 0V5H2.5A1.5 1.5 0 0 0 1 6.5v4A1.5 1.5 0 0 0 2.5 12h7a1.5 1.5 0 0 0 1.5-1.5v-4A1.5 1.5 0 0 0 9.5 5H8.5zM4 3.5a1.5 1.5 0 1 1 3 0V5H4V3.5z"/></svg>
                      </div>
                    )}
                    {/* Left resize handle */}
                    <div
                      className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize opacity-0 hover:opacity-100 bg-white/30 rounded-l"
                      onMouseDown={(e) => { e.stopPropagation(); handleDragStart(task.id, e, "resize-start"); }}
                    />
                    {/* Right resize handle */}
                    <div
                      className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize opacity-0 hover:opacity-100 bg-white/30 rounded-r"
                      onMouseDown={(e) => { e.stopPropagation(); handleDragStart(task.id, e, "resize-end"); }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Today column indicator */}
          {(() => {
            const todayIdx = days.findIndex((d) => isToday(d));
            if (todayIdx === -1) return null;
            return <div className="absolute top-0 bottom-0 w-px bg-accent-primary/30 pointer-events-none" style={{ left: `${(todayIdx / days.length) * 100}%` }} />;
          })()}

          {/* Dependency lines */}
          {dependencies.length > 0 && (() => {
            const dayW = 100 / days.length;
            const rowH = 32;
            return (
              <svg className="absolute inset-0 pointer-events-none" style={{ width: "100%", height: scheduledTasks.length * rowH }}>
                <defs>
                  <marker id="arrowhead" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
                    <polygon points="0 0, 6 2, 0 4" className="fill-accent-primary/40" />
                  </marker>
                </defs>
                {dependencies.map((dep) => {
                  const predRow = rowIndexMap.get(dep.predecessorTaskId);
                  const succRow = rowIndexMap.get(dep.successorTaskId);
                  if (predRow === undefined || succRow === undefined) return null;
                  const pred = scheduledTasks[predRow];
                  const succ = scheduledTasks[succRow];
                  if (!pred || !succ) return null;
                  const predBar = getBar(pred);
                  const succBar = getBar(succ);
                  if (!predBar || !succBar) return null;
                  const points = getDependencyLinePoints(
                    { left: (predBar.left / days.length) * 100, width: (predBar.width / days.length) * 100, row: predRow },
                    { left: (succBar.left / days.length) * 100, width: (succBar.width / days.length) * 100, row: succRow }
                  );
                  const pathStr = points.map((p) => `${p.x * dayW / 100 * (days.length)},${p.y}`).join(" ");
                  const allCompleted = pred.isCompleted && succ.isCompleted;
                  return (
                    <polyline
                      key={dep.id}
                      points={pathStr}
                      fill="none"
                      className={allCompleted ? "stroke-gray-300/40" : "stroke-accent-primary/40"}
                      strokeWidth="1.5"
                      markerEnd="url(#arrowhead)"
                    />
                  );
                })}
              </svg>
            );
          })()}
        </div>
      </div>


      </>
      )}

      {/* Unscheduled tasks */}
      {unscheduledTasks.length > 0 && (
        <div className="border-t border-app-border p-4">
          <h3 className="text-sm font-medium text-tx-secondary mb-2">{t("tasks.gantt.unscheduled")}</h3>
          <div className="flex flex-wrap gap-2">
            {unscheduledTasks.map((task) => (
              <div key={task.id} data-task-context-id={task.id} tabIndex={0} className="flex items-center gap-1">
                <button onClick={() => onSelect(task)} className="px-2 py-1 text-xs rounded bg-app-bg hover:bg-app-bg/80 text-tx-primary">
                  {task.title}
                </button>
                <button
                  onClick={() => {
                    const today = format(new Date(), "yyyy-MM-dd");
                    onUpdateTaskDateRange(task.id, { startDate: today, dueDate: today });
                  }}
                  className="px-1.5 py-1 text-[10px] rounded bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20"
                  title={t("tasks.gantt.scheduleToday")}
                >
                  {t("tasks.gantt.scheduleToday")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}