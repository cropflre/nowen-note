/**
 * 个人日记档案。
 *
 * 只消费 /journals/list 的轻量 DTO，不拉完整正文。日期是事实主标题，
 * notes.title 仅在与 journal_date 不同时作为副标题显示。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  Loader2,
  Search,
  SlidersHorizontal,
} from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type JournalSort = "date_desc" | "date_asc" | "updated_desc" | "updated_asc";

interface JournalItem {
  id: string;
  title: string;
  subtitle: string;
  journalDate: string;
  preview: string;
  moods: string[];
  createdAt: string;
  updatedAt: string;
}

interface ArchiveGroup {
  year: string;
  months: Array<{ month: string; items: JournalItem[] }>;
}

const MOODS = [
  ["happy", "😊"],
  ["excited", "🥳"],
  ["peaceful", "😌"],
  ["thinking", "🤔"],
  ["tired", "😴"],
  ["sad", "😢"],
  ["angry", "😤"],
  ["sick", "🤒"],
  ["love", "🥰"],
  ["cool", "😎"],
  ["laugh", "🤣"],
  ["shock", "😱"],
] as const;

function groupItems(items: JournalItem[]): ArchiveGroup[] {
  const years = new Map<string, Map<string, JournalItem[]>>();
  for (const item of items) {
    const year = item.journalDate.slice(0, 4);
    const month = item.journalDate.slice(5, 7);
    const months = years.get(year) || new Map<string, JournalItem[]>();
    const list = months.get(month) || [];
    list.push(item);
    months.set(month, list);
    years.set(year, months);
  }
  return Array.from(years.entries()).map(([year, months]) => ({
    year,
    months: Array.from(months.entries()).map(([month, monthItems]) => ({ month, items: monthItems })),
  }));
}

export default function JournalArchive({
  selectedDate,
  onSelectDate,
  refreshToken = 0,
}: {
  selectedDate: string;
  onSelectDate: (dateKey: string) => void;
  refreshToken?: number;
}) {
  const [items, setItems] = useState<JournalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [mood, setMood] = useState("");
  const [sort, setSort] = useState<JournalSort>("date_desc");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [availableYears, setAvailableYears] = useState<string[]>([]);

  const loadYears = useCallback(async () => {
    try {
      const archive = await api.journals.getArchive();
      setAvailableYears((archive.years || []).map((item) => item.year));
    } catch {
      setAvailableYears([]);
    }
  }, []);

  const load = useCallback(async (offset = 0, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const result = await api.journals.list({
        year: year || undefined,
        month: month || undefined,
        from: from || undefined,
        to: to || undefined,
        mood: mood || undefined,
        q: q.trim() || undefined,
        sort,
        offset,
        limit: 50,
      });
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setHasMore(result.hasMore);
      setNextOffset(result.nextOffset);
    } catch (error: any) {
      if (error?.code !== "FOLDER_UNLOCK_REQUIRED") console.error("[JournalArchive] load failed", error);
      if (!append) setItems([]);
      setHasMore(false);
      setNextOffset(null);
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }, [from, month, mood, q, sort, to, year]);

  useEffect(() => { void loadYears(); }, [loadYears, refreshToken]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(0, false), q ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [load, q, refreshToken]);

  const groups = useMemo(() => groupItems(items), [items]);

  return (
    <div className="space-y-3" data-journal-archive="">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" />
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="搜索日记"
            className="h-8 w-full rounded-lg border border-app-border bg-app-bg pl-8 pr-2 text-xs text-tx-primary outline-none focus:border-accent-primary/60"
          />
        </div>
        <button
          type="button"
          onClick={() => setFiltersOpen((value) => !value)}
          className={cn(
            "rounded-lg border border-app-border p-2 text-tx-tertiary hover:bg-app-hover",
            filtersOpen && "border-accent-primary/40 bg-accent-primary/10 text-accent-primary",
          )}
          title="筛选与排序"
        >
          <SlidersHorizontal size={13} />
        </button>
      </div>

      {filtersOpen && (
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-app-hover/40 p-2">
          <select value={year} onChange={(e) => { setYear(e.target.value); if (!e.target.value) setMonth(""); }} className="h-8 rounded-lg border border-app-border bg-app-surface px-2 text-xs text-tx-secondary">
            <option value="">全部年份</option>
            {availableYears.map((value) => <option key={value} value={value}>{value}年</option>)}
          </select>
          <select value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 rounded-lg border border-app-border bg-app-surface px-2 text-xs text-tx-secondary">
            <option value="">全部月份</option>
            {Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")).map((value) => <option key={value} value={value}>{value}月</option>)}
          </select>
          <select value={mood} onChange={(e) => setMood(e.target.value)} className="h-8 rounded-lg border border-app-border bg-app-surface px-2 text-xs text-tx-secondary">
            <option value="">全部心情</option>
            {MOODS.map(([value, emoji]) => <option key={value} value={value}>{emoji} {value}</option>)}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as JournalSort)} className="h-8 rounded-lg border border-app-border bg-app-surface px-2 text-xs text-tx-secondary">
            <option value="date_desc">日期 ↓</option>
            <option value="date_asc">日期 ↑</option>
            <option value="updated_desc">最近编辑</option>
            <option value="updated_asc">最早编辑</option>
          </select>
          <label className="col-span-1 text-[10px] text-tx-tertiary">从
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-8 w-full rounded-lg border border-app-border bg-app-surface px-2 text-xs text-tx-secondary" />
          </label>
          <label className="col-span-1 text-[10px] text-tx-tertiary">到
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-8 w-full rounded-lg border border-app-border bg-app-surface px-2 text-xs text-tx-secondary" />
          </label>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-accent-primary" /></div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-app-border px-3 py-6 text-center text-xs text-tx-tertiary">没有匹配的日记</div>
      ) : (
        <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
          {groups.map((group) => (
            <div key={group.year}>
              <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-tx-tertiary">
                <ChevronDown size={11} /> {group.year}年
              </div>
              <div className="space-y-2">
                {group.months.map((monthGroup) => (
                  <div key={monthGroup.month}>
                    <div className="mb-1 px-1 text-[10px] text-tx-tertiary">{monthGroup.month}月</div>
                    <div className="space-y-1">
                      {monthGroup.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => onSelectDate(item.journalDate)}
                          className={cn(
                            "w-full rounded-xl border px-3 py-2 text-left transition-colors",
                            selectedDate === item.journalDate
                              ? "border-accent-primary/40 bg-accent-primary/10"
                              : "border-transparent bg-app-hover/40 hover:border-app-border hover:bg-app-hover",
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <CalendarDays size={12} className="shrink-0 text-accent-primary" />
                            <span className="text-xs font-medium tabular-nums text-tx-primary">{item.journalDate}</span>
                            {item.moods.length > 0 && (
                              <span className="ml-auto text-xs" title={item.moods.join(", ")}>
                                {item.moods.slice(0, 3).map((value) => MOODS.find(([key]) => key === value)?.[1] || "💬").join("")}
                              </span>
                            )}
                          </div>
                          {(item.subtitle || item.preview) && (
                            <div className="mt-1 truncate pl-5 text-[11px] text-tx-secondary">{item.subtitle || item.preview}</div>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {hasMore && nextOffset !== null && (
            <button
              type="button"
              onClick={() => void load(nextOffset, true)}
              disabled={loadingMore}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-app-border px-3 py-2.5 text-xs font-medium text-tx-secondary hover:bg-app-hover disabled:opacity-60"
            >
              {loadingMore && <Loader2 size={12} className="animate-spin" />}
              {loadingMore ? "加载中…" : "加载更多"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
