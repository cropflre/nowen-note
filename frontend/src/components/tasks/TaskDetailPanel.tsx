import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { Flag, Trash2, X, Bell, BellOff, CheckCircle2, Circle, Plus, Clock, Repeat } from "lucide-react";
import { format, parseISO } from "date-fns";
import { zhCN, enUS } from "date-fns/locale";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { Task, TaskPriority, TaskReminder } from "@/types";
import { isRepeatingTask } from "./taskRepeatUtils";
import { TaskAIBreakdown } from "./TaskAIBreakdown";
import { TaskTemplateEditor } from "./TaskTemplateEditor";
import type { TaskTreeNode } from "./taskProgress";
import { calculateTaskProgress } from "./taskProgress";
import { parseTaskTitle, TitleView } from "./taskTitleTokens";

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
}>(({ task, treeNode, allTasks, onClose, onUpdate, onDelete, onToggle, onSelectTask , onCreated }, ref) => {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage || i18n.language;
  const isZh = lang.toLowerCase().startsWith("zh");
  const dateLocale = isZh ? zhCN : enUS;
  const [title, setTitle] = useState(task.title);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate || "");
  const [dueAt, setDueAt] = useState(task.dueAt || "");
  const [repeatRule, setRepeatRule] = useState<"none" | "daily" | "weekly" | "monthly" | "yearly">(task.repeatRule || "none");
  const [repeatInterval, setRepeatInterval] = useState(task.repeatInterval || 1);
  const [repeatEndDate, setRepeatEndDate] = useState(task.repeatEndDate || "");
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // reminder state
  const [reminders, setReminders] = useState<TaskReminder[]>([]);
  const [remindersLoading, setRemindersLoading] = useState(false);
  const [showAddReminder, setShowAddReminder] = useState(false);

  const PRIORITY_CONFIG: Record<number, { label: string; color: string; flagClass: string }> = {
    3: { label: t("tasks.high"), color: "text-red-500", flagClass: "text-red-500" },
    2: { label: t("tasks.medium"), color: "text-amber-500", flagClass: "text-amber-500" },
    1: { label: t("tasks.low"), color: "text-blue-400", flagClass: "text-blue-400" },
  };

  useEffect(() => {
    setTitle(task.title);
    setPriority(task.priority);
    setDueDate(task.dueDate || "");
    setDueAt(task.dueAt || "");
    setRepeatRule(task.repeatRule || "none");
    setRepeatInterval(task.repeatInterval || 1);
    setRepeatEndDate(task.repeatEndDate || "");
  }, [task.id]);

  // load reminders for this task
  const loadReminders = useCallback(async () => {
    setRemindersLoading(true);
    try {
      const data = await api.getTaskReminders(task.id);
      setReminders(data);
    } catch {
      // ignore
    } finally {
      setRemindersLoading(false);
    }
  }, [task.id]);

  useEffect(() => { loadReminders(); }, [loadReminders]);

  const handleSave = () => {
    onUpdate(task.id, { title: title.trim() || task.title, priority, dueDate: dueDate || null, dueAt: dueAt || null });
  };

  const hasRichTokens = parseTaskTitle(task.title).some((tok) => tok.kind !== "text");
  const progressInfo = treeNode ? calculateTaskProgress(treeNode) : null;

  const children = allTasks
    ? allTasks.filter((t) => t.parentId === task.id)
    : [];

  const hasDeadline = !!(task.dueDate || task.dueAt);

  // reminder handlers
  const handleAddReminder = async (offsetMinutes: number) => {
    try {
      const r = await api.createTaskReminder(task.id, offsetMinutes);
      setReminders((prev) => [...prev, r].sort((a, b) => a.offsetMinutes - b.offsetMinutes));
      setShowAddReminder(false);
    } catch (err) {
      console.error("Failed to create reminder:", err);
    }
  };

  const handleToggleReminder = async (reminderId: string, enabled: boolean) => {
    setReminders((prev) => prev.map((r) => r.id === reminderId ? { ...r, enabled: enabled ? 1 : 0 } : r));
    try {
      await api.updateTaskReminder(reminderId, { enabled });
    } catch { loadReminders(); }
  };

  const handleDeleteReminder = async (reminderId: string) => {
    setReminders((prev) => prev.filter((r) => r.id !== reminderId));
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
    <motion.div
      ref={ref}
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className={cn(
        "h-full border-l border-app-border bg-app-surface flex flex-col shrink-0",
        "fixed inset-0 z-30 w-full border-l-0",
        "md:static md:z-auto md:w-[340px] md:min-w-[340px] md:border-l"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border" style={{ paddingTop: "calc(var(--safe-area-top) + 4px)" }}>
        <span className="text-sm font-semibold text-tx-primary">{t("tasks.taskDetail")}</span>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover transition-colors">
          <X size={16} className="text-tx-secondary" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4 space-y-5">
        {/* Title */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t("tasks.taskTitle")}</label>
          <textarea
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleSave}
            rows={Math.min(4, Math.max(2, title.split("\n").length))}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors resize-y font-mono"
          />
          {hasRichTokens && (
            <div className="mt-2 px-3 py-2 rounded-md bg-app-elevated border border-app-border text-sm text-tx-primary leading-relaxed break-all">
              <TitleView title={title} compact={false} isCompleted={task.isCompleted === 1} />
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

        {/* Due Date */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t("tasks.dueDate")}</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => { setDueDate(e.target.value); onUpdate(task.id, { dueDate: e.target.value || null }); }}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
          />
        </div>

        {/* Due At (time) */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t("tasks.dueAt")}</label>
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(e) => { setDueAt(e.target.value); onUpdate(task.id, { dueAt: e.target.value || null }); }}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
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
              {t("tasks.progress.dueLabel")}: {format(parseISO(task.dueDate), isZh ? "yyyy\u5E74M\u6708d\u65E5" : "MMM d, yyyy", { locale: dateLocale })}
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
          <select
            value={repeatRule}
            onChange={(e) => {
              const rule = e.target.value as "none" | "daily" | "weekly" | "monthly" | "yearly";
              setRepeatRule(rule);
              if (rule === "none") {
                onUpdate(task.id, { repeatRule: "none", repeatInterval: 1, repeatEndDate: null });
              } else {
                onUpdate(task.id, { repeatRule: rule, repeatInterval, repeatEndDate: repeatEndDate || null });
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
          </select>
          {!hasDeadline && repeatRule === "none" && (
            <p className="text-[10px] text-tx-tertiary">{t("tasks.repeat.needDueDate")}</p>
          )}
          {repeatRule !== "none" && (
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
          {repeatRule !== "none" && (
            <div>
              <label className="text-xs text-tx-tertiary mb-1 block">{t("tasks.repeat.endDate")}</label>
              <input
                type="date"
                value={repeatEndDate}
                onChange={(e) => {
                  setRepeatEndDate(e.target.value);
                  onUpdate(task.id, { repeatEndDate: e.target.value || null });
                }}
                className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
              />
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
      <div className="p-4 border-t border-app-border" style={{ paddingBottom: "calc(var(--safe-area-bottom) + 16px)" }}>
        <button
          onClick={() => { onDelete(task.id); onClose(); }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm text-accent-danger border border-accent-danger/30 hover:bg-accent-danger/10 transition-colors"
        >
          <Trash2 size={14} />
          {t("tasks.deleteTask")}
        </button>
      </div>
    </motion.div>
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
