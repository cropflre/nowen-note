import { useEffect, useRef } from "react";
import { App as CapApp } from "@capacitor/app";
import i18n from "i18next";
import { api } from "@/lib/api";
import { TASK_REMINDER_SYNC_EVENT } from "@/lib/taskNotificationSchedule";
import {
  cancelAllNativeTaskNotifications,
  getTaskNotificationPermission,
  getTaskNotificationSurface,
  registerTaskNotificationActionListener,
  showImmediateTaskNotification,
  syncNativeTaskNotifications,
  wasTaskReminderScheduledNatively,
} from "@/lib/taskNotifications";

/**
 * Global reminder runtime.
 *
 * Native strategy:
 *   1. Fetch every future reminder from the server and schedule it through
 *      Capacitor Local Notifications. Android can then notify while the WebView
 *      is hidden, the screen is locked, or the process is not running.
 *   2. Resync on login, foreground, task/reminder mutations and server changes.
 *   3. Keep the recent-reminder endpoint for automation notifications and for
 *      Web/Electron fallback delivery.
 *   4. ACK only after a notification is delivered or that exact reminder was
 *      previously handed to the native OS. Scanner discovery alone is never
 *      treated as successful delivery.
 */

interface RecentReminder {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  triggeredAt: number;
  type?: string;
}

const globalKey = "__nowen_notified_set__";
const deliveredSet: Set<string> = typeof window === "undefined"
  ? new Set()
  : ((window as any)[globalKey] || ((window as any)[globalKey] = new Set()));

function notificationCopy(reminder: RecentReminder): { title: string; body: string } {
  const type = reminder.type || "task_reminder";
  if (type === "dependency_ready") {
    return {
      title: `✅ ${i18n.t("tasks.notifications.dependencyReadyTitle")}`,
      body: i18n.t("tasks.notifications.dependencyReadyBody", { taskTitle: reminder.taskTitle }),
    };
  }
  if (type === "overdue_daily") {
    return {
      title: `⚠️ ${i18n.t("tasks.notifications.overdueDailyTitle")}`,
      body: i18n.t("tasks.notifications.overdueDailyBody", { taskTitle: reminder.taskTitle }),
    };
  }
  return {
    title: `⏰ ${i18n.t("tasks.notifications.taskReminderTitle")}`,
    body: i18n.t("tasks.notifications.taskReminderBody", { taskTitle: reminder.taskTitle }),
  };
}

export function useReminderNotifier(onOpenTask?: (taskId: string) => void) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastScanRef = useRef<number>(Date.now());
  const nativeSchedulesReadyRef = useRef(false);
  const onOpenTaskRef = useRef(onOpenTask);
  onOpenTaskRef.current = onOpenTask;

  useEffect(() => {
    let disposed = false;
    let removeActionListener: (() => void) | null = null;
    let appStateHandle: { remove: () => Promise<void> } | null = null;

    const syncNativeSchedules = async (): Promise<boolean> => {
      if (getTaskNotificationSurface() !== "native") return true;
      try {
        const permission = await getTaskNotificationPermission();
        if (permission !== "granted") {
          nativeSchedulesReadyRef.current = false;
          return false;
        }
        const { reminders } = await api.getTaskReminderSchedule();
        const synced = await syncNativeTaskNotifications(reminders || []);
        nativeSchedulesReadyRef.current = synced;
        return synced;
      } catch (error) {
        nativeSchedulesReadyRef.current = false;
        console.warn("[reminder] native schedule sync failed", error);
        return false;
      }
    };

    const acknowledge = async (reminderId: string): Promise<boolean> => {
      try {
        await api.ackRecentReminders([reminderId]);
        return true;
      } catch {
        return false;
      }
    };

    const deliverImmediately = async (reminder: RecentReminder): Promise<boolean> => {
      const type = reminder.type || "task_reminder";
      const copy = notificationCopy(reminder);
      const delivered = await showImmediateTaskNotification(copy.title, copy.body, {
        requestPermission: false,
        taskId: reminder.taskId,
        reminderId: reminder.reminderId,
        type,
      });
      if (!delivered) return false;

      // The notification is already visible/accepted by the OS. Remember that
      // fact before ACK so a temporary network failure retries only ACK and does
      // not show the same notification again in this session.
      deliveredSet.add(reminder.reminderId);
      return acknowledge(reminder.reminderId);
    };

    const scan = async () => {
      const scanStartedAt = Date.now();
      let nextSince = scanStartedAt;
      try {
        const { reminders } = await api.getRecentReminders(lastScanRef.current);
        const recent: RecentReminder[] = reminders || [];
        const surface = getTaskNotificationSurface();

        for (const reminder of recent) {
          if (deliveredSet.has(reminder.reminderId)) {
            if (!(await acknowledge(reminder.reminderId))) {
              nextSince = Math.min(nextSince, reminder.triggeredAt - 1);
            }
            continue;
          }

          const type = reminder.type || "task_reminder";
          if (surface === "native" && type === "task_reminder") {
            if (!nativeSchedulesReadyRef.current) {
              await syncNativeSchedules();
            }

            if (
              nativeSchedulesReadyRef.current
              && wasTaskReminderScheduledNatively(reminder.reminderId)
            ) {
              deliveredSet.add(reminder.reminderId);
              if (!(await acknowledge(reminder.reminderId))) {
                nextSince = Math.min(nextSince, reminder.triggeredAt - 1);
              }
              continue;
            }

            // The app may have been opened for the first time after this reminder
            // was already due. A successful sync with no future item is not proof
            // that Android ever received it, so deliver a catch-up notification.
            if (!(await deliverImmediately(reminder))) {
              nextSince = Math.min(nextSince, reminder.triggeredAt - 1);
            }
            continue;
          }

          if (!(await deliverImmediately(reminder))) {
            nextSince = Math.min(nextSince, reminder.triggeredAt - 1);
          }
        }
      } catch {
        nextSince = lastScanRef.current;
      }
      lastScanRef.current = Math.max(0, nextSince);
    };

    const startPolling = () => {
      if (timerRef.current) return;
      timerRef.current = setInterval(scan, 30_000);
    };

    const stopPolling = () => {
      if (!timerRef.current) return;
      clearInterval(timerRef.current);
      timerRef.current = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void syncNativeSchedules();
        void scan();
        startPolling();
      } else {
        stopPolling();
      }
    };

    const onScheduleChanged = () => {
      void syncNativeSchedules();
    };

    const resetNativeSchedules = () => {
      deliveredSet.clear();
      nativeSchedulesReadyRef.current = false;
      void cancelAllNativeTaskNotifications();
    };

    const onServerChanged = () => {
      deliveredSet.clear();
      nativeSchedulesReadyRef.current = false;
      void cancelAllNativeTaskNotifications().then(() => syncNativeSchedules());
    };

    void registerTaskNotificationActionListener((taskId) => {
      onOpenTaskRef.current?.(taskId);
    }).then((remove) => {
      if (disposed) remove();
      else removeActionListener = remove;
    }).catch(() => {});

    void CapApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) return;
      void syncNativeSchedules();
      void scan();
    }).then((handle) => {
      if (disposed) void handle.remove();
      else appStateHandle = handle;
    }).catch(() => {});

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(TASK_REMINDER_SYNC_EVENT, onScheduleChanged);
    window.addEventListener("nowen:server-url-changed", onServerChanged);
    window.addEventListener("nowen:workspace-changed", onScheduleChanged);
    window.addEventListener("nowen:token-changed", resetNativeSchedules);

    void syncNativeSchedules();
    const initialTimeout = setTimeout(() => { void scan(); }, 3_000);
    if (document.visibilityState === "visible") startPolling();

    return () => {
      disposed = true;
      clearTimeout(initialTimeout);
      stopPolling();
      removeActionListener?.();
      if (appStateHandle) void appStateHandle.remove();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(TASK_REMINDER_SYNC_EVENT, onScheduleChanged);
      window.removeEventListener("nowen:server-url-changed", onServerChanged);
      window.removeEventListener("nowen:workspace-changed", onScheduleChanged);
      window.removeEventListener("nowen:token-changed", resetNativeSchedules);
    };
  }, []);
}
