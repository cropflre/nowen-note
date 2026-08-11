import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Bell, BellOff, Clock, AlertTriangle, Loader2, RefreshCw, Monitor, MoreHorizontal, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { ReminderOverview, ReminderOverviewItem } from "@/types";
import { emitTaskReminderScheduleChanged } from "@/lib/taskNotificationSchedule";
import {
  getTaskNotificationPermission,
  getTaskNotificationSurface,
  requestTaskNotificationPermission,
  type TaskNotificationPermission,
} from "@/lib/taskNotifications";

interface ReminderCenterProps {
  open: boolean;
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
}

const GROUP_ORDER: Array<{ key: keyof ReminderOverview; icon: React.ReactNode }> = [
  { key: "missed", icon: <AlertTriangle size={14} /> },
  { key: "today", icon: <Clock size={14} /> },
  { key: "upcoming", icon: <Clock size={14} /> },
  { key: "disabled", icon: <BellOff size={14} /> },
];

function formatOffset(minutes: number, t: (key: string, opts?: any) => string): string {
  if (minutes === 0) return t("tasks.reminderCenter.atDue");
  if (minutes < 60) return t("tasks.reminderCenter.minutesBefore", { minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0
    ? t("tasks.reminderCenter.hoursMinutesBefore", { hours: h, minutes: m })
    : t("tasks.reminderCenter.hoursBefore", { hours: h });
}

const SNOOZE_OPTIONS = [
  { key: "10min", compute: () => new Date(Date.now() + 10 * 60000).toISOString() },
  { key: "1hour", compute: () => new Date(Date.now() + 60 * 60000).toISOString() },
  { key: "tomorrow", compute: () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }},
];

export function ReminderCenter({ open, onClose, onSelectTask }: ReminderCenterProps) {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<ReminderOverview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [notificationSurface] = useState(() => getTaskNotificationSurface());
  const [notifPermission, setNotifPermission] = useState<TaskNotificationPermission>("prompt");
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [snoozeMenuId, setSnoozeMenuId] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const refreshNotificationPermission = useCallback(async () => {
    setNotifPermission(await getTaskNotificationPermission());
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.getReminderOverview(7);
      setOverview(data);
    } catch {
      setError(t("tasks.reminderCenter.loadFailed"));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) {
      load();
      void refreshNotificationPermission();
      setActionMenuId(null);
      setSnoozeMenuId(null);
    }
  }, [open, load, refreshNotificationPermission]);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleEnableNotification = async () => {
    const result = await requestTaskNotificationPermission();
    setNotifPermission(result);
    if (result === "granted") emitTaskReminderScheduleChanged();
  };

  const handleClickItem = (item: ReminderOverviewItem) => {
    onClose();
    onSelectTask(item.taskId);
  };

  const handleDisableReminder = async (item: ReminderOverviewItem) => {
    setActing(item.reminderId);
    try {
      await api.updateTaskReminder(item.reminderId, { enabled: false });
      await load();
    } catch { /* ignore */ }
    finally { setActing(null); setActionMenuId(null); }
  };

  const handleEnableReminder = async (item: ReminderOverviewItem) => {
    setActing(item.reminderId);
    try {
      await api.updateTaskReminder(item.reminderId, { enabled: true });
      await load();
    } catch { /* ignore */ }
    finally { setActing(null); setActionMenuId(null); }
  };

  const handleSnooze = async (item: ReminderOverviewItem, computeSnooze: () => string) => {
    setActing(item.reminderId);
    try {
      const snoozedUntil = computeSnooze();
      await api.updateTaskReminder(item.reminderId, { enabled: true, snoozedUntil });
      await load();
    } catch { /* ignore */ }
    finally { setActing(null); setSnoozeMenuId(null); setActionMenuId(null); }
  };

  if (!open) return null;

  const totalMissedToday = overview
    ? overview.missed.length + overview.today.length
    : 0;
  const isEmpty = overview
    ? GROUP_ORDER.every(({ key }) => overview[key].length === 0)
    : false;

  return (
    <motion.div
      className="fixed inset-0 z-[10000] flex items-center justify-center px-3"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ scale: 0.95, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.97, opacity: 0, y: 10 }}
        transition={{ duration: 0.2 }}
        className="relative w-[min(560px,calc(100vw-24px))] max-h-[85vh] sm:max-h-[80vh] bg-bg-primary rounded-xl shadow-2xl border border-app-border flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="min-h-12 flex items-center justify-between px-4 border-b border-app-border bg-bg-primary">
          <div className="flex items-center gap-2">
            <Bell size={18} className="text-accent-primary" />
            <h2 className="text-sm font-medium text-tx-primary">
              {t("tasks.reminderCenter.title")}
            </h2>
            {totalMissedToday > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-500 font-medium">
                {totalMissedToday}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={load}
              disabled={isLoading}
              className="p-1.5 rounded-md text-tx-tertiary hover:text-tx-primary hover:bg-bg-hover transition-colors disabled:opacity-60"
              title={t("tasks.reminderCenter.refresh")}
              aria-label={t("tasks.reminderCenter.refresh")}
            >
              <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-tx-tertiary hover:text-tx-primary hover:bg-bg-hover transition-colors"
              title={t("tasks.reminderCenter.close")}
              aria-label={t("tasks.reminderCenter.close")}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Notification permission */}
        <div className="px-4 py-2.5 border-b border-app-border bg-bg-primary text-xs">
          {notifPermission === "granted" && (
            <div className="inline-flex items-center gap-1.5 rounded-md bg-green-500/10 px-2 py-1 font-medium text-green-700 dark:text-green-400">
              {notificationSurface === "electron" ? <Monitor size={13} /> : <Bell size={13} />}
              {notificationSurface === "electron"
                ? t("tasks.reminderCenter.desktopNotificationEnabled")
                : t("tasks.reminderCenter.permissionEnabled")}
            </div>
          )}
          {(notifPermission === "denied" || notifPermission === "unsupported") && (
            <div className="inline-flex items-center gap-1.5 rounded-md bg-red-500/10 px-2 py-1 font-medium text-red-600 dark:text-red-400">
              <BellOff size={13} />
              {t("tasks.reminderCenter.permissionDenied")}
            </div>
          )}
          {notifPermission === "prompt" && (
            <button
              type="button"
              onClick={handleEnableNotification}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary/10 px-2 py-1 font-medium text-accent-primary hover:bg-accent-primary/15 transition-colors"
            >
              <Bell size={13} />
              {t("tasks.reminderCenter.enableNotification")}
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && !overview && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-tx-tertiary" />
            </div>
          )}
          {error && (
            <div className="px-4 py-8 text-center">
              <div className="text-sm text-red-500 mb-3">{error}</div>
              <button type="button" onClick={load} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-app-elevated border border-app-border hover:bg-app-hover text-tx-secondary transition-colors">
                <RefreshCw size={12} />
                {t("tasks.reminderCenter.retry")}
              </button>
            </div>
          )}
          {!isLoading && !error && overview && isEmpty && (
            <div className="flex flex-col items-center justify-center px-8 py-14 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-bg-hover text-tx-secondary">
                <BellOff size={22} />
              </div>
              <div className="text-sm font-medium text-tx-primary">
                {t("tasks.reminderCenter.emptyTitle")}
              </div>
              <div className="mt-1 max-w-[300px] text-xs leading-5 text-tx-secondary">
                {t("tasks.reminderCenter.emptyDescription")}
              </div>
              <button
                type="button"
                onClick={load}
                disabled={isLoading}
                className="mt-5 inline-flex items-center gap-1.5 rounded-md border border-app-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-tx-secondary shadow-sm hover:bg-bg-hover hover:text-tx-primary disabled:opacity-60 transition-colors"
              >
                <RefreshCw size={12} className={isLoading ? "animate-spin" : ""} />
                {t("tasks.reminderCenter.refresh")}
              </button>
            </div>
          )}
          {!isLoading && !error && overview && !isEmpty && (
            <div>
              {GROUP_ORDER.map(({ key, icon }) => {
                const items = overview[key];
                const isCollapsed = collapsed.has(key);
                return (
                  <div key={key}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(key)}
                      className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-medium text-tx-secondary hover:bg-bg-hover transition-colors"
                    >
                      <span className="flex items-center gap-1.5">
                        {icon}
                        {t(`tasks.reminderCenter.${key}`)}
                      </span>
                      <span className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                        key === "missed" && items.length > 0
                          ? "bg-red-500/15 text-red-500"
                          : key === "today" && items.length > 0
                          ? "bg-amber-500/15 text-amber-500"
                          : "bg-bg-hover text-tx-tertiary"
                      )}>
                        {items.length}
                      </span>
                    </button>
                    {!isCollapsed && items.length > 0 && (
                      <div>
                        {items.map((item) => (
                          <div
                            key={item.reminderId}
                            className="relative border-b border-app-border/60"
                          >
                            <div className="flex items-stretch">
                              {/* Left: clickable task area */}
                              <button
                                type="button"
                                onClick={() => handleClickItem(item)}
                                className="flex-1 text-left px-4 py-2.5 hover:bg-bg-hover transition-colors"
                              >
                                <div className="text-sm text-tx-primary truncate">
                                  {item.taskTitle}
                                </div>
                                <div className="flex items-center gap-2 mt-0.5 text-[11px] text-tx-secondary">
                                  {item.snoozedUntil ? (
                                    <span>
                                      {t("tasks.reminderCenter.snoozedUntil")}:{" "}
                                      {new Date(item.snoozedUntil).toLocaleString()}
                                    </span>
                                  ) : item.reminderAt ? (
                                    <span>
                                      {t("tasks.reminderCenter.reminderAt")}:{" "}
                                      {new Date(item.reminderAt).toLocaleString()}
                                    </span>
                                  ) : null}
                                  {(item.dueAt || item.dueDate) && (
                                    <span>
                                      {t("tasks.reminderCenter.dueAt")}:{" "}
                                      {item.dueAt
                                        ? new Date(item.dueAt).toLocaleString()
                                        : item.dueDate}
                                    </span>
                                  )}
                                  {!item.snoozedUntil && (
                                    <span>{formatOffset(item.offsetMinutes, t)}</span>
                                  )}
                                </div>
                              </button>

                              {/* Right: action button */}
                              <div className="flex items-center pr-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActionMenuId(actionMenuId === item.reminderId ? null : item.reminderId);
                                    setSnoozeMenuId(null);
                                  }}
                                  className="p-1.5 rounded-md text-tx-tertiary hover:text-tx-primary hover:bg-bg-hover transition-colors"
                                  disabled={acting === item.reminderId}
                                  title={t("tasks.reminderCenter.moreActions")}
                                  aria-label={t("tasks.reminderCenter.moreActions")}
                                >
                                  <MoreHorizontal size={14} />
                                </button>
                              </div>
                            </div>

                            {/* Action menu */}
                            <AnimatePresence>
                              {actionMenuId === item.reminderId && (
                                <motion.div
                                  initial={{ opacity: 0, y: -4 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  exit={{ opacity: 0, y: -4 }}
                                  transition={{ duration: 0.12 }}
                                  className="absolute right-3 top-full z-10 bg-bg-primary border border-app-border rounded-lg shadow-lg py-1 min-w-[140px]"
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); handleClickItem(item); }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-tx-secondary hover:text-tx-primary hover:bg-bg-hover flex items-center gap-2"
                                  >
                                    <ExternalLink size={12} />
                                    {t("tasks.reminderCenter.goToTask")}
                                  </button>

                                  {(key === "missed" || key === "today" || key === "upcoming") && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSnoozeMenuId(snoozeMenuId === item.reminderId ? null : item.reminderId);
                                      }}
                                      className="w-full text-left px-3 py-1.5 text-xs text-tx-secondary hover:text-tx-primary hover:bg-bg-hover flex items-center gap-2"
                                    >
                                      <Clock size={12} />
                                      {t("tasks.reminderCenter.snooze")}
                                    </button>
                                  )}

                                  {(key === "missed" || key === "today" || key === "upcoming") && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); handleDisableReminder(item); }}
                                      disabled={acting === item.reminderId}
                                      className="w-full text-left px-3 py-1.5 text-xs text-tx-secondary hover:text-tx-primary hover:bg-bg-hover flex items-center gap-2"
                                    >
                                      <BellOff size={12} />
                                      {t("tasks.reminderCenter.disableReminder")}
                                    </button>
                                  )}

                                  {key === "disabled" && item.enabled !== 1 && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); handleEnableReminder(item); }}
                                      disabled={acting === item.reminderId}
                                      className="w-full text-left px-3 py-1.5 text-xs text-tx-secondary hover:text-tx-primary hover:bg-bg-hover flex items-center gap-2"
                                    >
                                      <Bell size={12} />
                                      {t("tasks.reminderCenter.enableReminder")}
                                    </button>
                                  )}
                                </motion.div>
                              )}
                            </AnimatePresence>

                            {/* Snooze submenu */}
                            <AnimatePresence>
                              {snoozeMenuId === item.reminderId && (
                                <motion.div
                                  initial={{ opacity: 0, y: -4 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  exit={{ opacity: 0, y: -4 }}
                                  transition={{ duration: 0.12 }}
                                  className="absolute right-3 top-full mt-[60px] z-10 bg-bg-primary border border-app-border rounded-lg shadow-lg py-1 min-w-[120px]"
                                >
                                  {SNOOZE_OPTIONS.map((opt) => (
                                    <button
                                      key={opt.key}
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); handleSnooze(item, opt.compute); }}
                                      disabled={acting === item.reminderId}
                                      className="w-full text-left px-3 py-1.5 text-xs text-tx-secondary hover:text-tx-primary hover:bg-bg-hover"
                                    >
                                      {t(`tasks.reminderCenter.snooze${opt.key}`)}
                                    </button>
                                  ))}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        ))}
                      </div>
                    )}
                    {!isCollapsed && items.length === 0 && (
                      <div className="px-4 py-2 text-xs text-tx-secondary">
                        {t("tasks.reminderCenter.empty")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
