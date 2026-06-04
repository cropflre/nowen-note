import React, { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, Loader2, CheckSquare, CheckCircle2, Circle } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Task } from "@/types";

interface TaskCalendarProps {
  onDateSelect: (dateStr: string) => void;
}

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

export default function TaskCalendar({ onDateSelect }: TaskCalendarProps) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [dates, setDates] = useState<Map<string, { total: number; pending: number }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dayItems, setDayItems] = useState<Task[]>([]);
  const [loadingDay, setLoadingDay] = useState(false);

  // 点击日期：加载当天的任务
  const handleDateClick = useCallback(async (dateStr: string) => {
    if (selectedDate === dateStr) { setSelectedDate(null); setDayItems([]); return; }
    setSelectedDate(dateStr);
    setLoadingDay(true);
    try {
      const all = await api.getTasks("all");
      const filtered = (all || []).filter((t: Task) => t.dueDate && t.dueDate.startsWith(dateStr));
      setDayItems(filtered);
    } catch { setDayItems([]); }
    finally { setLoadingDay(false); }
  }, [selectedDate]);

  const loadCalendar = useCallback(async (y: number, m: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getTaskCalendar(y, m);
      setDates(new Map(res.dates.map((d) => [d.date, { total: d.total, pending: d.pending }])));
    } catch (e: any) {
      console.error("Task calendar load failed:", e);
      setError(e?.message || "加载失败");
      setDates(new Map());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCalendar(year, month);
  }, [year, month, loadCalendar]);

  const goPrev = () => {
    if (month === 1) { setYear((y) => y - 1); setMonth(12); }
    else { setMonth((m) => m - 1); }
  };
  const goNext = () => {
    if (month === 12) { setYear((y) => y + 1); setMonth(1); }
    else { setMonth((m) => m + 1); }
  };
  const goToday = () => { setYear(today.getFullYear()); setMonth(today.getMonth() + 1); };

  const isFutureMonth = year > today.getFullYear() || (year === today.getFullYear() && month > today.getMonth() + 1);

  const firstDayOfMonth = new Date(year, month - 1, 1).getDay();
  const offset = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
  const daysInMonth = new Date(year, month, 0).getDate();

  const grid: (number | null)[] = [];
  for (let i = 0; i < offset; i++) grid.push(null);
  for (let d = 1; d <= daysInMonth; d++) grid.push(d);
  while (grid.length % 7 !== 0) grid.push(null);

  const dateToStr = (d: number) => `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-4">
        <button onClick={goPrev} className="w-8 h-8 rounded-lg hover:bg-app-hover text-tx-secondary flex items-center justify-center transition-all active:scale-90">
          <ChevronLeft size={18} />
        </button>
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-tx-primary tabular-nums">{year}年{month}月</span>
          {(year !== today.getFullYear() || month !== today.getMonth() + 1) && (
            <button onClick={goToday} className="text-[11px] px-2.5 py-1 rounded-full bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 font-medium transition-all">今日</button>
          )}
        </div>
        <button onClick={goNext} disabled={isFutureMonth} className={cn("w-8 h-8 rounded-lg flex items-center justify-center transition-all active:scale-90", isFutureMonth ? "text-tx-tertiary/30 cursor-not-allowed" : "hover:bg-app-hover text-tx-secondary")}>
          <ChevronRight size={18} />
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-accent-primary" /></div>
      ) : error ? (
        <div className="flex flex-col items-center py-12 text-center">
          <p className="text-sm text-tx-tertiary">{error}</p>
          <button onClick={() => loadCalendar(year, month)} className="mt-2 text-xs text-accent-primary hover:underline">重试</button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label} className="text-center text-[11px] text-tx-tertiary font-medium py-1">{label}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {grid.map((day, i) => {
              if (day === null) return <div key={`e-${i}`} />;
              const dateStr = dateToStr(day);
              const info = dates.get(dateStr);
              const isToday = dateStr === todayStr;

              return (
                <button
                  key={dateStr}
                  onClick={() => handleDateClick(dateStr)}
                  className={cn(
                    "relative flex flex-col items-center justify-center py-2 rounded-xl transition-all active:scale-90",
                    info ? "hover:bg-accent-primary/10 text-tx-primary" : "text-tx-tertiary/60 hover:bg-app-hover",
                    isToday && "ring-1 ring-accent-primary/30",
                    selectedDate === dateStr && "bg-accent-primary/10 ring-1 ring-accent-primary/30",
                  )}
                >
                  <span className={cn("text-sm font-medium leading-none", isToday && "text-accent-primary font-bold")}>{day}</span>
                  {info && (
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-[9px] text-accent-primary font-medium tabular-nums">{info.pending}</span>
                      <CheckSquare size={8} className="text-tx-tertiary/40" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          {dates.size === 0 && !selectedDate && (
            <p className="text-center text-xs text-tx-tertiary mt-6">这个月还没有待办事项</p>
          )}

          {/* 选中日期的任务列表 */}
          {selectedDate && (
            <div className="mt-4 rounded-xl border border-app-border/60 bg-app-surface/30 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-app-border/30">
                <span className="text-[11px] font-medium text-tx-primary">{selectedDate}</span>
                <button onClick={() => onDateSelect(selectedDate)} className="text-[10px] text-accent-primary hover:underline flex items-center gap-1">
                  查看全部 <ChevronDown size={10} />
                </button>
              </div>
              {loadingDay ? (
                <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-accent-primary" /></div>
              ) : dayItems.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-tx-tertiary">当天没有待办事项</div>
              ) : (
                dayItems.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 px-4 py-3 border-b border-app-border/20 last:border-0 hover:bg-app-hover/30 transition-colors">
                    {item.isCompleted
                      ? <CheckCircle2 size={14} className="text-green-500 shrink-0" />
                      : <Circle size={14} className="text-tx-tertiary/40 shrink-0" />
                    }
                    <span className={cn("text-xs flex-1", item.isCompleted && "line-through text-tx-tertiary")}>{item.title}</span>
                    {item.priority && item.priority >= 3 && <span className="text-[10px] text-red-500 shrink-0">!!</span>}
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
