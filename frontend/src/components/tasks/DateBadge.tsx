import { format, isToday, isPast, isTomorrow, isThisWeek, parseISO } from "date-fns";
import { zhCN, enUS } from "date-fns/locale";
import { Calendar } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 将 dueDate 字符串（YYYY-MM-DD）按本地日期解析为 Date 对象。
 * 避免 parseISO 在不同时区下的偏移问题。
 */
export function toLocalDate(dateStr: string): Date {
  const d = parseISO(dateStr);
  if (isNaN(d.getTime())) {
    const parts = dateStr.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  return d;
}

/**
 * 判断纯日期（YYYY-MM-DD）是否已逾期。
 * 规则：只有 dueDate 日期 < 今天本地日期才算逾期，今天截止不算逾期。
 */
export function isTaskDateOverdue(dueDate: string): boolean {
  const d = toLocalDate(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d < today;
}

/* ===== 日期胶囊 ===== */
export function DateBadge({ dateStr }: { dateStr: string | null }) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === "zh-CN" ? zhCN : enUS;
  if (!dateStr) return null;
  const d = toLocalDate(dateStr);
  const formatted = format(d, "M/d", { locale: dateLocale });

  let label: string;
  let cls: string;
  if (isToday(d)) {
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

  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full", cls)}>
      <Calendar size={10} />
      {label}
    </span>
  );
}
