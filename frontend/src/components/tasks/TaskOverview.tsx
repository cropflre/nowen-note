import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { format, parseISO } from "date-fns";
import { zhCN, enUS } from "date-fns/locale";
import { CalendarDays, Clock } from "lucide-react";
import type { Task, TaskStats } from "@/types";
import { cn } from "@/lib/utils";
import { isTaskDateOverdue } from "./DateBadge";
import { parseTaskDate } from "./taskDateUtils";

/* ===== SVG 圆环进度 ===== */
function ProgressRing({ value, size = 40, strokeWidth = 4 }: {
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

/** 格式化倒计时：精确到秒 */
function formatCountdown(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return "";
  const totalSec = Math.floor(diff / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** 格式式逾期时长 */
function formatOverdue(targetMs: number): string {
  const diff = Date.now() - targetMs;
  if (diff <= 0) return "";
  const totalMin = Math.floor(diff / 60000);
  if (totalMin < 60) return `${totalMin}分钟`;
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 24) return `${totalHours}小时`;
  const days = Math.floor(totalHours / 24);
  return `${days}天`;
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
  const [, setTick] = useState(0);

  // 全局唯一 setInterval，每秒刷新倒计时
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!stats) return null;

  const progressPct = stats.total > 0
    ? Math.round((stats.completed / stats.total) * 100)
    : 0;

  // 最近截止：优先按 dueAt 排序，回退到 dueDate
  const nearestDue = tasks
    .filter((t) => !t.isCompleted && parseTaskDate(t.dueAt || t.dueDate))
    .sort((a, b) => {
      const aTime = a.dueAt || a.dueDate!;
      const bTime = b.dueAt || b.dueDate!;
      return aTime < bTime ? -1 : 1;
    })[0] || null;

  // 倒计时/逾期
  let countdownStr = "";
  let isOverdue = false;
  if (nearestDue) {
    const dueStr = (nearestDue.dueAt || nearestDue.dueDate!).trim().replace(" ","T");
    const targetMs = new Date(dueStr.includes("T") ? dueStr : dueStr + "T23:59:59").getTime();
    isOverdue = isTaskDateOverdue(nearestDue.dueDate!, nearestDue.dueAt);
    if (isOverdue) {
      countdownStr = formatOverdue(targetMs);
    } else {
      countdownStr = formatCountdown(targetMs);
    }
  }

  return (
    <div className="grid grid-cols-3 gap-2.5 px-4 md:px-5 pt-3 pb-1">
      {/* 总体进度 */}
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-app-surface shadow-sm border border-app-border transition-colors">
        <div className="relative flex-shrink-0">
          <ProgressRing value={progressPct} />
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-accent-primary">
            {progressPct}%
          </span>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] text-tx-tertiary leading-tight">{t('tasks.overview.totalProgress')}</div>
          <div className="text-xs font-semibold text-tx-primary leading-tight">
            {stats.completed}/{stats.total}
          </div>
          <div className="text-[10px] text-tx-tertiary leading-tight">
            {t('tasks.overview.pending', { count: stats.pending })}
          </div>
        </div>
      </div>

      {/* 今日任务 */}
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-app-surface shadow-sm border border-app-border transition-colors">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-accent-primary/10">
          <CalendarDays size={18} className="text-accent-primary" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] text-tx-tertiary leading-tight">{t('tasks.overview.todayTasks')}</div>
          <div className="text-sm font-bold text-tx-primary leading-tight">{stats.today}</div>
          <div className="text-[10px] text-tx-tertiary leading-tight">
            {t('tasks.overview.thisWeek', { count: stats.week ?? 0 })}
          </div>
        </div>
      </div>

      {/* 最近截止 + 倒计时 */}
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-app-surface shadow-sm border border-app-border transition-colors">
        <div className={cn(
          "flex items-center justify-center w-9 h-9 rounded-lg",
          isOverdue ? "bg-red-500/10" : "bg-amber-500/10"
        )}>
          <Clock size={18} className={isOverdue ? "text-red-500" : "text-amber-500"} />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] text-tx-tertiary leading-tight">{t('tasks.overview.nearestDue')}</div>
          {nearestDue ? (
            <>
              <div className="text-xs font-semibold text-tx-primary truncate leading-tight" title={nearestDue.title}>
                {nearestDue.title.length > 12
                  ? nearestDue.title.slice(0, 12) + "…"
                  : nearestDue.title}
              </div>
              <div className={cn(
                "text-[10px] font-mono leading-tight",
                isOverdue ? "text-red-500 font-medium" : "text-tx-tertiary"
              )}>
                {isOverdue
                  ? `逾期 ${countdownStr}`
                  : countdownStr}
              </div>
            </>
          ) : (
            <div className="text-xs text-tx-tertiary leading-tight">{t('tasks.overview.noDeadline')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
