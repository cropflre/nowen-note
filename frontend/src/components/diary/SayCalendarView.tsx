import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Image, Video, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { localDateRangeToUtcSqlBounds } from "@/lib/dateTime";
import type { Diary } from "@/types";
import { formatDateKey, getMonthGrid, groupDiariesByDate } from "@/lib/sayCalendar";
import SayCalendarDayPanel from "@/components/diary/SayCalendarDayPanel";
import { useHolidayCalendar } from "@/hooks/useHolidayCalendar";
import { HolidayCalendarSettings } from "@/components/calendar/HolidayCalendarSettings";
import { HolidayDayLabel } from "@/components/calendar/HolidayDayLabel";

function getTodayKey(): string {
  const d = new Date();
  return formatDateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function monthLabel(year: number, month: number, t: (k: string) => string): string {
  const months = Array.from({ length: 12 }, (_, i) => t(`calendar.months.${i}`));
  return `${year} ${months[month - 1]}`;
}

export default function SayCalendarView({
  onClose,
  onWriteEntry,
  onLocateItem,
}: {
  onClose: () => void;
  onWriteEntry: () => void;
  onLocateItem: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(getTodayKey());
  const [items, setItems] = useState<Diary[]>([]);
  const [loading, setLoading] = useState(false);

  const grid = useMemo(() => getMonthGrid(year, month), [year, month]);
  const holidays = useHolidayCalendar(grid.map((cell) => Number(cell.dateKey.slice(0, 4))));
  const itemsByDate = useMemo(() => groupDiariesByDate(items) as Map<string, Diary[]>, [items]);

  const fetchMonthItems = useCallback(async () => {
    const range = localDateRangeToUtcSqlBounds({
      from: formatDateKey(year, month, 1),
      to: formatDateKey(year, month, new Date(year, month, 0).getDate()),
    });
    setLoading(true);
    try {
      const data = await api.getDiaryTimeline(undefined, 200, range);
      setItems(data.items || []);
    } catch (e) {
      console.error("Load calendar month failed:", e);
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    void fetchMonthItems();
  }, [fetchMonthItems]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const goPrev = () => {
    const d = new Date(year, month - 2, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setSelectedDateKey(null);
  };
  const goNext = () => {
    const d = new Date(year, month, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setSelectedDateKey(null);
  };
  const goToday = () => {
    const d = new Date();
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setSelectedDateKey(getTodayKey());
  };

  const weekLabels = [t("calendar.week.mon"), t("calendar.week.tue"), t("calendar.week.wed"), t("calendar.week.thu"), t("calendar.week.fri"), t("calendar.week.sat"), t("calendar.week.sun")];
  const todayKey = getTodayKey();
  const selectedItems = selectedDateKey ? itemsByDate.get(selectedDateKey) || [] : [];

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-app-bg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-surface/40">
        <div className="flex items-center gap-1">
          <button
            onClick={onClose}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[11px] font-medium bg-app-hover/60 text-tx-secondary hover:bg-app-hover transition-all"
          >
            {t("diary.exitCalendar")}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={goPrev}
            className="p-1.5 rounded-lg text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover transition-all"
          >
            <ChevronLeft size={16} />
          </button>
          <div className="text-sm font-semibold text-tx-primary min-w-[120px] text-center">
            {monthLabel(year, month, t)}
          </div>
          <button
            onClick={goNext}
            className="p-1.5 rounded-lg text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover transition-all"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <button
          onClick={goToday}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[11px] font-medium bg-app-hover/60 text-tx-secondary hover:bg-app-hover transition-all"
        >
          {t("diary.calendarToday")}
        </button>
      </div>

      <HolidayCalendarSettings year={year} />

      <div className="flex-1 overflow-auto p-4">
        <p className="mb-3 text-xs text-tx-tertiary">{t("diary.calendarSubtitle")}</p>
        {loading ? (
          <div className="flex items-center justify-center h-full text-tx-tertiary">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
            <div className="min-w-0">
              <div className="grid grid-cols-7 text-[11px] text-tx-tertiary mb-1">
                {weekLabels.map((label) => (
                  <div key={label} className="px-1 py-1 text-center">{label}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {grid.map((cell) => {
                  const cellItems = itemsByDate.get(cell.dateKey) || [];
                  const count = cellItems.length;
                  const isSelected = selectedDateKey === cell.dateKey;
                  const isToday = todayKey === cell.dateKey;
                  const previewItems = cellItems.slice(0, 3);

                  return (
                    <button
                      key={cell.dateKey}
                      aria-label={cell.dateKey}
                      onClick={() => setSelectedDateKey(cell.dateKey)}
                      className={cn(
                        "group relative flex min-w-0 flex-col items-start p-1 sm:p-2 min-h-[72px] sm:min-h-[88px] rounded-xl border transition-all",
                        isSelected
                          ? "border-accent-primary bg-accent-primary/5 shadow-sm shadow-accent-primary/10"
                          : "border-app-border/60 bg-app-surface/30 hover:border-accent-primary/30 hover:bg-app-surface/50"
                      )}
                    >
                      <div className="flex w-full items-center justify-between">
                        <span
                          className={cn(
                            "text-xs font-semibold",
                            !cell.isCurrentMonth
                              ? "text-tx-tertiary/60"
                              : isToday
                                ? "text-accent-primary"
                                : "text-tx-primary"
                          )}
                        >
                          {cell.date}
                        </span>
                        {count > 0 && (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-accent-primary/10 text-accent-primary">
                            {count}
                          </span>
                        )}
                      </div>
                      <HolidayDayLabel day={holidays.getDay(cell.dateKey)} />
                      <div className="mt-1 flex w-full flex-col gap-0.5 overflow-hidden max-h-[42px] sm:max-h-[56px]">
                        {previewItems.map((item) => (
                          <div key={item.id} className="flex items-center gap-1 text-[10px] text-tx-secondary truncate">
                            <span className="truncate">{item.contentText?.slice(0, 10) || t("diary.media")}</span>
                            {(item.images?.length > 0 || (item.media || []).some((m) => m.type === "image")) && <Image size={10} className="shrink-0 text-tx-tertiary/70" />}
                            {(item.media || []).some((m) => m.type === "video") && <Video size={10} className="shrink-0 text-tx-tertiary/70" />}
                          </div>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="hidden lg:block">
              <SayCalendarDayPanel
                holiday={selectedDateKey ? holidays.getDay(selectedDateKey) : undefined}
                dateKey={selectedDateKey || ""}
                items={selectedItems}
                onWriteEntry={onWriteEntry}
                onLocateItem={onLocateItem}
              />
            </div>
          </div>
        )}
      </div>

      <div className="lg:hidden border-t border-app-border bg-app-surface/40">
        <SayCalendarDayPanel
          holiday={selectedDateKey ? holidays.getDay(selectedDateKey) : undefined}
          dateKey={selectedDateKey || ""}
          items={selectedItems}
          onWriteEntry={onWriteEntry}
          onLocateItem={onLocateItem}
        />
      </div>
    </div>
  );
}
