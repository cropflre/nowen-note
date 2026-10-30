import { format, isToday, isPast, isTomorrow, isThisWeek } from "date-fns";
import { parseTaskDate, getDueTimeValue } from "./taskDateUtils";
import { zhCN, enUS } from "date-fns/locale";
import { Calendar } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 将 dueDate 字符串（YYYY-MM-DD）按本地日期解析为 Date 对象。
 * 避免 parseISO 在不同时区下的偏移问题。
 */
export function toLocalDate(dateStr: string): Date {
  return parseTaskDate(dateStr) || new Date(NaN);
}

/**
 * 判断纯日期（YYYY-MM-DD）是否已逾期。
 * 规则：只有 dueDate 日期 < 今天本地日期才算逾期，今天截止不算逾期。
 */
export function isTaskDateOverdue(dueDate: string, dueAt?: string | null): boolean {
  // 有 dueAt 时按精确时间判断，否则按日期
  if (dueAt) {
    const dueTime = new Date(dueAt).getTime();
    return Date.now() > dueTime;
  }
  const d = toLocalDate(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d < today;
}

/* ===== 日期胶囊 ===== */
export function DateBadge({
  dateStr,
  dueAt,
  isCompleted = false,
}: {
  dateStr: string | null;
  dueAt?: string | null;
  isCompleted?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === "zh-CN" ? zhCN : enUS;
  if (!dateStr) return null;
  const d = toLocalDate(dateStr);
  if (!Number.isFinite(d.getTime()) || (dueAt && !parseTaskDate(dueAt))) {
    return <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-red-500/10 text-red-500" title={t("taskRemoval.invalidDate")}><Calendar size={10}/>{t("taskRemoval.invalidDate")}</span>;
  }
  const formatted = format(d, "M/d", { locale: dateLocale });

  let label: string;
  let cls: string;
  if (isCompleted) {
    // 已完成任务只展示日期本身，不再标红"已逾期"
    label = formatted;
    cls = "bg-app-hover text-tx-tertiary";
  } else if (isToday(d)) {
    label = t('tasks.today');
    cls = "bg-indigo-500/10 text-indigo-500";
  } else if (isTomorrow(d)) {
    label = t('tasks.tomorrow');
    cls = "bg-blue-500/10 text-blue-500";
  } else if (isPast(d) && !isToday(d)) {
    label = t('tasks.overdue');
    cls = "bg-red-500/10 text-red-500";
  } else if (isThisWeek(d, { weekStartsOn: 1 })) {
    label = format(d, "EEEE", { locale: dateLocale });
    cls = "bg-emerald-500/10 text-emerald-500";
  } else {
    label = formatted;
    cls = "bg-app-hover text-tx-secondary";
  }

  // 如果有 dueAt，附加时间显示
  const timeStr = getDueTimeValue(dueAt);
  const displayLabel = timeStr && !isToday(d) && !isTomorrow(d)
    ? label + " " + timeStr.slice(0, 5)
    : label;

  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full", cls)}>
      <Calendar size={10} />
      {displayLabel}
    </span>
  );
}
