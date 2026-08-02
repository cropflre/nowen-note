import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardPlus,
  FileText,
  Inbox,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  getTaskInbox,
  openTaskQuickCapture,
  publishTaskInboxChanged,
  removeTaskFromInbox,
  type TaskCaptureSourceType,
  type TaskInboxItem,
} from "@/lib/taskInboxApi";

interface TaskInboxPanelProps {
  onTaskMutated?: () => void;
  initiallyExpanded?: boolean;
  standalone?: boolean;
}

function dateText(task: TaskInboxItem, chinese: boolean): string | null {
  const value = task.dueAt || task.dueDate;
  if (!value) return null;
  const date = new Date(task.dueAt || `${task.dueDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return task.dueDate;
  return new Intl.DateTimeFormat(chinese ? "zh-CN" : undefined, {
    month: "short",
    day: "numeric",
    ...(task.dueAt ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date);
}

function capturedText(value: string, chinese: boolean): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.RelativeTimeFormat(chinese ? "zh-CN" : undefined, { numeric: "auto" })
    .format(Math.round((date.getTime() - Date.now()) / 3_600_000), "hour");
}

function SourceIcon({ type }: { type: TaskCaptureSourceType }) {
  if (type === "note") return <FileText size={11} />;
  if (type === "diary") return <MessageSquareText size={11} />;
  if (type === "selection") return <ClipboardPlus size={11} />;
  if (type === "global") return <Sparkles size={11} />;
  return <Inbox size={11} />;
}

export function TaskInboxPanel({ onTaskMutated, initiallyExpanded = false, standalone = false }: TaskInboxPanelProps) {
  const { i18n } = useTranslation();
  const chinese = i18n.language.toLowerCase().startsWith("zh");
  const [expanded, setExpanded] = useState(() => {
    if (initiallyExpanded || standalone) return true;
    try {
      return localStorage.getItem("nowen-task-inbox-expanded") !== "false";
    } catch {
      return true;
    }
  });
  const [items, setItems] = useState<TaskInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const labels = useMemo(() => chinese ? {
    title: "收集箱",
    subtitle: "先捕获，稍后再决定项目、日期和执行方式",
    capture: "快速捕获",
    refresh: "刷新",
    empty: "收集箱已清空",
    emptyHint: "在任意页面按 Ctrl/⌘ + Shift + A，或选中文本后快速创建待办。",
    organize: "整理完成",
    organizeHint: "移出收集箱，任务仍保留在全部任务中",
    complete: "完成任务",
    source: "来源",
    loadFailed: "加载收集箱失败",
    updateFailed: "更新收集箱失败",
    completeFailed: "完成任务失败",
    captured: "捕获",
    remaining: "条待整理",
  } : {
    title: "Inbox",
    subtitle: "Capture first, decide projects, dates and execution later",
    capture: "Quick capture",
    refresh: "Refresh",
    empty: "Inbox zero",
    emptyHint: "Press Ctrl/⌘ + Shift + A anywhere, or select text before capturing a task.",
    organize: "Organized",
    organizeHint: "Remove from Inbox; the task remains in All tasks",
    complete: "Complete task",
    source: "Source",
    loadFailed: "Failed to load Inbox",
    updateFailed: "Failed to update Inbox",
    completeFailed: "Failed to complete task",
    captured: "Captured",
    remaining: "to organize",
  }, [chinese]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const result = await getTaskInbox();
      setItems(result.items);
    } catch (error) {
      console.error("[TaskInbox] load failed", error);
      if (!silent) toast.error(labels.loadFailed);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [labels.loadFailed]);

  useEffect(() => {
    void load();
    const handleChanged = () => void load(true);
    const handleFocus = () => void load(true);
    window.addEventListener("nowen:task-inbox-changed", handleChanged);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("nowen:task-inbox-changed", handleChanged);
      window.removeEventListener("focus", handleFocus);
    };
  }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem("nowen-task-inbox-expanded", String(expanded));
    } catch {
      // Expansion remains session-local when storage is unavailable.
    }
  }, [expanded]);

  const organize = async (taskId: string) => {
    if (busyId) return;
    setBusyId(taskId);
    const previous = items;
    setItems((current) => current.filter((item) => item.id !== taskId));
    try {
      const result = await removeTaskFromInbox(taskId);
      publishTaskInboxChanged({ taskId, count: result.count });
    } catch (error) {
      console.error("[TaskInbox] organize failed", error);
      setItems(previous);
      toast.error(labels.updateFailed);
    } finally {
      setBusyId(null);
    }
  };

  const complete = async (taskId: string) => {
    if (busyId) return;
    setBusyId(taskId);
    const previous = items;
    setItems((current) => current.filter((item) => item.id !== taskId));
    try {
      await api.toggleTask(taskId);
      const result = await removeTaskFromInbox(taskId).catch(() => null);
      publishTaskInboxChanged({ taskId, count: result?.count });
      onTaskMutated?.();
    } catch (error) {
      console.error("[TaskInbox] complete failed", error);
      setItems(previous);
      toast.error(labels.completeFailed);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="shrink-0 border-b border-app-border bg-app-surface">
      <div className="flex items-center gap-3 px-4 py-2.5 md:px-5">
        <button
          type="button"
          onClick={() => { if (!standalone) setExpanded((value) => !value); }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Inbox size={17} />
            {items.length > 0 && (
              <span className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[9px] font-semibold leading-4 text-white">
                {items.length > 99 ? "99+" : items.length}
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold text-tx-primary">{labels.title}</span>
              {items.length > 0 && (
                <span className="text-[10px] text-tx-tertiary">{items.length} {labels.remaining}</span>
              )}
            </span>
            <span className="hidden truncate text-[11px] text-tx-tertiary sm:block">{labels.subtitle}</span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => openTaskQuickCapture({ sourceType: "manual" })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
        >
          <ClipboardPlus size={13} />
          <span className="hidden sm:inline">{labels.capture}</span>
        </button>
        <button
          type="button"
          onClick={() => void load()}
          title={labels.refresh}
          className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
        >
          <RefreshCw size={14} />
        </button>
        {!standalone && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="rounded-md p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-app-border/70 px-4 pb-3 pt-3 md:px-5">
          {loading ? (
            <div className="flex h-20 items-center justify-center text-tx-tertiary">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <button
              type="button"
              onClick={() => openTaskQuickCapture({ sourceType: "manual" })}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-app-border bg-app-bg px-4 py-6 text-center hover:border-amber-500/40 hover:bg-amber-500/[0.03]"
            >
              <CheckCircle2 size={22} className="text-emerald-500" />
              <span className="text-sm font-medium text-tx-primary">{labels.empty}</span>
              <span className="max-w-xl text-xs leading-5 text-tx-tertiary">{labels.emptyHint}</span>
            </button>
          ) : (
            <div className={cn("space-y-2 overflow-y-auto pr-1", initiallyExpanded || standalone ? "max-h-none" : "max-h-[300px]")}>
              {items.map((item) => {
                const due = dateText(item, chinese);
                const sourceTitle = item.captureSourceTitle
                  || (item.captureSourceType === "note" ? (chinese ? "笔记" : "Note")
                    : item.captureSourceType === "diary" ? (chinese ? "说说" : "Diary")
                      : item.captureSourceType === "selection" ? (chinese ? "选中文本" : "Selection")
                        : (chinese ? "快速捕获" : "Quick capture"));
                return (
                  <article key={item.id} className="group rounded-xl border border-app-border bg-app-bg p-3">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void complete(item.id)}
                        title={labels.complete}
                        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-app-border text-transparent transition-colors hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500 disabled:opacity-40"
                      >
                        {busyId === item.id ? <Loader2 size={11} className="animate-spin text-tx-tertiary" /> : <Check size={11} />}
                      </button>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-tx-primary">{item.title}</h3>
                          {item.priority === 3 && <span className="text-[10px] font-medium text-red-500">{chinese ? "高优先级" : "High"}</span>}
                          {due && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-app-elevated px-2 py-0.5 text-[10px] text-tx-secondary">
                              <CalendarDays size={10} /> {due}
                            </span>
                          )}
                        </div>

                        {item.captureExcerpt && item.captureExcerpt.trim() !== item.title.trim() && (
                          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-tx-tertiary">
                            {item.captureExcerpt}
                          </p>
                        )}

                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-tx-tertiary">
                          <span className="inline-flex min-w-0 items-center gap-1" title={`${labels.source}: ${sourceTitle}`}>
                            <SourceIcon type={item.captureSourceType} />
                            <span className="max-w-[200px] truncate">{sourceTitle}</span>
                          </span>
                          <span>{labels.captured} {capturedText(item.inboxAt, chinese)}</span>
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void organize(item.id)}
                        title={labels.organizeHint}
                        className={cn(
                          "shrink-0 rounded-lg border border-app-border px-2.5 py-1.5 text-[11px] text-tx-secondary transition-colors",
                          "hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-600 disabled:opacity-40",
                        )}
                      >
                        {labels.organize}
                      </button>
                    </div>
                  </article>
                );
              })}
              <p className="px-1 pt-1 text-[10px] text-tx-tertiary">{labels.organizeHint}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
