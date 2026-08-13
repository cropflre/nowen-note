import React, { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  Clock3,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";

import DiaryCenterImpl from "@/components/DiaryCenterImpl";
import DiaryExperienceBridge from "@/components/diary/DiaryExperienceBridge";
import SayCalendarView from "@/components/diary/SayCalendarView";
import DailyJournalView from "@/components/daily-records/DailyJournalView";
import { getCurrentWorkspace } from "@/lib/api";
import {
  formatCurrentTimestamp,
  loadDailyRecordsView,
  relativeLocalDateKey,
  saveDailyRecordsView,
  type DailyRecordsView,
} from "@/lib/dailyRecords";
import { resolveJournalScope, type JournalScope } from "@/lib/journalScope";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import "@/components/daily-records/daily-records-mobile.css";

const VIEW_OPTIONS: Array<{
  key: DailyRecordsView;
  label: string;
  icon: LucideIcon;
}> = [
  { key: "moments", label: "瞬间", icon: MessageCircle },
  { key: "calendar", label: "日历", icon: CalendarDays },
  { key: "journal", label: "日记", icon: BookOpen },
];

export default function DailyRecordsHub() {
  const [view, setViewState] = useState<DailyRecordsView>(() => loadDailyRecordsView());
  const [selectedDate, setSelectedDate] = useState(() => relativeLocalDateKey(0));
  const [workspaceId, setWorkspaceId] = useState(() => getCurrentWorkspace());
  const [journalScope, setJournalScope] = useState<JournalScope>(() => resolveJournalScope());
  const momentRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const syncWorkspace = () => {
      const nextWorkspace = getCurrentWorkspace();
      setWorkspaceId(nextWorkspace);
      setJournalScope(resolveJournalScope(nextWorkspace));
    };
    window.addEventListener("nowen:workspace-changed", syncWorkspace);
    return () => window.removeEventListener("nowen:workspace-changed", syncWorkspace);
  }, []);

  const setView = (next: DailyRecordsView) => {
    setViewState(next);
    saveDailyRecordsView(next);
  };

  const selectJournalDate = (dateKey: string) => {
    setSelectedDate(dateKey);
    setView("journal");
  };

  const copyCurrentTime = async () => {
    const value = formatCurrentTimestamp();
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`已复制 ${value}`);
    } catch {
      toast.info(value);
    }
  };

  const activeWorkspaceId = workspaceId && workspaceId !== "personal" ? workspaceId : null;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg"
      data-daily-records-hub=""
    >
      <header
        className="shrink-0 border-b border-app-border bg-app-surface/80 px-0 pt-3 backdrop-blur sm:px-4 sm:pt-4 lg:px-6"
        data-daily-records-header=""
      >
        <div className="mx-auto w-full max-w-[1320px] px-4 sm:px-0">
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight text-tx-primary">每日记录</h1>
              <p className="mt-0.5 text-xs text-tx-tertiary">瞬间负责捕获，日记负责整理</p>
            </div>
            <nav
              className="grid w-full grid-cols-3 items-center gap-1 rounded-xl bg-app-hover/60 p-1 sm:flex sm:w-auto"
              aria-label="每日记录视图"
              data-daily-records-views=""
            >
              {VIEW_OPTIONS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  className={cn(
                    "flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-all sm:min-h-0 sm:px-3 sm:py-1.5",
                    view === key
                      ? "bg-app-surface text-accent-primary shadow-sm"
                      : "text-tx-tertiary hover:text-tx-primary",
                  )}
                  aria-current={view === key ? "page" : undefined}
                >
                  <Icon size={14} className="shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div
            className="-mx-4 mt-3 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:mt-4 sm:px-0"
            data-daily-records-shortcuts=""
          >
            <button
              type="button"
              onClick={() => selectJournalDate(relativeLocalDateKey(0))}
              className="flex min-h-10 shrink-0 snap-start items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs font-medium text-tx-primary hover:border-accent-primary/40 hover:bg-app-hover"
            >
              <BookOpen size={14} className="text-accent-primary" />
              今天日记
            </button>
            <button
              type="button"
              onClick={() => void copyCurrentTime()}
              className="flex min-h-10 shrink-0 snap-start items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs text-tx-secondary hover:border-accent-primary/40 hover:bg-app-hover"
            >
              <Clock3 size={14} className="text-accent-primary" />
              现在
            </button>
            {[
              { label: "昨天", offset: -1 },
              { label: "今天", offset: 0 },
              { label: "明天", offset: 1 },
              { label: "后天", offset: 2 },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => selectJournalDate(relativeLocalDateKey(item.offset))}
                className="flex min-h-10 shrink-0 snap-start items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs text-tx-secondary hover:border-accent-primary/40 hover:bg-app-hover"
              >
                <CalendarDays size={14} className="text-accent-primary" />
                {item.label}
              </button>
            ))}
            <label className="flex min-h-10 shrink-0 snap-start cursor-pointer items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs text-tx-secondary hover:border-accent-primary/40 hover:bg-app-hover">
              <CalendarDays size={14} className="text-accent-primary" />
              选择日期
              <input
                type="date"
                value={selectedDate}
                onChange={(event) => event.target.value && selectJournalDate(event.target.value)}
                className="sr-only"
              />
            </label>
          </div>
        </div>
      </header>

      {view === "moments" && (
        <div
          ref={momentRootRef}
          className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
          data-daily-records-moments=""
        >
          <DiaryCenterImpl />
          <DiaryExperienceBridge rootRef={momentRootRef} />
        </div>
      )}

      {view === "calendar" && (
        <SayCalendarView
          onClose={() => setView("moments")}
          onWriteEntry={() => setView("moments")}
          onLocateItem={() => setView("moments")}
        />
      )}

      {view === "journal" && (
        <DailyJournalView
          selectedDate={selectedDate}
          onDateChange={setSelectedDate}
          onWriteMoment={() => setView("moments")}
          journalScope={journalScope}
          onJournalScopeChange={setJournalScope}
          activeWorkspaceId={activeWorkspaceId}
        />
      )}
    </div>
  );
}
