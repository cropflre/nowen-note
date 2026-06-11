import React from "react";
import { motion } from "framer-motion";
import { CheckCircle2, Circle, Flag, Trash2, User as UserIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { getCurrentWorkspace } from "@/lib/api";
import type { Task } from "@/types";
import { TitleView } from "./taskTitleTokens";
import { DateBadge } from "./DateBadge";

/** 平铺模式任务行（保留原有 TaskRow 视觉，用于过滤模式） */
export const FlatTaskRow = React.forwardRef<HTMLDivElement, {
  task: Task;
  onToggle: (id: string) => void;
  onSelect: (task: Task) => void;
  onDelete: (id: string) => void;
}>(({ task, onToggle, onSelect, onDelete }, ref) => {
  const { t } = useTranslation();
  const isCompleted = task.isCompleted === 1;
  const PRIORITY_CONFIG: Record<number, { label: string; color: string; flagClass: string }> = {
    3: { label: t('tasks.high'), color: "text-red-500", flagClass: "text-red-500" },
    2: { label: t('tasks.medium'), color: "text-amber-500", flagClass: "text-amber-500" },
    1: { label: t('tasks.low'), color: "text-blue-400", flagClass: "text-blue-400" },
  };
  const pri = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG[2];
  const showCreator =
    !!task.creatorName && getCurrentWorkspace() !== "personal";

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
      className={cn(
        "group flex items-start gap-3 w-full min-w-0 px-4 py-3 rounded-lg border transition-all cursor-pointer",
        isCompleted
          ? "border-transparent bg-app-hover/50 opacity-60"
          : "border-app-border bg-app-elevated hover:shadow-md hover:border-accent-primary/30"
      )}
      onClick={() => onSelect(task)}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(task.id); }}
        className="flex-shrink-0 mt-0.5 transition-transform hover:scale-110"
      >
        {isCompleted ? (
          <CheckCircle2 className="w-5 h-5 text-indigo-500" />
        ) : (
          <Circle className="w-5 h-5 text-tx-tertiary group-hover:text-indigo-400 transition-colors" />
        )}
      </button>

      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span
          className={cn(
            "text-[13px] md:text-sm leading-relaxed break-words [overflow-wrap:anywhere] line-clamp-2 transition-all",
            isCompleted ? "line-through text-tx-tertiary" : "text-tx-primary"
          )}
          title={task.title}
        >
          <TitleView title={task.title} compact isCompleted={isCompleted} />
        </span>
        {(task.dueDate || showCreator) && (
          <div className="md:hidden flex items-center flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
            <DateBadge dateStr={task.dueDate} />
            {showCreator && (
              <span
                className="flex items-center gap-1 text-[10px] text-tx-tertiary min-w-0"
                title={t('common.createdBy', { name: task.creatorName })}
              >
                <UserIcon size={10} className="shrink-0" />
                <span className="truncate">{task.creatorName}</span>
              </span>
            )}
          </div>
        )}
        {showCreator && (
          <span
            className="hidden md:flex items-center gap-1 text-[10px] text-tx-tertiary truncate"
            title={t('common.createdBy', { name: task.creatorName })}
          >
            <UserIcon size={10} className="shrink-0" />
            <span className="truncate">{task.creatorName}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
        <span className="hidden md:inline-flex">
          <DateBadge dateStr={task.dueDate} />
        </span>
        <Flag size={14} className={pri.flagClass} />
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
          className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-tx-tertiary hover:text-accent-danger transition-all"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </motion.div>
  );
});

FlatTaskRow.displayName = "FlatTaskRow";
