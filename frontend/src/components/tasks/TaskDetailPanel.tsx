import React, { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Flag, Trash2, X, Bell } from "lucide-react";
import { format, parseISO } from "date-fns";
import { zhCN, enUS } from "date-fns/locale";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Task, TaskPriority } from "@/types";
import type { TaskTreeNode } from "./taskProgress";
import { calculateTaskProgress } from "./taskProgress";
import { parseTaskTitle, TitleView } from "./taskTitleTokens";

/* ===== 任务详情面板 ===== */
export const TaskDetailPanel = React.forwardRef<HTMLDivElement, {
  task: Task;
  /** 可选：树形节点（用于计算进度），过滤模式下不传 */
  treeNode?: TaskTreeNode | null;
  onClose: () => void;
  onUpdate: (id: string, data: Partial<Task>) => void;
  onDelete: (id: string) => void;
}>(({ task, treeNode, onClose, onUpdate, onDelete }, ref) => {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === "zh-CN" ? zhCN : enUS;
  const [title, setTitle] = useState(task.title);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate || "");
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const PRIORITY_CONFIG: Record<number, { label: string; color: string; flagClass: string }> = {
    3: { label: t('tasks.high'), color: "text-red-500", flagClass: "text-red-500" },
    2: { label: t('tasks.medium'), color: "text-amber-500", flagClass: "text-amber-500" },
    1: { label: t('tasks.low'), color: "text-blue-400", flagClass: "text-blue-400" },
  };

  useEffect(() => {
    setTitle(task.title);
    setPriority(task.priority);
    setDueDate(task.dueDate || "");
  }, [task.id]);

  const handleSave = () => {
    onUpdate(task.id, { title: title.trim() || task.title, priority, dueDate: dueDate || null });
  };

  const hasRichTokens = parseTaskTitle(task.title).some((tok) => tok.kind !== "text");

  // 进度信息：从 tree node 计算（如有）
  const progressInfo = treeNode ? calculateTaskProgress(treeNode) : null;

  return (
    <motion.div
      ref={ref}
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className={cn(
        "h-full border-l border-app-border bg-app-surface flex flex-col shrink-0",
        // 移动端：全屏覆盖
        "fixed inset-0 z-30 w-full border-l-0",
        // 桌面端：侧边面板
        "md:static md:z-auto md:w-[340px] md:min-w-[340px] md:border-l"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border" style={{ paddingTop: 'calc(var(--safe-area-top) + 4px)' }}>
        <span className="text-sm font-semibold text-tx-primary">{t('tasks.taskDetail')}</span>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover transition-colors">
          <X size={16} className="text-tx-secondary" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4 space-y-5">
        {/* 标题 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t('tasks.taskTitle')}</label>
          <textarea
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleSave}
            rows={Math.min(4, Math.max(2, title.split("\n").length))}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors resize-y font-mono"
          />
          {hasRichTokens && (
            <div className="mt-2 px-3 py-2 rounded-md bg-app-elevated border border-app-border text-sm text-tx-primary leading-relaxed break-all">
              <TitleView title={title} compact={false} isCompleted={task.isCompleted === 1} />
            </div>
          )}
        </div>

        {/* 优先级 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t('tasks.priority')}</label>
          <div className="flex gap-2">
            {([3, 2, 1] as TaskPriority[]).map((p) => {
              const cfg = PRIORITY_CONFIG[p];
              return (
                <button
                  key={p}
                  onClick={() => { setPriority(p); onUpdate(task.id, { priority: p }); }}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border transition-all",
                    priority === p
                      ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
                      : "border-app-border text-tx-secondary hover:bg-app-hover"
                  )}
                >
                  <Flag size={12} className={priority === p ? cfg.flagClass : ""} />
                  {cfg.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 截止日期 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t('tasks.dueDate')}</label>
          <input
            type="date"
            value={dueDate ? dueDate.split("T")[0] : ""}
            onChange={(e) => {
              const val = e.target.value || null;
              setDueDate(val || "");
              onUpdate(task.id, { dueDate: val });
            }}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
          />
        </div>

        {/* 创建时间 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t('tasks.createdAt')}</label>
          <span className="text-sm text-tx-secondary">
            {format(parseISO(task.createdAt + (task.createdAt.endsWith("Z") ? "" : "Z")), "yyyy-MM-dd HH:mm", { locale: dateLocale })}
          </span>
        </div>

        {/* === 进度详情卡片（新增） === */}
        <div className="rounded-lg border border-app-border bg-app-elevated/50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-tx-tertiary uppercase tracking-wider font-medium">
              {t('tasks.progress.title')}
            </span>
          </div>

          {progressInfo ? (
            <>
              {/* 进度百分比 + 进度条 */}
              <div className="flex items-center gap-3">
                <span className="text-2xl font-bold text-accent-primary">
                  {progressInfo.progress}%
                </span>
                <div className="flex-1 h-2 rounded-full bg-app-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent-primary transition-all duration-500"
                    style={{ width: `${progressInfo.progress}%` }}
                  />
                </div>
              </div>
              {/* 子任务统计 */}
              <div className="text-xs text-tx-secondary">
                {t('tasks.progress.childrenStats', {
                  completed: progressInfo.completedChildren,
                  total: progressInfo.totalChildren,
                })}
              </div>
            </>
          ) : (
            <div className="text-sm text-tx-tertiary">
              {task.isCompleted === 1
                ? t('tasks.progress.completed')
                : t('tasks.progress.inProgress')}
            </div>
          )}

          {/* 截止日期（如有） */}
          {task.dueDate && (
            <div className="text-xs text-tx-tertiary">
              {t('tasks.progress.dueLabel')}: {format(parseISO(task.dueDate), "yyyy年M月d日", { locale: dateLocale })}
            </div>
          )}
        </div>

        {/* === 提醒设置占位区（Coming Soon） === */}
        <div className="rounded-lg border border-app-border bg-app-elevated/30 p-4 opacity-60">
          <div className="flex items-center gap-2 mb-2">
            <Bell size={14} className="text-tx-tertiary" />
            <span className="text-xs text-tx-tertiary uppercase tracking-wider font-medium">
              {t('tasks.reminder.title')}
            </span>
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-app-border text-tx-tertiary">
              Coming Soon
            </span>
          </div>
          <p className="text-xs text-tx-tertiary">
            {t('tasks.reminder.comingSoon')}
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-app-border" style={{ paddingBottom: 'calc(var(--safe-area-bottom) + 16px)' }}>
        <button
          onClick={() => { onDelete(task.id); onClose(); }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm text-accent-danger border border-accent-danger/30 hover:bg-accent-danger/10 transition-colors"
        >
          <Trash2 size={14} />
          {t('tasks.deleteTask')}
        </button>
      </div>
    </motion.div>
  );
});

TaskDetailPanel.displayName = "TaskDetailPanel";
