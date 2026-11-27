import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import {
  BookOpen,
  CalendarDays,
  Clock3,
  MessageCircle,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import DiaryCenterImpl from "@/components/DiaryCenterImpl";
import DiaryExperienceBridge from "@/components/diary/DiaryExperienceBridge";
import SayCalendarView from "@/components/diary/SayCalendarView";
import DailyJournalView from "@/components/daily-records/DailyJournalView";
import JournalPrivacyGate from "@/components/daily-records/JournalPrivacyGate";
import { getCurrentWorkspace, setCurrentWorkspace } from "@/lib/api";
import {
  formatCurrentTimestamp,
  loadDailyRecordsView,
  relativeLocalDateKey,
  saveDailyRecordsView,
  type DailyRecordsView,
} from "@/lib/dailyRecords";
import { resolveJournalScope, type JournalScope } from "@/lib/journalScope";
import { MOTION_SPRING } from "@/lib/motion";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import "@/components/daily-records/daily-records-mobile.css";

const VIEW_OPTIONS: Array<{
  key: DailyRecordsView;
  label: string;
  icon: LucideIcon;
  colorClass: string;
}> = [
  { key: "moments", label: "瞬间", icon: MessageCircle, colorClass: "text-violet-500 dark:text-violet-400" },
  { key: "calendar", label: "日历", icon: CalendarDays, colorClass: "text-fuchsia-500 dark:text-fuchsia-400" },
  { key: "journal", label: "日记", icon: BookOpen, colorClass: "text-sky-500 dark:text-sky-400" },
];

export default function DailyRecordsHub() {
  const { t } = useTranslation();
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
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg"
      data-daily-records-hub=""
    >
      <header
        className="relative shrink-0 overflow-hidden border-b border-app-border/75 bg-app-surface/80 px-0 pt-3 backdrop-blur-md sm:px-4 sm:pt-4 lg:px-6"
        data-daily-records-header=""
      >
        {/* 柔和极光背景装饰 */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-16 left-1/5 h-36 w-64 rounded-full bg-violet-400/12 blur-3xl dark:bg-violet-500/14" />
          <div className="absolute -top-14 right-1/4 h-36 w-64 rounded-full bg-pink-400/10 blur-3xl dark:bg-pink-500/12" />
          <div className="absolute -bottom-12 right-10 h-28 w-48 rounded-full bg-sky-400/8 blur-3xl dark:bg-sky-500/10" />
        </div>

        <div className="relative z-10 mx-auto w-full max-w-[1320px] px-4 sm:px-0">
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <motion.span
                whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
                transition={{ duration: 0.4 }}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/20 via-fuchsia-400/18 to-pink-500/20 text-violet-600 shadow-xs ring-1 ring-violet-500/20 dark:text-violet-300"
              >
                <Sparkles size={19} />
              </motion.span>
              <div className="min-w-0">
                <h1 className="text-lg font-bold tracking-tight text-tx-primary sm:text-xl">每日记录</h1>
                <p className="mt-0.5 text-xs text-tx-secondary">瞬间负责捕获，日记负责整理 ✨</p>
              </div>
            </div>

            <nav
              className="grid w-full grid-cols-3 items-center gap-1 rounded-2xl border border-app-border/75 bg-app-elevated/75 p-1 shadow-xs backdrop-blur-sm sm:flex sm:w-auto"
              aria-label="每日记录视图"
              data-daily-records-views=""
            >
              {VIEW_OPTIONS.map(({ key, label, icon: Icon, colorClass }) => {
                const active = view === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setView(key)}
                    className={cn(
                      "relative flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-xl px-2.5 text-xs transition-colors sm:min-h-8 sm:px-3.5 sm:py-1.5",
                      active
                        ? "font-semibold text-violet-600 dark:text-violet-300"
                        : "font-medium text-tx-secondary hover:text-tx-primary",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    {active && (
                      <motion.span
                        layoutId="daily-records-view-pill"
                        transition={MOTION_SPRING.snappy}
                        className="absolute inset-0 rounded-xl bg-app-surface shadow-xs ring-1 ring-violet-500/20"
                      />
                    )}
                    <Icon size={14} className={cn("relative z-10 shrink-0", active ? "text-violet-500 dark:text-violet-300" : colorClass)} />
                    <span className="relative z-10 truncate">{key === "calendar" ? t("diary.calendarTitle") : label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div
            className="mt-2.5 flex min-w-0 items-center gap-2 pb-2.5 sm:mt-3.5 sm:pb-3.5"
            data-daily-records-shortcuts=""
          >
            <div className="flex min-w-0 flex-1 snap-x snap-mandatory gap-1.5 overflow-x-auto px-0.5 py-1 -my-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-initial sm:gap-2" data-daily-records-shortcut-scroll="">
              <button
                type="button"
                onClick={() => selectJournalDate(relativeLocalDateKey(0))}
                className="flex min-h-9 shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-full border border-violet-400/35 bg-gradient-to-r from-violet-500/10 to-pink-500/10 px-3 py-1.5 text-xs font-semibold text-violet-700 shadow-xs transition-all hover:-translate-y-0.5 hover:from-violet-500/16 hover:to-pink-500/16 active:scale-95 sm:min-h-9 sm:px-3.5 dark:text-violet-300"
              >
                <BookOpen size={13} className="text-violet-500 dark:text-violet-300" />
                今天日记
              </button>
              <button
                type="button"
                onClick={() => void copyCurrentTime()}
                className="flex min-h-9 shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-full border border-app-border/80 bg-app-elevated/85 px-3 py-1.5 text-xs font-medium text-tx-secondary shadow-xs transition-all hover:-translate-y-0.5 hover:border-sky-400/45 hover:bg-app-surface hover:text-tx-primary active:scale-95 sm:min-h-9 sm:px-3.5"
              >
                <Clock3 size={13} className="text-sky-500 dark:text-sky-400" />
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
                  className="flex min-h-9 shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-full border border-app-border/80 bg-app-elevated/85 px-3 py-1.5 text-xs font-medium text-tx-secondary shadow-xs transition-all hover:-translate-y-0.5 hover:border-violet-400/40 hover:bg-app-surface hover:text-tx-primary active:scale-95 sm:min-h-9 sm:px-3.5"
                >
                  <CalendarDays size={13} className="text-fuchsia-500/80 dark:text-fuchsia-400" />
                  {item.label}
                </button>
              ))}
            </div>
            <label data-daily-records-date-picker="" className="relative flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-app-border/80 bg-app-elevated/85 px-3 py-1.5 text-xs font-medium text-tx-secondary shadow-xs transition-all hover:-translate-y-0.5 hover:border-violet-400/40 hover:bg-app-surface hover:text-tx-primary focus-within:ring-2 focus-within:ring-inset focus-within:ring-accent-primary/40 sm:min-h-9 sm:px-3.5">
              <CalendarDays size={13} className="text-amber-500 dark:text-amber-400" />
              {t("diary.selectJournalDate")}
              <input
                type="date"
                aria-label={t("diary.selectJournalDate")}
                value={selectedDate}
                onClick={(event) => {
                  try { event.currentTarget.showPicker?.(); }
                  catch { /* Keep the native indicator usable when the picker API is unavailable. */ }
                }}
                onChange={(event) => event.target.value && selectJournalDate(event.target.value)}
                // Keep the native focus target inside the visible shortcut so
                // touch focus cannot scroll the entire hub to an offscreen input.
                className="absolute inset-0 h-full min-w-0 w-full max-w-full cursor-pointer text-base opacity-0"
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
        <JournalPrivacyGate
          scope={journalScope}
          activeWorkspaceId={activeWorkspaceId}
          onUseWorkspace={() => {
            if (activeWorkspaceId) setJournalScope(resolveJournalScope(activeWorkspaceId));
          }}
        >
          <DailyJournalView
            selectedDate={selectedDate}
            onDateChange={setSelectedDate}
            onWriteMoment={() => {
              const targetWorkspace = journalScope.kind === "workspace"
                ? journalScope.workspaceId
                : "personal";
              if (getCurrentWorkspace() !== targetWorkspace) {
                setCurrentWorkspace(targetWorkspace);
                window.dispatchEvent(new CustomEvent("nowen:workspace-changed", {
                  detail: { workspaceId: targetWorkspace },
                }));
              }
              setView("moments");
            }}
            journalScope={journalScope}
            onJournalScopeChange={setJournalScope}
            activeWorkspaceId={activeWorkspaceId}
          />
        </JournalPrivacyGate>
      )}
    </div>
  );
}
