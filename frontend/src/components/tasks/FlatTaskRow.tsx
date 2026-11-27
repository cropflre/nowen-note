import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2, Circle, Flag, MoreHorizontal, Trash2, User as UserIcon, Plus, Repeat, Link2, Bell,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { getCurrentWorkspace } from "@/lib/api";
import { MOTION_SPRING } from "@/lib/motion";
import type { Task } from "@/types";
import { TitleView } from "./taskTitleTokens";
import { DateBadge } from "./DateBadge";
import { isRepeatingTask } from "./taskRepeatUtils";
import { SubtaskInput, type SubtaskSchedule } from "./SubtaskInput";
import { hasEnabledReminder } from "./taskReminderUtils";

/**
 *  allTasks 中向上遍历 parentId 构建父任务路径).
 * 最多展示maxDepth 层，超出时"..." 省略).
 */
function buildParentPath(taskId: string, allTasks: Task[], maxDepth = 3): Task[] {
  const map = new Map(allTasks.map((t) => [t.id, t]));
  const path: Task[] = [];
  let currentId: string | null = taskId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const task = map.get(currentId);
    if (!task?.parentId) break;
    const parent = map.get(task.parentId);
    if (!parent) break;
    path.unshift(parent);
    if (path.length >= maxDepth) break;
    currentId = parent.parentId;
  }
  return path;
}

/** Flat task row (used in filtered mode) */
export const FlatTaskRow = React.forwardRef<HTMLDivElement, {
  task: Task;
  /** All tasks (for building parent task path / breadcrumb) */
  allTasks?: Task[];
  onToggle: (id: string) => void;
  onSelect: (task: Task) => void;
  onDelete: (id: string) => void;
  onCreateChild?: (title: string, parentId: string, schedule?: SubtaskSchedule) => Promise<void>;
  onSelectTask?: (taskId: string) => void;
  blockedByDependency?: boolean;
}>(({ task, allTasks, onToggle, onSelect, onDelete, onCreateChild, onSelectTask, blockedByDependency }, ref) => {
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

  // Parent task breadcrumb path
  const parentPath = useMemo(() => {
    if (!allTasks || !task.parentId) return [];
    return buildParentPath(task.id, allTasks);
  }, [task.id, task.parentId, allTasks]);

  const hasDesktopExtraContent = parentPath.length > 0 || Boolean(descriptionPreview) || showCreator;
  const hasMobileExtraContent = hasDesktopExtraContent || Boolean(task.dueDate);

  return (
    <>
      <motion.div
        ref={ref}
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
        className={cn(
          "group relative flex w-full min-w-0 cursor-pointer gap-3 overflow-hidden rounded-2xl border px-3.5 py-2.5 transition-all duration-200",
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

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Parent task breadcrumb */}
          {parentPath.length > 0 && (
            <div className="mb-0.5 flex min-w-0 items-center gap-1 text-[10px] text-tx-tertiary">
              {parentPath.map((p, i) => (
                <React.Fragment key={p.id}>
                  {i > 0 && <span className="opacity-50">/</span>}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectTask?.(p.id);
                    }}
                    className="max-w-[80px] truncate transition-colors hover:text-accent-primary hover:underline"
                    title={p.title}
                  >
                    {p.title.length > 12 ? p.title.slice(0, 12) + "…" : p.title}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}

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

        <div
          className={cn(
            "flex flex-shrink-0 items-center gap-1.5",
            hasMobileExtraContent ? "mt-0.5" : "mt-0",
            hasDesktopExtraContent ? "md:mt-0.5" : "md:mt-0",
          )}
        >
          {/* Add subtask button */}
          {onCreateChild && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowSubtaskInput(true); }}
              className="flex-shrink-0 rounded-lg p-1 text-tx-tertiary opacity-100 transition-all hover:bg-app-hover hover:text-accent-primary md:opacity-0 md:group-hover:opacity-100"
              title={t("tasks.addChild")}
            >
              <Plus size={14} />
            </button>
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
          {blockedByDependency && !isCompleted && (
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

      {/* Inline 子任务输入框 */}
      <AnimatePresence>
        {showSubtaskInput && onCreateChild && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
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

FlatTaskRow.displayName = "FlatTaskRow";
