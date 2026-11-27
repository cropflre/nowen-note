import React, { useMemo } from "react";
import { motion } from "framer-motion";
import { Calendar, TrendingUp, Smile, BarChart3, ChevronRight, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Diary, DiaryStats } from "@/types";

// 心情选项
const MOODS = [
  { value: "happy", emoji: "😊" },
  { value: "excited", emoji: "🥳" },
  { value: "peaceful", emoji: "😌" },
  { value: "thinking", emoji: "🤔" },
  { value: "tired", emoji: "😴" },
  { value: "sad", emoji: "😢" },
  { value: "angry", emoji: "😤" },
  { value: "sick", emoji: "🤒" },
  { value: "love", emoji: "🥰" },
  { value: "cool", emoji: "😎" },
  { value: "laugh", emoji: "🤣" },
  { value: "shock", emoji: "😱" },
];

function getMoodEmoji(mood: string): string {
  return MOODS.find((m) => m.value === mood)?.emoji || "";
}

interface DiarySidebarProps {
  stats: DiaryStats | null;
  moodFilter: string;
  onMoodFilterChange: (mood: string) => void;
  onOpenCalendar: () => void;
  recentItems: Diary[];
}

/**
 * 说说模块右侧面板（桌面端）
 *
 * 包含：
 * - 日历入口卡片
 * - 今日统计
 * - 心情筛选
 * - 最近动态
 */
export default function DiarySidebar({
  stats,
  moodFilter,
  onMoodFilterChange,
  onOpenCalendar,
  recentItems,
}: DiarySidebarProps) {
  const { t } = useTranslation();

  // 统计心情分布
  const moodDistribution = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of recentItems) {
      if (item.mood) {
        counts[item.mood] = (counts[item.mood] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  }, [recentItems]);

  return (
    <div className="space-y-4">
      {/* 日历入口卡片 */}
      <motion.button
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.98 }}
        onClick={onOpenCalendar}
        className="group relative w-full overflow-hidden rounded-2xl border border-violet-300/35 bg-gradient-to-br from-violet-500/[0.10] via-fuchsia-500/[0.06] to-pink-500/[0.10] p-4 shadow-xs transition-all hover:border-violet-400/50 hover:shadow-md dark:border-violet-400/20"
      >
        <span className="pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full bg-pink-400/15 blur-xl transition-transform duration-300 group-hover:scale-125" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-pink-500 shadow-md shadow-violet-500/25 transition-transform duration-200 group-hover:-rotate-6 group-hover:scale-105">
            <Calendar size={20} className="text-white" />
          </div>
          <div className="min-w-0 flex-1 text-left">
            <div className="flex items-center gap-1.5 text-sm font-bold text-tx-primary">
              <span className="truncate">{t("diary.calendarTitle") || "日历视图"}</span>
              <Sparkles size={12} className="shrink-0 text-amber-400" />
            </div>
            <div className="mt-0.5 text-[11px] text-tx-secondary">
              {t("diary.calendarSubtitle", { defaultValue: "按日期浏览说说" })}
            </div>
          </div>
          <ChevronRight size={15} className="shrink-0 text-tx-tertiary transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-violet-500" />
        </div>
      </motion.button>

      {/* 今日统计卡片 */}
      {stats && (
        <div className="rounded-2xl border border-app-border/80 bg-app-elevated/85 p-4 shadow-xs backdrop-blur-sm">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-sky-500/12 text-sky-600 dark:text-sky-300">
              <BarChart3 size={13} />
            </span>
            <span className="text-xs font-semibold text-tx-primary">
              {t("diary.statsTitle", { defaultValue: "统计" })}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-xl border border-violet-500/15 bg-gradient-to-br from-violet-500/[0.08] to-sky-500/[0.06] p-3 text-center">
              <div className="text-xl font-bold tabular-nums text-violet-600 dark:text-violet-300">{stats.total}</div>
              <div className="mt-0.5 text-[11px] font-medium text-tx-secondary">{t("diary.statsTotal", { defaultValue: "总计" })}</div>
            </div>
            <div className="rounded-xl border border-pink-500/15 bg-gradient-to-br from-pink-500/[0.08] to-amber-500/[0.06] p-3 text-center">
              <div className="text-xl font-bold tabular-nums text-pink-600 dark:text-pink-300">{stats.todayCount}</div>
              <div className="mt-0.5 text-[11px] font-medium text-tx-secondary">{t("diary.statsToday", { defaultValue: "今日" })}</div>
            </div>
          </div>
        </div>
      )}

      {/* 心情筛选 */}
      <div className="rounded-2xl border border-app-border/80 bg-app-elevated/85 p-4 shadow-xs backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-500/14 text-amber-600 dark:text-amber-300">
              <Smile size={13} />
            </span>
            <span className="text-xs font-semibold text-tx-primary">
              {t("diary.moodFilterTitle", { defaultValue: "心情" })}
            </span>
          </div>
          <button
            onClick={() => onMoodFilterChange("")}
            className={cn(
              "rounded-full px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-all active:scale-95",
              !moodFilter
                ? "bg-violet-500/14 text-violet-600 ring-1 ring-violet-500/25 dark:text-violet-300"
                : "text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary",
            )}
          >
            {t("diary.filterMoodAll")}
          </button>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {MOODS.map(({ value: v, emoji }) => {
            const active = moodFilter === v;
            return (
              <motion.button
                key={v}
                whileHover={{ scale: 1.15, rotate: active ? 0 : -6 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => onMoodFilterChange(active ? "" : v)}
                className={cn(
                  "flex h-10 items-center justify-center rounded-xl text-xl transition-all",
                  active
                    ? "bg-gradient-to-br from-violet-500/18 to-pink-500/18 shadow-xs ring-2 ring-violet-400/50"
                    : "bg-app-hover/45 hover:bg-app-hover/90",
                )}
                title={t(`diary.mood${v.charAt(0).toUpperCase() + v.slice(1)}`)}
              >
                {emoji}
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* 心情分布（最近说说） */}
      {moodDistribution.length > 0 && (
        <div className="rounded-2xl border border-app-border/80 bg-app-elevated/85 p-4 shadow-xs backdrop-blur-sm">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-pink-500/12 text-pink-600 dark:text-pink-300">
              <TrendingUp size={13} />
            </span>
            <span className="text-xs font-semibold text-tx-primary">
              {t("diary.moodDistribution", { defaultValue: "心情分布" })}
            </span>
          </div>
          <div className="space-y-2.5">
            {moodDistribution.map(([mood, count]) => (
              <div key={mood} className="flex items-center gap-2">
                <span className="w-6 text-center text-base">{getMoodEmoji(mood)}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-app-hover">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 to-pink-500 transition-all duration-300"
                    style={{ width: `${Math.min(100, (count / recentItems.length) * 100)}%` }}
                  />
                </div>
                <span className="w-6 text-right text-[11px] font-medium tabular-nums text-tx-tertiary">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
