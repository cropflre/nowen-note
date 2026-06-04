import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Diary } from "@/types";

interface DiaryCalendarProps {
  onDateSelect: (dateStr: string) => void;
  tagId?: string;
  search?: string;
}

// 周几标题（本地化友好，这里直接用简写）
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

/**
 * 说说日历视图
 *
 * 按月网格展示，标记有说说的日期。
 * 支持月份切换、今日快捷定位、点击跳转。
 */
export default function DiaryCalendar({ onDateSelect, tagId, search }: DiaryCalendarProps) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [dates, setDates] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dayItems, setDayItems] = useState<Diary[]>([]);
  const [loadingDay, setLoadingDay] = useState(false);

  const loadCalendar = useCallback(async (y: number, m: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDiaryCalendar(y, m, tagId, search);
      setDates(new Set(res.dates));
    } catch (e: any) {
      console.error("Calendar load failed:", e);
      setError(e?.message || "加载失败");
      setDates(new Set());
    } finally {
      setLoading(false);
    }
  }, [tagId, search]);

  useEffect(() => {
    loadCalendar(year, month);
  }, [year, month, tagId, search, loadCalendar]);

  // 月导航
  const goPrev = () => {
    if (month === 1) {
      setYear((y) => y - 1);
      setMonth(12);
    } else {
      setMonth((m) => m - 1);
    }
  };

  const goNext = () => {
    if (month === 12) {
      setYear((y) => y + 1);
      setMonth(1);
    } else {
      setMonth((m) => m + 1);
    }
  };

  const goToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth() + 1);
  };

  // 点击日期：切换选中日期
  const handleDateClick = useCallback((dateStr: string) => {
    if (selectedDate === dateStr) {
      setSelectedDate(null);
    } else {
      setSelectedDate(dateStr);
    }
  }, [selectedDate]);

  // 监听选中日期和标签过滤器的变更，动态更新列表，确保标签筛选即时生效
  useEffect(() => {
    if (!selectedDate) {
      setDayItems([]);
      return;
    }
    let active = true;
    setLoadingDay(true);
    api.getDiaryTimeline(undefined, 20, { from: selectedDate, to: selectedDate }, undefined, tagId, search)
      .then((res) => {
        if (active) {
          setDayItems(res.items || []);
        }
      })
      .catch(() => {
        if (active) {
          setDayItems([]);
        }
      })
      .finally(() => {
        if (active) {
          setLoadingDay(false);
        }
      });
    return () => {
      active = false;
    };
  }, [selectedDate, tagId, search]);

  // 不允许跳到未来月份
  const isFutureMonth =
    year > today.getFullYear() ||
    (year === today.getFullYear() && month > today.getMonth() + 1);

  // 当月第一天是周几（0=日…6=六），用于计算偏移
  const firstDayOfMonth = new Date(year, month - 1, 1).getDay();
  // 把周日=0 转为 周日=7（更方便以周一始的布局，但我们用周日开头，保持原样）
  const offset = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1; // offset = 周一=0 … 周日=6

  // 当月天数
  const daysInMonth = new Date(year, month, 0).getDate();

  // 构建网格：6 行 × 7 列
  const grid: (number | null)[] = [];
  for (let i = 0; i < offset; i++) grid.push(null); // 前月填充
  for (let d = 1; d <= daysInMonth; d++) grid.push(d);
  while (grid.length % 7 !== 0) grid.push(null); // 末尾填充

  const dateToStr = (d: number) =>
    `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <div className="select-none">
      {/* 月份导航 */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={goPrev}
          className="w-8 h-8 rounded-lg hover:bg-app-hover text-tx-secondary flex items-center justify-center transition-all active:scale-90"
          aria-label="上个月"
        >
          <ChevronLeft size={18} />
        </button>

        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-tx-primary tabular-nums">
            {year}年{month}月
          </span>
          {(year !== today.getFullYear() || month !== today.getMonth() + 1) && (
            <button
              onClick={goToday}
              className="text-[11px] px-2.5 py-1 rounded-full bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 font-medium transition-all"
            >
              今日
            </button>
          )}
        </div>

        <button
          onClick={goNext}
          disabled={isFutureMonth}
          className={cn(
            "w-8 h-8 rounded-lg flex items-center justify-center transition-all active:scale-90",
            isFutureMonth
              ? "text-tx-tertiary/30 cursor-not-allowed"
              : "hover:bg-app-hover text-tx-secondary",
          )}
          aria-label="下个月"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* 加载 / 错误 / 内容 */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 size={20} className="animate-spin text-accent-primary" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center py-12 text-center">
          <p className="text-sm text-tx-tertiary">{error}</p>
          <button
            onClick={() => loadCalendar(year, month)}
            className="mt-2 text-xs text-accent-primary hover:underline"
          >
            重试
          </button>
        </div>
      ) : (
        <>
          {/* 周几标题行 */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAY_LABELS.map((label) => (
              <div
                key={label}
                className="text-center text-[11px] text-tx-tertiary font-medium py-1"
              >
                {label}
              </div>
            ))}
          </div>

          {/* 日期网格 */}
          <div className="grid grid-cols-7 gap-1">
            {grid.map((day, i) => {
              if (day === null) {
                return <div key={`empty-${i}`} />; // 占位
              }

              const dateStr = dateToStr(day);
              const hasEntry = dates.has(dateStr);
              const isToday = dateStr === todayStr;

              return (
                <button
                  key={dateStr}
                  onClick={() => handleDateClick(dateStr)}
                  className={cn(
                    "relative flex flex-col items-center justify-center py-2 rounded-xl transition-all active:scale-90",
                    hasEntry ? "hover:bg-accent-primary/10 text-tx-primary" : "text-tx-tertiary/60 hover:bg-app-hover",
                    isToday && "ring-1 ring-accent-primary/30",
                    selectedDate === dateStr && "bg-accent-primary/10 ring-1 ring-accent-primary/30",
                  )}
                >
                  <span
                    className={cn(
                      "text-sm font-medium leading-none",
                      isToday && "text-accent-primary font-bold",
                    )}
                  >
                    {day}
                  </span>
                  {hasEntry && (
                    <span className="mt-1 w-1 h-1 rounded-full bg-accent-primary" />
                  )}
                </button>
              );
            })}
          </div>

          {/* 无说说的提示 */}
          {dates.size === 0 && !selectedDate && (
            <p className="text-center text-xs text-tx-tertiary mt-6">
              这个月还没有说说
            </p>
          )}

          {/* 选中日期的条目列表 */}
          {selectedDate && (
            <div className="mt-4 rounded-xl border border-app-border/60 bg-app-surface/30 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-app-border/30">
                <span className="text-[11px] font-medium text-tx-primary">{selectedDate}</span>
                <button
                  onClick={() => onDateSelect(selectedDate)}
                  className="text-[10px] text-accent-primary hover:underline flex items-center gap-1"
                >
                  查看全部 <ChevronRight size={10} />
                </button>
              </div>
              {loadingDay ? (
                <div className="flex justify-center py-6">
                  <Loader2 size={16} className="animate-spin text-accent-primary" />
                </div>
              ) : dayItems.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-tx-tertiary">
                  当天没有说说
                </div>
              ) : (
                dayItems.map((item) => (
                  <div key={item.id} className="px-4 py-3 border-b border-app-border/20 last:border-0 hover:bg-app-hover/30 transition-colors">
                    <p className="text-xs text-tx-primary line-clamp-2 break-words">
                      {item.contentText || <span className="text-tx-tertiary">[图片/语音]</span>}
                    </p>
                    <p className="text-[10px] text-tx-tertiary mt-1">
                      {item.createdAt.slice(11, 16)}
                      {item.creatorName && ` · ${item.creatorName}`}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
