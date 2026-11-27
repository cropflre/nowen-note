import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2, Circle, Flag, ChevronRight, ChevronDown,
  MoreHorizontal, Trash2, User as UserIcon, Plus, Repeat, Link2, Bell,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { getCurrentWorkspace } from "@/lib/api";
import { MOTION_SPRING } from "@/lib/motion";
import type { Task } from "@/types";
import { isRepeatingTask } from "./taskRepeatUtils";
import type { TaskTreeNode } from "./taskProgress";
import { calculateTaskProgress } from "./taskProgress";
import { TitleView } from "./taskTitleTokens";
import { DateBadge } from "./DateBadge";
import { SubtaskInput, type SubtaskSchedule } from "./SubtaskInput";
import { hasEnabledReminder } from "./taskReminderUtils";

/* ===== Tree task row ===== */
export const TaskTreeRow = React.forwardRef<HTMLDivElement, {
  task: TaskTreeNode;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  onToggle: (id: string) => void;
  onSelect: (task: Task) => void;
  onDelete: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onCreateChild: (title: string, parentId: string, schedule?: SubtaskSchedule) => Promise<void>;
  blockedByDependency?: boolean;
}>(({
  task,
  depth,
  isExpanded,
  hasChildren,
  onToggle,
  onSelect,
  onDelete,
  onToggleExpand,
  onCreateChild,
  blockedByDependency,
}, ref) => {
  const { t } = useTranslation();
  const isCompleted = task.isCompleted === 1;
  const [showSubtaskInput, setShowSubtaskInput] = useState(false);

  const PRIORITY_CONFIG: Record<number, { label: string; color: string; flagClass: string; accentBar: string; circleClass: string }> = {
    3: {
      label: t("tasks.high"),
      color: "text-rose-500",
      flagClass: "text-rose-500",
      accentBar: "bg-rose-400/80 dark:bg-rose-400/75",
      circleClass: "text-rose-400/80 group-hover:text-rose-500",
    },
    2: {
      label: t("tasks.medium"),
      color: "text-amber-500",
      flagClass: "text-amber-500",
      accentBar: "bg-sky-400/65 dark:bg-sky-400/60",
      circleClass: "text-tx-tertiary group-hover:text-sky-500",
    },
    1: {
      label: t("tasks.low"),
      color: "text-sky-400",
      flagClass: "text-sky-400",
      accentBar: "bg-emerald-400/60 dark:bg-emerald-400/55",
      circleClass: "text-tx-tertiary group-hover:text-emerald-500",
    },
  };
  const pri = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG[2];
  const descriptionPreview = (task.description ?? "").trim();

  const showCreator =
    !!task.creatorName && getCurrentWorkspace() !== "personal";
  const showAssignee =
    !!task.assigneeName && getCurrentWorkspace() !== "personal";

  const progressInfo = hasChildren ? calculateTaskProgress(task) : null;
  const indentPx = Math.min(depth, 6) * 24;
  const hasDesktopExtraContent = Boolean(descriptionPreview) || showCreator;
  const hasMobileExtraContent = hasDesktopExtraContent || Boolean(task.dueDate);

  return (
    <>
      <motion.div
        ref={ref}
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
        style={{ paddingLeft: `${indentPx + 8}px` }}
        className={cn(
          "group relative flex w-full min-w-0 cursor-pointer gap-2 overflow-hidden rounded-2xl border py-2.5 pr-3.5 transition-all duration-200",
          hasMobileExtraContent ? "items-start" : "items-center",
          hasDesktopExtraContent ? "md:items-start" : "md:items-center",
          isCompleted
            ? "border-app-border/45 bg-app-hover/45 opacity-65 hover:opacity-85"
            : "border-app-border/80 bg-app-elevated/90 shadow-xs hover:-translate-y-0.5 hover:border-accent-primary/35 hover:bg-app-surface hover:shadow-md",
        )}
        onClick={() => onSelect(task)}
      >
        {/* 左侧柔彩状态微条 */}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute bottom-2 left-0 top-2 w-1 rounded-r-full transition-opacity duration-200",
            isCompleted
              ? "bg-emerald-400/60 opacity-60"
              : cn(pri.accentBar, task.priority === 3 ? "opacity-90" : "opacity-0 group-hover:opacity-100"),
          )}
        />

        {/* Expand/collapse arrow */}
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleExpand(task.id); }}
            className={cn(
              "inline-flex flex-shrink-0 items-center justify-center rounded-lg p-0.5 transition-colors hover:bg-app-hover",
              hasMobileExtraContent ? "mt-0.5" : "mt-0",
              hasDesktopExtraContent ? "md:mt-0.5" : "md:mt-0",
            )}
            title={isExpanded ? t("tasks.collapse") : t("tasks.expand")}
          >
            {isExpanded
              ? <ChevronDown size={15} className="text-tx-tertiary" />
              : <ChevronRight size={15} className="text-tx-tertiary" />}
          </button>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}

        {/* Checkbox */}
        <motion.button
          type="button"
          whileHover={{ scale: 1.15 }}
          whileTap={{ scale: 0.85 }}
          disabled={!!task.archivedAt}
          onClick={(e) => { e.stopPropagation(); onToggle(task.id); }}
          className={cn(
            "inline-flex flex-shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
            hasMobileExtraContent ? "mt-0.5" : "mt-0",
            hasDesktopExtraContent ? "md:mt-0.5" : "md:mt-0",
          )}
        >
          {isCompleted ? (
            <motion.span
              initial={{ scale: 0.65, rotate: -18 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={MOTION_SPRING.bouncy}
              className="inline-flex"
            >
              <CheckCircle2 className="h-5 w-5 text-emerald-500 dark:text-emerald-400" />
            </motion.span>
          ) : (
            <Circle className={cn("h-5 w-5 transition-colors", pri.circleClass)} />
          )}
        </motion.button>

        {/* Title + metadata */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "line-clamp-2 break-words [overflow-wrap:anywhere] text-[13px] font-medium leading-relaxed transition-all md:text-sm",
              isCompleted ? "text-tx-tertiary line-through font-normal" : "text-tx-primary",
            )}
            title={task.title}
          >
            <TitleView title={task.title} compact isCompleted={isCompleted} />
          </span>
          {descriptionPreview && (
            <p className="line-clamp-1 break-words [overflow-wrap:anywhere] text-xs leading-snug text-tx-tertiary">
              {descriptionPreview}
            </p>
          )}
          {(task.dueDate || showCreator) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 md:hidden">
              <DateBadge dateStr={task.dueDate} dueAt={task.dueAt} isCompleted={isCompleted} />
              {showAssignee && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-500/12 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-300"
                  title={`负责人：${task.assigneeName}`}
                >
                  @{task.assigneeName}
                </span>
              )}
              {showCreator && (
                <span
                  className="flex min-w-0 items-center gap-1 text-[10px] text-tx-tertiary"
                  title={t("common.createdBy", { name: task.creatorName })}
                >
                  <UserIcon size={10} className="shrink-0" />
                  <span className="truncate">{task.creatorName}</span>
                </span>
              )}
            </div>
          )}
          {showCreator && (
            <span
              className="hidden items-center gap-1 truncate text-[10px] text-tx-tertiary md:flex"
              title={t("common.createdBy", { name: task.creatorName })}
            >
              <UserIcon size={10} className="shrink-0" />
              <span className="truncate">{task.creatorName}</span>
            </span>
          )}
        </div>

        {/* Right side badges */}
        <div
          className={cn(
            "flex flex-shrink-0 items-center gap-1.5",
            hasMobileExtraContent ? "mt-0.5" : "mt-0",
            hasDesktopExtraContent ? "md:mt-0.5" : "md:mt-0",
          )}
        >
          {/* Action buttons (visible on hover) */}
          <button
            disabled={!!task.archivedAt}
            onClick={(e) => {
              e.stopPropagation();
              setShowSubtaskInput(true);
              if (!isExpanded && hasChildren) onToggleExpand(task.id);
            }}
            className="flex-shrink-0 rounded-lg p-1 text-tx-tertiary opacity-100 transition-all hover:bg-app-hover hover:text-accent-primary md:opacity-0 md:group-hover:opacity-100"
            title={t("tasks.addChild")}
          >
            <Plus size={14} />
          </button>
          {progressInfo && (
            <div className="hidden items-center gap-1.5 sm:flex" title={`${progressInfo.completedChildren}/${progressInfo.totalChildren}`}>
              <span className="whitespace-nowrap text-[10px] font-medium tabular-nums text-tx-tertiary">
                {progressInfo.completedChildren}/{progressInfo.totalChildren}
              </span>
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-app-border/80">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500 transition-all duration-300"
                  style={{ width: `${progressInfo.progress}%` }}
                />
              </div>
            </div>
          )}
          <span className="hidden md:inline-flex">
            <DateBadge dateStr={task.dueDate} dueAt={task.dueAt} isCompleted={isCompleted} />
          </span>
          {hasEnabledReminder(task) && (
            <span title={t("tasks.reminder.title")} className="inline-flex rounded-full bg-amber-500/12 p-1 text-amber-600 dark:text-amber-300">
              <Bell size={11} />
            </span>
          )}
          {isRepeatingTask(task) && (
            <span title={t(`tasks.repeat.${task.repeatRule}`)} className="inline-flex rounded-full bg-violet-500/12 p-1 text-violet-600 dark:text-violet-300">
              <Repeat size={11} />
            </span>
          )}
          {blockedByDependency && !task.isCompleted && (
            <span title={t("tasks.dependencies.blockedByIncomplete")} className="inline-flex rounded-full bg-amber-500/12 p-1 text-amber-500">
              <Link2 size={11} />
            </span>
          )}
          <Flag
            size={14}
            className={cn(
              pri.flagClass,
              task.priority < 3 && "md:opacity-0 md:group-hover:opacity-100",
              "transition-opacity",
            )}
          />
          <button
            type="button"
            data-task-menu-trigger
            aria-label={t("tasks.contextMenu.actions")}
            title={t("tasks.contextMenu.actions")}
            className="rounded-lg p-1 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary focus:opacity-100 md:opacity-0 md:group-hover:opacity-100"
          >
            <MoreHorizontal size={14} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
            className="hidden rounded-lg p-1 text-tx-tertiary transition-all hover:bg-rose-500/10 hover:text-rose-500 md:inline-flex md:opacity-0 md:group-hover:opacity-100"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </motion.div>

      {/* Inline subtask input */}
      <AnimatePresence>
        {showSubtaskInput && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            style={{ paddingLeft: `${indentPx}px` }}
          >
            <SubtaskInput
              parentId={task.id}
              onSubmit={onCreateChild}
              onCancel={() => setShowSubtaskInput(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
});

TaskTreeRow.displayName = "TaskTreeRow";
