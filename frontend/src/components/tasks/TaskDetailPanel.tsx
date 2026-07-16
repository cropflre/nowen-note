import React, { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Flag, Trash2, X, Bell, BellOff, CheckCircle2, Circle, Plus, Clock, Repeat, Link2, CalendarDays, Loader2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { zhCN, enUS } from "date-fns/locale";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { Task, TaskPriority, TaskReminder, TaskDependency } from "@/types";
import { isRepeatingTask } from "./taskRepeatUtils";
// TASK-RECURRENCE-LUNAR-01: 农历转换
import { solarToLunar, LUNAR_MONTH_NAMES, LUNAR_DAY_NAMES } from "./lunarUtils";
import { TaskAIBreakdown } from "./TaskAIBreakdown";
import { TaskTemplateEditor } from "./TaskTemplateEditor";
import { TaskDependencyEditor } from "./TaskDependencyEditor";
import { isTaskBlockedByDependency, getDependencyScheduleWarnings } from "./taskDependencyUtils";
import type { TaskTreeNode } from "./taskProgress";
import { calculateTaskProgress } from "./taskProgress";
import { insertTaskTitleSnippet, parseTaskTitle, TitleView } from "./taskTitleTokens";
import { buildDueAtFromDateAndTime, buildDueDatePatch, getDueTimeValue } from "./taskDateUtils";
import { buildCustomReminderOffset, sortRemindersByOffset } from "./taskReminderUtils";
import {
  buildCustomRepeatRule,
  parseStoredCustomRepeatRule,
  serializeCustomRepeatRule,
  type CustomRepeatCalendar,
  type CustomRepeatFrequency,
  type CustomRepeatRuleDraft,
} from "./customRepeatRule";

/** Shows a warning badge if notifications are not available */
function NotificationStatusBadge({ t }: { t: (key: string) => string }) {
  const desktop = (typeof window !== "undefined") ? (window as any).nowenDesktop : null;
  if (desktop?.taskNotify) {
    // Electron: native notifications always available
    return null;
  }
  if (typeof Notification === "undefined") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-500">
        {t("tasks.reminder.noPermission")}
      </span>
    );
  }
  if (Notification.permission === "denied") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-500">
        {t("tasks.reminder.permissionDenied")}
      </span>
    );
  }
  return null;
}

/* preset offset options (minutes) */
const PRESET_OFFSETS = [
  { minutes: 0, key: "atDue" },
  { minutes: 5, key: "before5min" },
  { minutes: 30, key: "before30min" },
  { minutes: 60, key: "before1hour" },
  { minutes: 1440, key: "before1day" },
] as const;

type RepeatEndMode = "never" | "date" | "count";

function getRepeatEndMode(task: Task): RepeatEndMode {
  if (task.repeatEndCount) return "count";
  if (task.repeatEndDate) return "date";
  return "never";
}

function normalizeRepeatEndCountInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(999, n));
}

const descriptionMarkdownComponents: Components = {
  h1: ({ children }) => <h1 className="mt-3 mb-2 text-lg font-semibold text-tx-primary">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-2 text-base font-semibold text-tx-primary">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold text-tx-primary">{children}</h3>,
  p: ({ children }) => <p className="my-2 leading-6">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-app-border pl-3 text-tx-secondary">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => (
    <code className={cn("rounded bg-app-elevated px-1 py-0.5 text-xs text-tx-primary", className)}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-app-elevated p-3 text-xs leading-5 text-tx-primary">
      {children}
    </pre>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-app-border bg-app-elevated px-2 py-1 text-left font-semibold text-tx-primary">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-app-border px-2 py-1 align-top">
      {children}
    </td>
  ),
  input: (props) => (
    <input {...props} className="mr-1.5 align-middle accent-accent-primary" disabled />
  ),
};

function TaskDescriptionMarkdownPreview({ description, placeholder }: { description: string; placeholder: string }) {
  if (!description.trim()) {
    return <span className="text-tx-tertiary">{placeholder}</span>;
  }

  return (
    <div className="min-w-0 max-w-full overflow-hidden break-words text-sm leading-6 text-tx-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={descriptionMarkdownComponents}
      >
        {description}
      </ReactMarkdown>
    </div>
  );
}

/* ===== Task Detail Panel ===== */
export const TaskDetailPanel = React.forwardRef<HTMLDivElement, {
  task: Task;
  treeNode?: TaskTreeNode | null;
  allTasks?: Task[];
  onClose: () => void;
  onUpdate: (id: string, data: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onToggle?: (id: string) => void;
  onSelectTask?: (taskId: string) => void;
  onCreated?: () => void;
  onReminderCountChange?: (taskId: string, activeCount: number) => void;
  dependencies?: TaskDependency[];
  onCreateDependency?: (predecessorTaskId: string, successorTaskId: string) => Promise<void>;
  onDeleteDependency?: (id: string) => Promise<void>;
}>(({ task, treeNode, allTasks, onClose, onUpdate, onDelete, onToggle, onSelectTask, onCreated, onReminderCountChange, dependencies = [], onCreateDependency, onDeleteDependency }, ref) => {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage || i18n.language;
  const isZh = lang.toLowerCase().startsWith("zh");
  const dateLocale = isZh ? zhCN : enUS;
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [descriptionMode, setDescriptionMode] = useState<"edit" | "preview">("edit");
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate || "");
  const [dueAt, setDueAt] = useState(getDueTimeValue(task.dueAt));
  const [startDate, setStartDate] = useState(task.startDate || "");
  const [repeatRule, setRepeatRule] = useState<"none" | "daily" | "weekly" | "monthly" | "yearly" | "custom">(task.repeatRule || "none");
  const [repeatInterval, setRepeatInterval] = useState(task.repeatInterval || 1);
  const [repeatEndDate, setRepeatEndDate] = useState(task.repeatEndDate || "");
  const [repeatEndMode, setRepeatEndMode] = useState<RepeatEndMode>(getRepeatEndMode(task));
  const [repeatEndCount, setRepeatEndCount] = useState(task.repeatEndCount ? String(task.repeatEndCount) : "");
  // TASK-RECURRENCE-CUSTOM-01: 自定义循环规则
  const existingRuleJson = parseStoredCustomRepeatRule(task.repeatRuleJson);
  const [customFrequency, setCustomFrequency] = useState<CustomRepeatFrequency>(existingRuleJson.frequency);
  const [customInterval, setCustomInterval] = useState<number>(existingRuleJson.interval);
  const [customWeekdays, setCustomWeekdays] = useState<number[]>(existingRuleJson.weekdays);
  const [customMonthDay, setCustomMonthDay] = useState<number>(existingRuleJson.monthDay);
  const [customYearMonth, setCustomYearMonth] = useState<number>(existingRuleJson.yearMonth);
  const [customYearDay, setCustomYearDay] = useState<number>(existingRuleJson.yearDay);
  // TASK-RECURRENCE-LUNAR-01
  const [customCalendar, setCustomCalendar] = useState<CustomRepeatCalendar>(existingRuleJson.calendar);
  const [customLunarMonth, setCustomLunarMonth] = useState<number>(existingRuleJson.lunarMonth);
  const [customLunarDay, setCustomLunarDay] = useState<number>(existingRuleJson.lunarDay);
  const [uploadingTitleAttachment, setUploadingTitleAttachment] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // date range validation error
  const [dateError, setDateError] = useState<string | null>(null);

  // reminder state
  const [reminders, setReminders] = useState<TaskReminder[]>([]);
  const [remindersLoading, setRemindersLoading] = useState(false);
  const [showAddReminder, setShowAddReminder] = useState(false);
  const [customReminder, setCustomReminder] = useState({ days: 0, hours: 0, minutes: 10 });

  const PRIORITY_CONFIG: Record<number, { label: string; color: string; flagClass: string }> = {
    3: { label: t("tasks.high"), color: "text-red-500", flagClass: "text-red-500" },
    2: { label: t("tasks.medium"), color: "text-amber-500", flagClass: "text-amber-500" },
    1: { label: t("tasks.low"), color: "text-blue-400", flagClass: "text-blue-400" },
  };

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setPriority(task.priority);
    setDueDate(task.dueDate || "");
    setDueAt(getDueTimeValue(task.dueAt));
    setStartDate(task.startDate || "");
    setRepeatRule(task.repeatRule || "none");
    setRepeatInterval(task.repeatInterval || 1);
    setRepeatEndDate(task.repeatEndDate || "");
    setRepeatEndMode(getRepeatEndMode(task));
    setRepeatEndCount(task.repeatEndCount ? String(task.repeatEndCount) : "");
    const rj = parseStoredCustomRepeatRule(task.repeatRuleJson);
    setCustomFrequency(rj.frequency);
    setCustomInterval(rj.interval);
    setCustomWeekdays(rj.weekdays);
    setCustomMonthDay(rj.monthDay);
    setCustomYearMonth(rj.yearMonth);
    setCustomYearDay(rj.yearDay);
    setCustomCalendar(rj.calendar);
    setCustomLunarMonth(rj.lunarMonth);
    setCustomLunarDay(rj.lunarDay);
  }, [
    task.id,
    task.repeatRule,
    task.repeatInterval,
    task.repeatEndDate,
    task.repeatEndCount,
    task.repeatRuleJson,
  ]);

  // load reminders for this task
  const loadReminders = useCallback(async () => {
    setRemindersLoading(true);
    try {
      const data = await api.getTaskReminders(task.id);
      setReminders(data);
      onReminderCountChange?.(task.id, data.filter((r) => r.enabled === 1).length);
    } catch {
      // ignore
    } finally {
      setRemindersLoading(false);
    }
  }, [task.id, onReminderCountChange]);

  useEffect(() => { loadReminders(); }, [loadReminders]);

  const handleSave = () => {
    onUpdate(task.id, {
      title: title.trim() || task.title,
      priority,
      dueDate: dueDate || null,
      dueAt: buildDueAtFromDateAndTime(dueDate, dueAt),
      startDate: startDate || null,
    });
  };

  const handleDescriptionSave = () => {
    if (description === (task.description ?? "")) return;
    onUpdate(task.id, { description });
  };

  const handleDescriptionModeChange = (mode: "edit" | "preview") => {
    if (mode === "preview") handleDescriptionSave();
    setDescriptionMode(mode);
  };

  const handleTitlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (!files.length) return;

    e.preventDefault();
    setUploadingTitleAttachment(true);
    let nextTitle = title;
    let nextCaret = titleRef.current?.selectionStart ?? title.length;
    try {
      for (const file of files) {
        if (file.size > 50 * 1024 * 1024) {
          toast.error(t("tasks.imageTooLarge"));
          continue;
        }
        const res = await api.taskAttachments.upload(file, task.id);
        const snippet = `![${res.filename}](${res.url})`;
        nextTitle = insertTaskTitleSnippet(nextTitle, snippet, nextCaret, nextCaret);
        nextCaret += snippet.length;
      }
      if (nextTitle !== title) {
        setTitle(nextTitle);
        onUpdate(task.id, { title: nextTitle.trim() || task.title });
        requestAnimationFrame(() => {
          titleRef.current?.focus();
          titleRef.current?.setSelectionRange(nextCaret, nextCaret);
        });
      }
    } catch (err: any) {
      toast.error(err?.message || t("tasks.uploadFailed"));
    } finally {
      setUploadingTitleAttachment(false);
    }
  };

  const hasRichTokens = parseTaskTitle(task.title).some((tok) => tok.kind !== "text");
  const progressInfo = treeNode ? calculateTaskProgress(treeNode) : null;

  const children = allTasks
    ? allTasks.filter((t) => t.parentId === task.id)
    : [];

  const hasDeadline = !!(task.dueDate || task.dueAt);

  const emitReminderCount = useCallback((nextReminders: TaskReminder[]) => {
    onReminderCountChange?.(task.id, nextReminders.filter((r) => r.enabled === 1).length);
  }, [onReminderCountChange, task.id]);

  const currentCustomRepeatDraft = (): CustomRepeatRuleDraft => ({
    calendar: customCalendar,
    frequency: customFrequency,
    interval: customInterval,
    weekdays: customWeekdays,
    monthDay: customMonthDay,
    yearMonth: customYearMonth,
    yearDay: customYearDay,
    lunarMonth: customLunarMonth,
    lunarDay: customLunarDay,
  });

  // Always pass the value from the current event as an override. React state updates are async;
  // rebuilding only from state here would submit the previous value (for example 9 instead of 3).
  const buildRepeatRuleJson = (overrides: Partial<CustomRepeatRuleDraft> = {}) => (
    buildCustomRepeatRule(currentCustomRepeatDraft(), overrides)
  );
  const pushRepeatJson = (overrides: Partial<CustomRepeatRuleDraft> = {}) => onUpdate(task.id, {
    repeatRuleJson: serializeCustomRepeatRule(buildRepeatRuleJson(overrides)),
  });

  // reminder handlers
  const handleAddReminder = async (offsetMinutes: number) => {
    try {
      const r = await api.createTaskReminder(task.id, offsetMinutes);
      setReminders((prev) => {
        const next = sortRemindersByOffset([...prev, r]);
        emitReminderCount(next);
        return next;
      });
      setShowAddReminder(false);
    } catch (err) {
      console.error("Failed to create reminder:", err);
    }
  };

  const customOffset = buildCustomReminderOffset(customReminder);
  const customReminderExists = customOffset !== null && reminders.some((r) => r.offsetMinutes === customOffset);

  const handleToggleReminder = async (reminderId: string, enabled: boolean) => {
    setReminders((prev) => {
      const next = prev.map((r) => r.id === reminderId ? { ...r, enabled: enabled ? 1 : 0 } : r);
      emitReminderCount(next);
      return next;
    });
    try {
      await api.updateTaskReminder(reminderId, { enabled });
    } catch { loadReminders(); }
  };

  const handleDeleteReminder = async (reminderId: string) => {
    setReminders((prev) => {
      const next = prev.filter((r) => r.id !== reminderId);
      emitReminderCount(next);
      return next;
    });
    try {
      await api.deleteTaskReminder(reminderId);
    } catch { loadReminders(); }
  };

  // test notification
  const handleTestNotification = async () => {
    const desktop = (window as any).nowenDesktop;
    if (desktop?.taskNotify) {
      await desktop.taskNotify(t("tasks.reminder.title"), t("tasks.reminder.testBody"));
    } else if ("Notification" in window) {
      if (Notification.permission === "granted") {
        new Notification(t("tasks.reminder.title"), { body: t("tasks.reminder.testBody") });
      } else if (Notification.permission !== "denied") {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          new Notification(t("tasks.reminder.title"), { body: t("tasks.reminder.testBody") });
        }
      }
    }
  };

  return (
    <div
      ref={ref}
      className={cn(
        "h-full border-l border-app-border bg-app-surface flex flex-col shrink-0",
        "fixed inset-0 z-30 w-full border-l-0",
        "md:static md:z-auto md:w-[380px] md:min-w-[380px] md:border-l"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-app-border" style={{ paddingTop: "calc(var(--safe-area-top) + 4px)" }}>
        <span className="text-sm font-semibold text-tx-primary">{t("tasks.taskDetail")}</span>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover transition-colors">
          <X size={16} className="text-tx-secondary" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Title */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t("tasks.taskTitle")}</label>
          <div className="relative">
            <textarea
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleSave}
              onPaste={handleTitlePaste}
              rows={Math.min(4, Math.max(2, title.split("\n").length))}
              className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors resize-y font-mono"
            />
            {uploadingTitleAttachment && (
              <Loader2 size={14} className="absolute right-2 top-2 animate-spin text-accent-primary" />
            )}
          </div>
          {hasRichTokens && (
            <div className="mt-2 px-3 py-2 rounded-md bg-app-elevated border border-app-border text-sm text-tx-primary leading-relaxed break-all">
              <TitleView title={title} compact={false} isCompleted={task.isCompleted === 1} />
            </div>
          )}
        </div>

        {/* Description */}
        <div>
          <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0">
              <label className="block text-xs text-tx-tertiary uppercase tracking-wider">{t("tasks.fields.description")}</label>
              <span className="text-[10px] text-tx-tertiary">{t("tasks.descriptionMarkdownHint")}</span>
            </div>
            <div className="flex shrink-0 overflow-hidden rounded-md border border-app-border bg-app-bg">
              {(["edit", "preview"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleDescriptionModeChange(mode)}
                  className={cn(
                    "px-2.5 py-1 text-[11px] font-medium transition-colors",
                    descriptionMode === mode
                      ? "bg-accent-primary text-white"
                      : "text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
                  )}
                >
                  {t(`tasks.descriptionMode.${mode}`)}
                </button>
              ))}
            </div>
          </div>
          {descriptionMode === "edit" ? (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={handleDescriptionSave}
              placeholder={t("tasks.fields.descriptionPlaceholder")}
              rows={4}
              className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary placeholder:text-tx-tertiary focus:outline-none focus:border-accent-primary transition-colors resize-y"
            />
          ) : (
            <div className="min-h-[104px] w-full overflow-hidden rounded-md border border-app-border bg-app-bg px-3 py-2">
              <TaskDescriptionMarkdownPreview
                description={description}
                placeholder={t("tasks.fields.descriptionPlaceholder")}
              />
            </div>
          )}
        </div>

        {/* Priority */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t("tasks.priority")}</label>
          <div className="flex gap-2">
            {([3, 2, 1] as TaskPriority[]).map((p) => {
              const cfg = PRIORITY_CONFIG[p];
              return (
                <button
                  key={p}
                  onClick={() => { setPriority(p); onUpdate(task.id, { priority: p }); }}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-all",
                    priority === p
                      ? `${cfg.color} border-current bg-current/10`
                      : "text-tx-tertiary border-app-border hover:border-tx-tertiary"
                  )}
                >
                  <Flag size={12} />
                  {cfg.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Start Date */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t("tasks.startDate")}</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              const newVal = e.target.value;
              setStartDate(newVal);
              if (newVal && dueDate && newVal > dueDate) {
                setDateError(t("tasks.gantt.invalidDateRange"));
                return;
              }
              setDateError(null);
              onUpdate(task.id, { startDate: newVal || null });
            }}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
          />
        </div>

        {/* Due Date */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t("tasks.dueDate")}</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => {
              const newVal = e.target.value;
              setDueDate(newVal);
              if (!newVal) {
                setDueAt("");
                if (repeatRule !== "none") {
                  setRepeatRule("none");
                  setRepeatInterval(1);
                  setRepeatEndDate("");
                  setRepeatEndMode("never");
                  setRepeatEndCount("");
                }
                setDateError(null);
                onUpdate(task.id, buildDueDatePatch(task, newVal));
                return;
              }
              if (startDate && newVal && startDate > newVal) {
                setDateError(t("tasks.gantt.invalidDateRange"));
                return;
              }
              setDateError(null);
              onUpdate(task.id, buildDueDatePatch({ ...task, dueAt: buildDueAtFromDateAndTime(dueDate, dueAt) }, newVal));
            }}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
          />
        </div>

        {dateError && (
          <p className="text-xs text-red-500 -mt-1 mb-1">{dateError}</p>
        )}

        {/* Due At (time) */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t("tasks.dueAt")}</label>
          <input
            type="time"
            value={dueAt}
            disabled={!dueDate}
            onChange={(e) => {
              const nextTime = e.target.value;
              setDueAt(nextTime);
              onUpdate(task.id, { dueAt: buildDueAtFromDateAndTime(dueDate, nextTime) });
            }}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>

        {/* Created At */}
        <div className="text-xs text-tx-tertiary">
          {t("tasks.createdAt")}: {task.createdAt ? format(parseISO(task.createdAt), "yyyy-MM-dd HH:mm", { locale: dateLocale }) : "-"}
        </div>

        {/* Progress Section */}
        <div className="rounded-lg border border-app-border bg-app-elevated/50 p-4 space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <Clock size={14} className="text-tx-tertiary" />
            <span className="text-xs text-tx-tertiary uppercase tracking-wider font-medium">
              {t("tasks.progress.title")}
            </span>
          </div>

          {progressInfo ? (
            <>
              <div className="flex items-center gap-3">
                <span className="text-2xl font-bold text-accent-primary">
                  {progressInfo.progress}%
                </span>
                <div className="flex-1 h-2 rounded-full bg-app-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent-primary transition-all duration-500"
                    style={{ width: `${progressInfo.progress}%` }}
                  />
                </div>
              </div>
              <div className="text-xs text-tx-secondary">
                {t("tasks.progress.childrenStats", {
                  completed: progressInfo.completedChildren,
                  total: progressInfo.totalChildren,
                })}
              </div>
            </>
          ) : (
            <div className="text-sm text-tx-tertiary">
              {task.isCompleted === 1
                ? t("tasks.progress.completed")
                : t("tasks.progress.inProgress")}
            </div>
          )}

          {task.dueDate && (
            <div className="text-xs text-tx-tertiary">
              {t("tasks.progress.dueLabel")}: {format(parseISO(task.dueDate), isZh ? "yyyy年M月d日" : "MMM d, yyyy", { locale: dateLocale })}
            </div>
          )}
        </div>

        {/* Subtask list */}
        {children.length > 0 && (
          <div className="rounded-lg border border-app-border bg-app-elevated/50 p-4 space-y-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-tx-tertiary uppercase tracking-wider font-medium">
                {t("tasks.subtasks")}
              </span>
              <span className="text-[10px] text-tx-tertiary">
                {children.filter((c) => c.isCompleted === 1).length}/{children.length}
              </span>
            </div>
            <div className="space-y-1">
              {children.map((child) => {
                const childPri = PRIORITY_CONFIG[child.priority] || PRIORITY_CONFIG[2];
                return (
                  <div
                    key={child.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-app-hover transition-colors cursor-pointer"
                    onClick={() => onSelectTask?.(child.id)}
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); onToggle?.(child.id); }}
                      className="flex-shrink-0"
                    >
                      {child.isCompleted === 1 ? (
                        <CheckCircle2 size={14} className="text-indigo-500" />
                      ) : (
                        <Circle size={14} className="text-tx-tertiary" />
                      )}
                    </button>
                    <span className={cn(
                      "flex-1 min-w-0 text-xs truncate",
                      child.isCompleted === 1 ? "line-through text-tx-tertiary" : "text-tx-primary"
                    )}>
                      {child.title.length > 30 ? child.title.slice(0, 30) + "..." : child.title}
                    </span>
                    <Flag size={10} className={childPri.flagClass} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* AI Breakdown */}
        <TaskAIBreakdown task={task} onCreated={() => onCreated?.()} />

        {/* Save as Template */}
        <TaskTemplateEditor task={task} allTasks={allTasks} onSaved={() => {}} />

        {/* Repeat Settings */}
        <div className="rounded-lg border border-app-border bg-app-elevated/50 p-4 space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <Repeat size={14} className="text-tx-tertiary" />
            <span className="text-xs text-tx-tertiary uppercase tracking-wider font-medium">
              {t("tasks.repeat.title")}
            </span>
          </div>

          {/* Dependencies */}
          {onCreateDependency && onDeleteDependency && allTasks && (
            <div className="border-t border-app-border pt-3 mt-3">
              {isTaskBlockedByDependency(task.id, dependencies, allTasks || []) && !task.isCompleted && (
                <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 rounded px-2 py-1.5 mb-2">
                  <Link2 size={12} />
                  {t("tasks.dependencies.blockedByIncomplete")}
                </div>
              )}
              {(() => {
                const warning = getDependencyScheduleWarnings(task.id, dependencies, allTasks || []);
                if (!warning || !warning.suggestedStartDate) return null;
                return (
                  <div className="flex items-start gap-2 text-xs text-blue-600 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-400 rounded px-2 py-1.5 mb-2">
                    <CalendarDays size={12} className="mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <div>{t("tasks.dependencies.scheduleWarning", { date: warning.suggestedDueDate || warning.suggestedStartDate })}</div>
                      <button
                        onClick={() => {
                          const patch: any = {};
                          if (warning.suggestedStartDate) patch.startDate = warning.suggestedStartDate;
                          if (warning.suggestedDueDate) patch.dueDate = warning.suggestedDueDate;
                          onUpdate(task.id, patch);
                        }}
                        className="mt-1 px-2 py-0.5 text-[11px] rounded bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 dark:text-blue-400"
                      >
                        {t("tasks.dependencies.applySuggestion")}
                      </button>
                    </div>
                  </div>
                );
              })()}
              <TaskDependencyEditor
                task={task}
                allTasks={allTasks}
                dependencies={dependencies}
                onCreateDependency={onCreateDependency}
                onDeleteDependency={onDeleteDependency}
              />
            </div>
          )}
          <select
            value={repeatRule}
            onChange={(e) => {
              const rule = e.target.value as "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";
              setRepeatRule(rule);
              if (rule === "none") {
                setRepeatEndMode("never");
                setRepeatEndDate("");
                setRepeatEndCount("");
                onUpdate(task.id, { repeatRule: "none", repeatInterval: 1, repeatEndDate: null, repeatEndCount: null, repeatRuleJson: null });
              } else if (rule === "custom") {
                onUpdate(task.id, {
                  repeatRule: "custom",
                  repeatRuleJson: serializeCustomRepeatRule(buildRepeatRuleJson()),
                  repeatEndDate: repeatEndMode === "date" ? repeatEndDate || null : null,
                  repeatEndCount: repeatEndMode === "count" ? normalizeRepeatEndCountInput(repeatEndCount) : null,
                });
              } else {
                onUpdate(task.id, {
                  repeatRule: rule,
                  repeatInterval,
                  repeatEndDate: repeatEndMode === "date" ? repeatEndDate || null : null,
                  repeatEndCount: repeatEndMode === "count" ? normalizeRepeatEndCountInput(repeatEndCount) : null,
                  repeatRuleJson: null,
                });
              }
            }}
            disabled={!hasDeadline}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="none">{t("tasks.repeat.none")}</option>
            <option value="daily">{t("tasks.repeat.daily")}</option>
            <option value="weekly">{t("tasks.repeat.weekly")}</option>
            <option value="monthly">{t("tasks.repeat.monthly")}</option>
            <option value="yearly">{t("tasks.repeat.yearly")}</option>
            <option value="custom">{t("tasks.repeat.custom", { defaultValue: "自定义" })}</option>
          </select>
          {!hasDeadline && repeatRule === "none" && (
            <p className="text-[10px] text-tx-tertiary">{t("tasks.repeat.needDueDate")}</p>
          )}
          {/* 简单循环：间隔 */}
          {repeatRule !== "none" && repeatRule !== "custom" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-tx-secondary">{t("tasks.repeat.every")}</span>
              <input
                type="number"
                min={1}
                value={repeatInterval}
                onChange={(e) => {
                  const val = Math.max(1, parseInt(e.target.value) || 1);
                  setRepeatInterval(val);
                  onUpdate(task.id, { repeatInterval: val });
                }}
                className="w-16 px-2 py-1 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary text-center focus:outline-none focus:border-accent-primary"
              />
              <span className="text-xs text-tx-secondary">
                {repeatRule === "daily" ? t("tasks.repeat.days") :
                 repeatRule === "weekly" ? t("tasks.repeat.weeks") :
                 repeatRule === "monthly" ? t("tasks.repeat.months") :
                 t("tasks.repeat.years")}
              </span>
            </div>
          )}
          {/* TASK-RECURRENCE-CUSTOM-01: 自定义循环表单 */}
          {/* TASK-RECURRENCE-LUNAR-01: 支持农历日历切换 */}
          {repeatRule === "custom" && (
            <div className="space-y-2 p-2 rounded-lg bg-app-bg/50 border border-app-border/50">
              {/* 日历类型切换 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-tx-secondary">{t("tasks.repeat.calendar", { defaultValue: "日历" })}</span>
                <select value={customCalendar}
                  onChange={(e) => {
                    const calendar = e.target.value as CustomRepeatCalendar;
                    setCustomCalendar(calendar);
                    const overrides: Partial<CustomRepeatRuleDraft> = { calendar };
                    if (calendar === "lunar" && task.dueDate) {
                      try {
                        const lunar = solarToLunar(task.dueDate);
                        setCustomLunarMonth(lunar.lunarMonth);
                        setCustomLunarDay(lunar.lunarDay);
                        overrides.lunarMonth = lunar.lunarMonth;
                        overrides.lunarDay = lunar.lunarDay;
                      } catch { /* ignore */ }
                    }
                    pushRepeatJson(overrides);
                  }}
                  className="px-2 py-1 rounded-md bg-app-surface border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary">
                  <option value="gregorian">{t("tasks.repeat.gregorian", { defaultValue: "公历" })}</option>
                  <option value="lunar">{t("tasks.repeat.lunar", { defaultValue: "农历" })}</option>
                </select>
              </div>
              {/* 间隔 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-tx-secondary">{t("tasks.repeat.every", { defaultValue: "每" })}</span>
                <input type="number" min={1} value={customInterval}
                  onChange={(e) => {
                    const interval = Math.max(1, parseInt(e.target.value) || 1);
                    setCustomInterval(interval);
                    pushRepeatJson({ interval });
                  }}
                  className="w-16 px-2 py-1 rounded-md bg-app-surface border border-app-border text-sm text-tx-primary text-center focus:outline-none focus:border-accent-primary" />
                {customCalendar === "lunar" ? (
                  <span className="text-xs text-tx-secondary">{t("tasks.repeat.lunarYears", { defaultValue: "个农历年" })}</span>
                ) : (
                  <select value={customFrequency}
                    onChange={(e) => {
                      const frequency = e.target.value as CustomRepeatFrequency;
                      setCustomFrequency(frequency);
                      pushRepeatJson({ frequency });
                    }}
                    className="px-2 py-1 rounded-md bg-app-surface border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary">
                    <option value="day">{t("tasks.repeat.days", { defaultValue: "天" })}</option>
                    <option value="week">{t("tasks.repeat.weeks", { defaultValue: "周" })}</option>
                    <option value="month">{t("tasks.repeat.months", { defaultValue: "月" })}</option>
                    <option value="year">{t("tasks.repeat.years", { defaultValue: "年" })}</option>
                  </select>
                )}
              </div>
              {/* === 公历子选项 === */}
              {customCalendar === "gregorian" && customFrequency === "week" && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-[11px] text-tx-tertiary mr-1">{t("tasks.repeat.onDays", { defaultValue: "重复于" })}:</span>
                  {["日", "一", "二", "三", "四", "五", "六"].map((label, i) => (
                    <button key={i} type="button"
                      onClick={() => {
                        const weekdays = customWeekdays.includes(i)
                          ? customWeekdays.filter((d) => d !== i)
                          : [...customWeekdays, i];
                        const normalizedWeekdays = [...new Set(weekdays)].sort((a, b) => a - b);
                        setCustomWeekdays(normalizedWeekdays);
                        pushRepeatJson({ weekdays: normalizedWeekdays });
                      }}
                      className={cn("w-7 h-7 rounded-full text-[11px] font-medium transition-colors",
                        customWeekdays.includes(i) ? "bg-accent-primary text-white" : "bg-app-surface border border-app-border text-tx-secondary hover:bg-app-hover")}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {customCalendar === "gregorian" && customFrequency === "month" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-tx-secondary">{t("tasks.repeat.monthlyDay", { defaultValue: "每月第" })}</span>
                  <input type="number" min={1} max={31} value={customMonthDay}
                    onChange={(e) => {
                      const monthDay = Math.max(1, Math.min(31, parseInt(e.target.value) || 1));
                      setCustomMonthDay(monthDay);
                      pushRepeatJson({ monthDay });
                    }}
                    className="w-16 px-2 py-1 rounded-md bg-app-surface border border-app-border text-sm text-tx-primary text-center focus:outline-none focus:border-accent-primary" />
                  <span className="text-xs text-tx-secondary">{t("tasks.repeat.day", { defaultValue: "日" })}</span>
                </div>
              )}
              {customCalendar === "gregorian" && customFrequency === "year" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-tx-secondary">{t("tasks.repeat.yearlyDate", { defaultValue: "每年" })}</span>
                  <input type="number" min={1} max={12} value={customYearMonth}
                    onChange={(e) => {
                      const yearMonth = Math.max(1, Math.min(12, parseInt(e.target.value) || 1));
                      setCustomYearMonth(yearMonth);
                      pushRepeatJson({ yearMonth });
                    }}
                    className="w-14 px-2 py-1 rounded-md bg-app-surface border border-app-border text-sm text-tx-primary text-center focus:outline-none focus:border-accent-primary" />
                  <span className="text-xs text-tx-secondary">{t("tasks.repeat.month", { defaultValue: "月" })}</span>
                  <input type="number" min={1} max={31} value={customYearDay}
                    onChange={(e) => {
                      const yearDay = Math.max(1, Math.min(31, parseInt(e.target.value) || 1));
                      setCustomYearDay(yearDay);
                      pushRepeatJson({ yearDay });
                    }}
                    className="w-14 px-2 py-1 rounded-md bg-app-surface border border-app-border text-sm text-tx-primary text-center focus:outline-none focus:border-accent-primary" />
                  <span className="text-xs text-tx-secondary">{t("tasks.repeat.day", { defaultValue: "日" })}</span>
                </div>
              )}
              {/* === 农历子选项 === */}
              {customCalendar === "lunar" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-tx-secondary">{t("tasks.repeat.lunarDate", { defaultValue: "农历" })}</span>
                  <select value={customLunarMonth}
                    onChange={(e) => {
                      const lunarMonth = parseInt(e.target.value);
                      setCustomLunarMonth(lunarMonth);
                      pushRepeatJson({ lunarMonth });
                    }}
                    className="px-2 py-1 rounded-md bg-app-surface border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary">
                    {LUNAR_MONTH_NAMES.map((name, i) => (
                      <option key={i + 1} value={i + 1}>{name}</option>
                    ))}
                  </select>
                  <select value={customLunarDay}
                    onChange={(e) => {
                      const lunarDay = parseInt(e.target.value);
                      setCustomLunarDay(lunarDay);
                      pushRepeatJson({ lunarDay });
                    }}
                    className="px-2 py-1 rounded-md bg-app-surface border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary">
                    {LUNAR_DAY_NAMES.map((name, i) => (
                      <option key={i + 1} value={i + 1}>{name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
          {repeatRule !== "none" && (
            <div className="space-y-2">
              <label className="text-xs text-tx-tertiary mb-1 block">{t("tasks.repeat.endCondition")}</label>
              <div className="grid grid-cols-3 rounded-md border border-app-border bg-app-bg p-0.5">
                {(["never", "date", "count"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setRepeatEndMode(mode);
                      if (mode === "never") {
                        setRepeatEndDate("");
                        setRepeatEndCount("");
                        onUpdate(task.id, { repeatEndDate: null, repeatEndCount: null });
                      } else if (mode === "date") {
                        setRepeatEndCount("");
                        onUpdate(task.id, { repeatEndDate: repeatEndDate || null, repeatEndCount: null });
                      } else {
                        setRepeatEndDate("");
                        onUpdate(task.id, { repeatEndDate: null, repeatEndCount: normalizeRepeatEndCountInput(repeatEndCount) });
                      }
                    }}
                    className={cn(
                      "rounded px-2 py-1.5 text-xs font-medium transition-colors",
                      repeatEndMode === mode
                        ? "bg-accent-primary text-white"
                        : "text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
                    )}
                  >
                    {mode === "never"
                      ? t("tasks.repeat.endNever")
                      : mode === "date"
                        ? t("tasks.repeat.endByDate")
                        : t("tasks.repeat.endByCount")}
                  </button>
                ))}
              </div>
              {repeatEndMode === "date" && (
                <input
                  type="date"
                  value={repeatEndDate}
                  onChange={(e) => {
                    setRepeatEndDate(e.target.value);
                    onUpdate(task.id, { repeatEndDate: e.target.value || null, repeatEndCount: null });
                  }}
                  className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
                />
              )}
              {repeatEndMode === "count" && (
                <div className="space-y-1">
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={repeatEndCount}
                    placeholder={t("tasks.repeat.endCountPlaceholder")}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const count = normalizeRepeatEndCountInput(raw);
                      const nextValue = count === null ? "" : String(count);
                      setRepeatEndCount(nextValue);
                      onUpdate(task.id, { repeatEndDate: null, repeatEndCount: count });
                    }}
                    className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
                  />
                  <p className="text-[10px] text-tx-tertiary">{t("tasks.repeat.endCountHint")}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ===== Reminder Section (functional) ===== */}
        <div className="rounded-lg border border-app-border bg-app-elevated/50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Bell size={14} className="text-tx-tertiary" />
            <span className="text-xs text-tx-tertiary uppercase tracking-wider font-medium">
              {t("tasks.reminder.title")}
            </span>
            {/* test notification button */}
            <NotificationStatusBadge t={t} />
            <button
              onClick={handleTestNotification}
              className="ml-auto text-[10px] px-2 py-0.5 rounded-full border border-app-border text-tx-tertiary hover:text-accent-primary hover:border-accent-primary/30 transition-colors"
              title={t("tasks.reminder.testNotification")}
            >
              {t("tasks.reminder.testNotification")}
            </button>
          </div>

          {!hasDeadline ? (
            <p className="text-xs text-tx-tertiary">{t("tasks.reminder.needDueDate")}</p>
          ) : (
            <>
              {/* existing reminders */}
              {remindersLoading ? (
                <div className="text-xs text-tx-tertiary">{t("common.loading")}</div>
              ) : reminders.length === 0 && !showAddReminder ? (
                <p className="text-xs text-tx-tertiary">{t("tasks.reminder.noReminders")}</p>
              ) : (
                <div className="space-y-1.5">
                  {reminders.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-app-bg border border-app-border">
                      <button
                        onClick={() => handleToggleReminder(r.id, r.enabled === 0)}
                        className="flex-shrink-0"
                      >
                        {r.enabled ? (
                          <Bell size={14} className="text-accent-primary" />
                        ) : (
                          <BellOff size={14} className="text-tx-tertiary" />
                        )}
                      </button>
                      <span className={cn(
                        "flex-1 text-xs",
                        r.enabled ? "text-tx-primary" : "text-tx-tertiary line-through"
                      )}>
                        {formatOffsetMinutes(r.offsetMinutes, t)}
                      </span>
                      <button
                        onClick={() => handleDeleteReminder(r.id)}
                        className="text-tx-tertiary hover:text-accent-danger transition-colors"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add reminder */}
              {showAddReminder ? (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    {PRESET_OFFSETS.map((preset) => {
                      const alreadyExists = reminders.some((r) => r.offsetMinutes === preset.minutes);
                      return (
                        <button
                          key={preset.minutes}
                          onClick={() => handleAddReminder(preset.minutes)}
                          disabled={alreadyExists}
                          className={cn(
                            "text-[11px] px-2.5 py-1 rounded-full border transition-colors",
                            alreadyExists
                              ? "opacity-40 cursor-not-allowed border-app-border text-tx-tertiary"
                              : "border-accent-primary/30 text-accent-primary hover:bg-accent-primary/10"
                          )}
                        >
                          {t(`tasks.reminder.${preset.key}`)}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={0}
                      value={customReminder.days}
                      onChange={(e) => setCustomReminder((prev) => ({ ...prev, days: Math.max(0, parseInt(e.target.value) || 0) }))}
                      className="w-12 px-2 py-1 rounded-md bg-app-bg border border-app-border text-xs text-tx-primary text-center focus:outline-none focus:border-accent-primary"
                    />
                    <span className="text-[11px] text-tx-tertiary">{t("tasks.reminder.daysUnit")}</span>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={customReminder.hours}
                      onChange={(e) => setCustomReminder((prev) => ({ ...prev, hours: Math.max(0, Math.min(23, parseInt(e.target.value) || 0)) }))}
                      className="w-12 px-2 py-1 rounded-md bg-app-bg border border-app-border text-xs text-tx-primary text-center focus:outline-none focus:border-accent-primary"
                    />
                    <span className="text-[11px] text-tx-tertiary">{t("tasks.reminder.hoursUnit")}</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={customReminder.minutes}
                      onChange={(e) => setCustomReminder((prev) => ({ ...prev, minutes: Math.max(0, Math.min(59, parseInt(e.target.value) || 0) }))}
                      className="w-12 px-2 py-1 rounded-md bg-app-bg border border-app-border text-xs text-tx-primary text-center focus:outline-none focus:border-accent-primary"
                    />
                    <span className="text-[11px] text-tx-tertiary">{t("tasks.reminder.minutesUnit")}</span>
                  </div>
                  <button
                    onClick={() => customOffset !== null && handleAddReminder(customOffset)}
                    disabled={customOffset === null || customReminderExists}
                    className={cn(
                      "text-[11px] px-2.5 py-1 rounded-full border transition-colors w-fit",
                      customOffset === null || customReminderExists
                        ? "opacity-40 cursor-not-allowed border-app-border text-tx-tertiary"
                        : "border-accent-primary/30 text-accent-primary hover:bg-accent-primary/10"
                    )}
                  >
                    {customReminderExists ? t("tasks.reminder.alreadyExists") : t("tasks.reminder.addCustom")}
                  </button>
                  <button
                    onClick={() => setShowAddReminder(false)}
                    className="text-[11px] text-tx-tertiary hover:text-tx-secondary"
                  >
                    {t("tasks.batchCancel")}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowAddReminder(true)}
                  className="flex items-center gap-1 text-xs text-accent-primary hover:text-accent-primary/80 transition-colors"
                >
                  <Plus size={14} />
                  {t("tasks.reminder.addReminder")}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-app-border" style={{ paddingBottom: "calc(var(--safe-area-bottom) + 16px)" }}>
        <button
          onClick={() => { onDelete(task.id); onClose(); }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm text-accent-danger border border-accent-danger/30 hover:bg-accent-danger/10 transition-colors"
        >
          <Trash2 size={14} />
          {t("tasks.deleteTask")}
        </button>
      </div>
    </div>
  );
});

TaskDetailPanel.displayName = "TaskDetailPanel";

/** Format offsetMinutes into human-readable string */
function formatOffsetMinutes(minutes: number, t: any): string {
  if (minutes === 0) return t("tasks.reminder.atDue");
  if (minutes === 5) return t("tasks.reminder.before5min");
  if (minutes === 30) return t("tasks.reminder.before30min");
  if (minutes === 60) return t("tasks.reminder.before1hour");
  if (minutes === 1440) return t("tasks.reminder.before1day");
  if (minutes < 60) return t("tasks.reminder.customMinutes", { count: minutes });
  if (minutes < 1440) return t("tasks.reminder.customHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  return t("tasks.reminder.customDays", { count: Math.floor(minutes / 1440) });
}
