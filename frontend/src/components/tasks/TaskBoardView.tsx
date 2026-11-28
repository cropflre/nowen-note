import React, { useMemo, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Circle, CheckCircle2, AlertTriangle, Ban, Flag, Calendar,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Task, TaskStatus } from "@/types";
import { TitleView } from "./taskTitleTokens";
import { DateBadge, isTaskDateOverdue } from "./DateBadge";
import { calculateTaskProgress } from "./taskProgress";
import { buildTaskTree, type TaskTreeNode } from "./taskProgress";
import { TaskEmptyState } from "./TaskEmptyState";

const COLUMNS: { key: TaskStatus; icon: React.ReactElement<{ size: number }>; color: string }[] = [
  { key: "todo", icon: <Circle size={16} />, color: "text-tx-tertiary" },
  { key: "doing", icon: <AlertTriangle size={16} />, color: "text-amber-500" },
  { key: "blocked", icon: <Ban size={16} />, color: "text-red-500" },
  { key: "done", icon: <CheckCircle2 size={16} />, color: "text-indigo-500" },
];

const PRIORITY_CONFIG: Record<number, { label: string; flagClass: string }> = {
  3: { label: "High", flagClass: "text-red-500" },
  2: { label: "Medium", flagClass: "text-amber-500" },
  1: { label: "Low", flagClass: "text-blue-400" },
};

export function TaskBoardView({
  tasks,
  onSelect,
  onStatusChange,
}: {
  tasks: Task[];
  onSelect: (task: Task) => void;
  onStatusChange: (id: string, status: TaskStatus) => void;
}) {
  // Drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const isMobile = typeof navigator !== "undefined" && /Mobi|Android/i.test(navigator.userAgent);
  const [dragOverCol, setDragOverCol] = useState<TaskStatus | null>(null);

  const handleDragStart = useCallback((id: string, e: React.DragEvent) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((status: TaskStatus, e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (status !== dragOverCol) setDragOverCol(status);
  }, [dragOverCol]);

  const handleDrop = useCallback((status: TaskStatus) => {
    if (dragId) {
      const draggedTask = tasks.find((t) => t.id === dragId);
      const currentStatus = draggedTask?.status || (draggedTask?.isCompleted ? "done" : "todo");
      if (currentStatus !== status) {
        onStatusChange(dragId, status);
      }
    }
    setDragId(null);
    setDragOverCol(null);
  }, [dragId, onStatusChange, tasks]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverCol(null);
  }, []);
  const { t } = useTranslation();

  // Build a map for quick child count lookup
  const childCountMap = useMemo(() => {
    const map = new Map<string, { total: number; completed: number }>();
    for (const task of tasks) {
      if (task.parentId) {
        const existing = map.get(task.parentId) || { total: 0, completed: 0 };
        existing.total++;
        if (task.isCompleted) existing.completed++;
        map.set(task.parentId, existing);
      }
    }
    return map;
  }, [tasks]);

  const grouped = useMemo(() => {
    const groups: Record<TaskStatus, Task[]> = {
      todo: [], doing: [], blocked: [], done: [],
    };
    for (const task of tasks) {
      // Only show root tasks or tasks with status
      const status = task.status || (task.isCompleted ? "done" : "todo");
      if (groups[status]) {
        groups[status].push(task);
      } else {
        groups.todo.push(task);
      }
    }
    return groups;
  }, [tasks]);

  const STATUS_LABELS: Record<TaskStatus, string> = {
    todo: t("tasks.statusTodo"),
    doing: t("tasks.statusDoing"),
    blocked: t("tasks.statusBlocked"),
    done: t("tasks.statusDone"),
  };

  return (
    <div className="flex gap-3.5 overflow-x-auto overflow-y-hidden px-4 md:px-6 py-4 h-full bg-gradient-to-br from-transparent via-transparent to-indigo-500/[0.025] dark:to-indigo-500/[0.05]">
      {COLUMNS.map((col) => {
        const columnTasks = grouped[col.key];
        const toneRing = col.key === "doing"
          ? "bg-amber-500/12 text-amber-600 ring-amber-500/20 dark:text-amber-300"
          : col.key === "blocked"
            ? "bg-rose-500/12 text-rose-600 ring-rose-500/20 dark:text-rose-300"
            : col.key === "done"
              ? "bg-indigo-500/12 text-indigo-600 ring-indigo-500/20 dark:text-indigo-300"
              : "bg-app-hover/90 text-tx-secondary ring-app-border/70";
        return (
          <div
            key={col.key}
            className={cn(
              "flex flex-col min-w-[262px] w-[262px] shrink-0 rounded-2xl border backdrop-blur-md transition-all duration-200 shadow-[0_8px_24px_-18px_rgba(15,23,42,0.14)] dark:shadow-[0_12px_28px_-18px_rgba(0,0,0,0.55)]",
              dragOverCol === col.key
                ? "border-accent-primary/50 bg-accent-primary/[0.06] ring-2 ring-accent-primary/15"
                : "border-app-border/75 bg-app-surface/65"
            )}
            onDragOver={(e) => handleDragOver(col.key, e)}
            onDrop={() => handleDrop(col.key)}
          >
            {/* Column header */}
            <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-app-border/65">
              <span className={cn("inline-flex h-7 w-7 items-center justify-center rounded-xl ring-1 ring-inset", toneRing)}>
                {React.cloneElement(col.icon, { size: 14 })}
              </span>
              <span className="text-sm font-bold tracking-tight text-tx-primary">
                {STATUS_LABELS[col.key]}
              </span>
              <span className="ml-auto rounded-full bg-app-hover/85 px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-tx-secondary">
                {columnTasks.length}
              </span>
            </div>

            {/* Cards */}
            <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5">
              {columnTasks.map((task) => {
                const pri = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG[2];
                const childInfo = childCountMap.get(task.id);
                const descriptionPreview = (task.description ?? "").trim();
                const overdue = task.isCompleted === 0 && (task.dueDate || task.dueAt) && isTaskDateOverdue(task.dueDate || (task.dueAt ? task.dueAt.split("T")[0] : ""), task.dueAt);
                return (
                  <motion.div
                    key={task.id}
                    data-task-context-id={task.id}
                    tabIndex={0}
                    layout
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    draggable={!isMobile}
                    onDragStart={(e) => handleDragStart(task.id, e as unknown as React.DragEvent)}
                    onDragEnd={handleDragEnd}
                    className={cn(
                      "group p-3.5 rounded-2xl bg-app-surface/92 border cursor-pointer transition-all duration-150 shadow-sm hover:-translate-y-0.5 hover:shadow-md hover:border-accent-primary/40 active:translate-y-0",
                      dragOverCol && dragId === task.id ? "opacity-50" : "",
                      overdue ? "border-rose-400/50 bg-rose-500/[0.03] dark:border-rose-500/35" : "border-app-border/75"
                    )}
                    onClick={() => onSelect(task)}
                  >
                    {/* Priority flag */}
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <span className="text-[13px] font-medium text-tx-primary leading-snug line-clamp-2 break-words [overflow-wrap:anywhere]">
                        <TitleView title={task.title} compact isCompleted={task.isCompleted === 1} />
                      </span>
                      <Flag size={12} className={cn("shrink-0 mt-0.5", pri.flagClass)} />
                    </div>
                    {descriptionPreview && (
                      <p className="mb-2 text-xs text-tx-tertiary leading-snug line-clamp-2 break-words [overflow-wrap:anywhere]">
                        {descriptionPreview}
                      </p>
                    )}

                    {/* Meta row */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {(task.dueDate || task.dueAt) && (
                        <DateBadge dateStr={task.dueDate || (task.dueAt ? task.dueAt.split("T")[0] : null)} dueAt={task.dueAt} isCompleted={task.isCompleted === 1} />
                      )}
                      {task.parentId && (
                        <span className="text-[10px] font-medium text-tx-tertiary px-1.5 py-0.5 rounded-full bg-app-hover">{t("tasks.subtaskShort")}</span>
                      )}
                      {childInfo && childInfo.total > 0 && (
                        <span className="rounded-full bg-app-hover/80 px-1.5 py-0.5 font-mono text-[10px] text-tx-secondary">
                          {childInfo.completed}/{childInfo.total}
                        </span>
                      )}
                    </div>

                    {/* Quick status switch */}
                    <div className="flex items-center gap-1 mt-2.5 pt-2 border-t border-app-border/55">
                      {COLUMNS.filter((c) => c.key !== col.key).map((c) => (
                        <button
                          key={c.key}
                          onClick={(e) => { e.stopPropagation(); onStatusChange(task.id, c.key); }}
                          className="p-1.5 rounded-lg hover:bg-app-hover opacity-45 hover:opacity-100 transition-all active:scale-95"
                          title={STATUS_LABELS[c.key]}
                        >
                          <span className={c.color}>{React.cloneElement(c.icon, { size: 12 })}</span>
                        </button>
                      ))}
                    </div>
                  </motion.div>
                );
              })}

              {columnTasks.length === 0 && (
                <div className="rounded-2xl border border-dashed border-app-border/70 text-center text-xs text-tx-tertiary py-8 opacity-65">
                  {dragOverCol === col.key ? t("tasks.dropHere") : <TaskEmptyState type="no-tasks" compact />}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
