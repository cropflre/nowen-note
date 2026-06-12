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

const COLUMNS: { key: TaskStatus; icon: React.ReactNode; color: string }[] = [
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
    <div className="flex gap-3 overflow-x-auto overflow-y-hidden px-4 md:px-6 py-4 h-full">
      {COLUMNS.map((col) => {
        const columnTasks = grouped[col.key];
        return (
          <div
            key={col.key}
            className={cn(
              "flex flex-col min-w-[240px] w-[240px] shrink-0 bg-app-elevated/50 rounded-xl border transition-colors",
              dragOverCol === col.key ? "border-accent-primary/50 bg-accent-primary/5" : "border-app-border"
            )}
            onDragOver={(e) => handleDragOver(col.key, e)}
            onDrop={() => handleDrop(col.key)}
          >
            {/* Column header */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-app-border">
              <span className={col.color}>{col.icon}</span>
              <span className="text-sm font-medium text-tx-primary">
                {STATUS_LABELS[col.key]}
              </span>
              <span className="text-xs text-tx-tertiary ml-auto">
                {columnTasks.length}
              </span>
            </div>

            {/* Cards */}
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {columnTasks.map((task) => {
                const pri = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG[2];
                const childInfo = childCountMap.get(task.id);
                return (
                  <motion.div
                    key={task.id}
                    layout
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    draggable
                    onDragStart={(e) => handleDragStart(task.id, e as unknown as React.DragEvent)}
                    onDragEnd={handleDragEnd}
                    className={cn(
                      "p-3 rounded-lg bg-app-surface border hover:shadow-md hover:border-accent-primary/30 cursor-pointer transition-all",
                      dragOverCol && dragId === task.id ? "opacity-50" : "",
                      (task.isCompleted === 0 && (task.dueDate || task.dueAt) && isTaskDateOverdue(task.dueDate || (task.dueAt ? task.dueAt.split("T")[0] : ""), task.dueAt)) ? "border-red-300 dark:border-red-800" : "border-app-border"
                    )}
                    onClick={() => onSelect(task)}
                  >
                    {/* Priority flag */}
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <span className="text-[13px] text-tx-primary leading-snug line-clamp-2 break-words [overflow-wrap:anywhere]">
                        <TitleView title={task.title} compact isCompleted={task.isCompleted === 1} />
                      </span>
                      <Flag size={12} className={cn("shrink-0 mt-0.5", pri.flagClass)} />
                    </div>

                    {/* Meta row */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {(task.dueDate || task.dueAt) && (
                        <DateBadge dateStr={task.dueDate || (task.dueAt ? task.dueAt.split("T")[0] : null)} dueAt={task.dueAt} />
                      )}
                      {task.parentId && (
                        <span className="text-[10px] text-tx-tertiary px-1 py-0.5 rounded bg-app-hover">sub</span>
                      )}
                      {childInfo && childInfo.total > 0 && (
                        <span className="text-[10px] text-tx-tertiary">
                          {childInfo.completed}/{childInfo.total}
                        </span>
                      )}
                    </div>

                    {/* Quick status switch */}
                    <div className="flex items-center gap-1 mt-2 pt-2 border-t border-app-border/50">
                      {COLUMNS.filter((c) => c.key !== col.key).map((c) => (
                        <button
                          key={c.key}
                          onClick={(e) => { e.stopPropagation(); onStatusChange(task.id, c.key); }}
                          className="p-1 rounded hover:bg-app-hover opacity-40 hover:opacity-100 transition-all"
                          title={STATUS_LABELS[c.key]}
                        >
                          <span className={c.color}>{React.cloneElement(c.icon as React.ReactElement, { size: 11 })}</span>
                        </button>
                      ))}
                    </div>
                  </motion.div>
                );
              })}

              {columnTasks.length === 0 && (
                <div className="text-center text-xs text-tx-tertiary py-8 opacity-50">
                  {dragOverCol === col.key ? t("tasks.dropHere") || "Drop here" : "-"}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
