import React from "react";
import { useTranslation } from "react-i18next";
import { format, parseISO } from "date-fns";
import { zhCN, enUS } from "date-fns/locale";
import { BarChart3, CalendarDays, Clock } from "lucide-react";
import type { Task, TaskStats } from "@/types";
import { cn } from "@/lib/utils";
import { isTaskDateOverdue } from "./DateBadge";

/* ===== SVG 圆环进度 ===== */
function ProgressRing({ value, size = 52, strokeWidth = 5 }: {
  value: number;
  size?: number;
  strokeWidth?: number;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-app-border"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="text-accent-primary transition-all duration-500"
      />
    </svg>
  );
}

export function TaskOverview({
  tasks,
  stats,
}: {
  tasks: Task[];
  stats: TaskStats | null;
}) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === "zh-CN" ? zhCN : enUS;

  if (!stats) return null;

  const progressPct = stats.total > 0
    ? Math.round((stats.completed / stats.total) * 100)
    : 0;

  // 最近截止：从未完成且有 dueDate 的任务中找最近的
  const nearestDue = tasks
    .filter((t) => !t.isCompleted && t.dueDate)
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1))[0] || null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 px-4 md:px-6 py-4">
      {/* 总体进度 */}
      <div className="flex items-center gap-4 p-4 rounded-xl bg-app-surface shadow-sm border border-app-border transition-colors">
        <div className="relative flex-shrink-0">
          <ProgressRing value={progressPct} />
          <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-accent-primary">
            {progressPct}%
          </span>
        </div>
        <div className="min-w-0">
          <div className="text-xs text-tx-tertiary">{t('tasks.overview.totalProgress')}</div>
          <div className="text-sm font-semibold text-tx-primary">
            {stats.completed} / {stats.total}
          </div>
          <div className="text-xs text-tx-tertiary">
            {t('tasks.overview.pending', { count: stats.pending })}
          </div>
        </div>
      </div>

      {/* 今日任务 */}
      <div className="flex items-center gap-4 p-4 rounded-xl bg-app-surface shadow-sm border border-app-border transition-colors">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-accent-primary/10">
          <CalendarDays size={22} className="text-accent-primary" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-tx-tertiary">{t('tasks.overview.todayTasks')}</div>
          <div className="text-lg font-bold text-tx-primary">{stats.today}</div>
          <div className="text-xs text-tx-tertiary">
            {t('tasks.overview.thisWeek', { count: stats.week ?? 0 })}
          </div>
        </div>
      </div>

      {/* 最近截止 */}
      <div className="flex items-center gap-4 p-4 rounded-xl bg-app-surface shadow-sm border border-app-border transition-colors">
        <div className={cn(
          "flex items-center justify-center w-12 h-12 rounded-full",
          nearestDue && isTaskDateOverdue(nearestDue.dueDate!)
            ? "bg-red-500/10"
            : "bg-amber-500/10"
        )}>
          <Clock size={22} className={cn(
            nearestDue && isTaskDateOverdue(nearestDue.dueDate!)
              ? "text-red-500"
              : "text-amber-500"
          )} />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-tx-tertiary">{t('tasks.overview.nearestDue')}</div>
          {nearestDue ? (
            <>
              <div className="text-sm font-semibold text-tx-primary truncate" title={nearestDue.title}>
                {nearestDue.title.length > 16
                  ? nearestDue.title.slice(0, 16) + "…"
                  : nearestDue.title}
              </div>
              <div className={cn(
                "text-xs",
                isTaskDateOverdue(nearestDue.dueDate!)
                  ? "text-red-500 font-medium"
                  : "text-tx-tertiary"
              )}>
                {format(parseISO(nearestDue.dueDate!), "M月d日", { locale: dateLocale })}
                {isTaskDateOverdue(nearestDue.dueDate!) && ` (${t('tasks.overview.overdue')})`}
              </div>
            </>
          ) : (
            <div className="text-sm text-tx-tertiary">{t('tasks.overview.noDeadline')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
