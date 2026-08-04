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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg" data-daily-records-hub="">
      <header className="shrink-0 border-b border-app-border bg-app-surface/80 px-4 pt-4 backdrop-blur lg:px-6">
        <div className="mx-auto w-full max-w-[1320px]">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-tx-primary">每日记录</h1>
              <p className="mt-0.5 text-xs text-tx-tertiary">瞬间负责捕获，日记负责整理</p>
            </div>
            <nav className="flex items-center gap-1 rounded-xl bg-app-hover/60 p-1" aria-label="每日记录视图">
              {VIEW_OPTIONS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
                    view === key
                      ? "bg-app-surface text-accent-primary shadow-sm"
                      : "text-tx-tertiary hover:text-tx-primary",
                  )}
                  aria-current={view === key ? "page" : undefined}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              type="button"
              onClick={() => selectJournalDate(relativeLocalDateKey(0))}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs font-medium text-tx-primary hover:border-accent-primary/40 hover:bg-app-hover"
            >
              <BookOpen size={14} className="text-accent-primary" />
              今天日记
            </button>
            <button
              type="button"
              onClick={() => void copyCurrentTime()}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs text-tx-secondary hover:border-accent-primary/40 hover:bg-app-hover"
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
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs text-tx-secondary hover:border-accent-primary/40 hover:bg-app-hover"
              >
                <CalendarDays size={14} className="text-accent-primary" />
                {item.label}
              </button>
            ))}
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs text-tx-secondary hover:border-accent-primary/40 hover:bg-app-hover">
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
        <div ref={momentRootRef} className="contents">
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
