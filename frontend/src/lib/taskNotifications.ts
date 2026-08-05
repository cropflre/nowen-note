import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import i18n from "i18next";
import {
  TASK_NOTIFICATION_OPEN_EVENT,
  mergeTaskReminderScheduleHistory,
  selectSchedulableTaskReminders,
  taskReminderNotificationId,
  wasTaskReminderScheduledNatively as hasNativeScheduleEvidence,
  type TaskReminderScheduleHistory,
  type TaskReminderScheduleItem,
} from "@/lib/taskNotificationSchedule";

const TASK_REMINDER_CHANNEL_ID = "task-reminders";
const TASK_REMINDER_SOURCE = "nowen-task-reminder";
const PENDING_TASK_ID_KEY = "nowen-pending-notification-task-id";
const NATIVE_SCHEDULE_HISTORY_KEY = "nowen-native-task-reminder-schedule-history";
let channelReady = false;

export type TaskNotificationPermission = "granted" | "denied" | "prompt" | "unsupported";
export type TaskNotificationSurface = "native" | "electron" | "web" | "unsupported";

export function getTaskNotificationSurface(): TaskNotificationSurface {
  if (typeof window === "undefined") return "unsupported";
  if ((window as any).nowenDesktop?.taskNotify) return "electron";
  if (Capacitor.isNativePlatform()) return "native";
  if (typeof Notification !== "undefined") return "web";
  return "unsupported";
}

function normalizePermission(value: string | undefined): TaskNotificationPermission {
  if (value === "granted") return "granted";
  if (value === "denied") return "denied";
  return value ? "prompt" : "unsupported";
}

function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

function readNativeScheduleHistory(): TaskReminderScheduleHistory {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(NATIVE_SCHEDULE_HISTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as TaskReminderScheduleHistory;
  } catch {
    return {};
  }
}

function writeNativeScheduleHistory(history: TaskReminderScheduleHistory): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(NATIVE_SCHEDULE_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Storage can be unavailable in private WebViews; immediate fallback still works.
  }
}

function clearNativeScheduleHistory(): void {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(NATIVE_SCHEDULE_HISTORY_KEY); } catch { /* ignore */ }
}

export function wasTaskReminderScheduledNatively(reminderId: string, now = Date.now()): boolean {
  return hasNativeScheduleEvidence(readNativeScheduleHistory(), reminderId, now);
}

async function ensureTaskReminderChannel(): Promise<void> {
  if (!isNativeAndroid() || channelReady) return;
  await LocalNotifications.createChannel({
    id: TASK_REMINDER_CHANNEL_ID,
    name: "任务提醒",
    description: "Nowen Note 任务到期与提前提醒",
    importance: 4,
    visibility: 1,
    vibration: true,
  });
  channelReady = true;
}

export async function getTaskExactAlarmPermission(): Promise<TaskNotificationPermission> {
  if (!isNativeAndroid()) return "granted";
  try {
    const status = await LocalNotifications.checkExactNotificationSetting();
    return normalizePermission(status.exact_alarm);
  } catch {
    return "unsupported";
  }
}

async function requestTaskExactAlarmPermission(): Promise<TaskNotificationPermission> {
  if (!isNativeAndroid()) return "granted";
  const current = await getTaskExactAlarmPermission();
  if (current === "granted" || current === "unsupported") return current;
  try {
    const status = await LocalNotifications.changeExactNotificationSetting();
    return normalizePermission(status.exact_alarm);
  } catch {
    return current;
  }
}

export async function getTaskNotificationPermission(): Promise<TaskNotificationPermission> {
  const surface = getTaskNotificationSurface();
  if (surface === "electron") return "granted";
  if (surface === "native") {
    try {
      const status = await LocalNotifications.checkPermissions();
      return normalizePermission(status.display);
    } catch {
      return "unsupported";
    }
  }
  if (surface === "web") return normalizePermission(Notification.permission);
  return "unsupported";
}

export async function requestTaskNotificationPermission(): Promise<TaskNotificationPermission> {
  const surface = getTaskNotificationSurface();
  if (surface === "electron") return "granted";
  if (surface === "native") {
    try {
      const status = await LocalNotifications.requestPermissions();
      const permission = normalizePermission(status.display);
      if (permission === "granted") {
        await ensureTaskReminderChannel();
        // Task deadlines are time-sensitive. This call only opens Android's exact
        // alarm settings after the user explicitly presses "Enable notifications".
        await requestTaskExactAlarmPermission();
      }
      return permission;
    } catch {
      return "unsupported";
    }
  }
  if (surface === "web") {
    try {
      return normalizePermission(await Notification.requestPermission());
    } catch {
      return "unsupported";
    }
  }
  return "unsupported";
}

export async function showImmediateTaskNotification(
  title: string,
  body: string,
  options: { requestPermission?: boolean; taskId?: string; reminderId?: string; type?: string } = {},
): Promise<boolean> {
  const surface = getTaskNotificationSurface();

  if (surface === "electron") {
    try {
      await (window as any).nowenDesktop.taskNotify(title, body);
      return true;
    } catch {
      return false;
    }
  }

  if (surface === "native") {
    const permission = options.requestPermission
      ? await requestTaskNotificationPermission()
      : await getTaskNotificationPermission();
    if (permission !== "granted") return false;

    try {
      await ensureTaskReminderChannel();
      const seed = options.reminderId || `${options.type || "immediate"}-${Date.now()}-${Math.random()}`;
      await LocalNotifications.schedule({
        notifications: [{
          id: taskReminderNotificationId(seed),
          title,
          body,
          channelId: isNativeAndroid() ? TASK_REMINDER_CHANNEL_ID : undefined,
          autoCancel: true,
          schedule: { at: new Date(Date.now() + 300), allowWhileIdle: true },
          extra: {
            source: TASK_REMINDER_SOURCE,
            taskId: options.taskId,
            reminderId: options.reminderId,
            type: options.type || "task_reminder",
          },
        }],
      });
      return true;
    } catch {
      return false;
    }
  }

  if (surface === "web") {
    let permission = await getTaskNotificationPermission();
    if (permission === "prompt" && options.requestPermission) {
      permission = await requestTaskNotificationPermission();
    }
    if (permission !== "granted") return false;
    try {
      new Notification(title, { body });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export async function showTestTaskNotification(title: string, body: string): Promise<boolean> {
  return showImmediateTaskNotification(title, body, {
    requestPermission: true,
    type: "test",
  });
}

export async function syncNativeTaskNotifications(
  reminders: TaskReminderScheduleItem[],
): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return true;
  if ((await getTaskNotificationPermission()) !== "granted") return false;

  try {
    await ensureTaskReminderChannel();
    const platform = Capacitor.getPlatform();
    if (platform === "android") {
      const exactPermission = await getTaskExactAlarmPermission();
      if (exactPermission !== "granted" && exactPermission !== "unsupported") {
        console.warn("[task-notifications] exact alarms disabled; using Android's inexact fallback");
      }
    }

    const selected = selectSchedulableTaskReminders(
      reminders,
      platform === "ios" ? "ios" : "android",
    );

    const pending = await LocalNotifications.getPending();
    const ours = pending.notifications.filter(
      (item) => (item.extra as any)?.source === TASK_REMINDER_SOURCE,
    );
    if (ours.length > 0) {
      await LocalNotifications.cancel({
        notifications: ours.map((item) => ({ id: item.id })),
      });
    }

    if (selected.length > 0) {
      await LocalNotifications.schedule({
        notifications: selected.map((item) => ({
          id: item.notificationId,
          title: `⏰ ${i18n.t("tasks.notifications.taskReminderTitle")}`,
          body: i18n.t("tasks.notifications.taskReminderBody", { taskTitle: item.taskTitle }),
          channelId: platform === "android" ? TASK_REMINDER_CHANNEL_ID : undefined,
          autoCancel: true,
          schedule: { at: item.scheduleAt, allowWhileIdle: true },
          extra: {
            source: TASK_REMINDER_SOURCE,
            taskId: item.taskId,
            reminderId: item.reminderId,
            type: "task_reminder",
          },
        })),
      });
    }

    writeNativeScheduleHistory(
      mergeTaskReminderScheduleHistory(readNativeScheduleHistory(), selected),
    );
    return true;
  } catch (error) {
    console.warn("[task-notifications] native schedule sync failed", error);
    return false;
  }
}

export async function cancelAllNativeTaskNotifications(): Promise<void> {
  clearNativeScheduleHistory();
  if (!Capacitor.isNativePlatform()) return;
  try {
    const pending = await LocalNotifications.getPending();
    const ours = pending.notifications.filter(
      (item) => (item.extra as any)?.source === TASK_REMINDER_SOURCE,
    );
    if (ours.length > 0) {
      await LocalNotifications.cancel({ notifications: ours.map((item) => ({ id: item.id })) });
    }
  } catch {
    // Native plugin may be unavailable during shutdown; nothing else to do.
  }
}

function rememberPendingTaskId(taskId: string): void {
  try { localStorage.setItem(PENDING_TASK_ID_KEY, taskId); } catch { /* ignore */ }
}

export function consumePendingTaskNotificationTaskId(): string | null {
  try {
    const taskId = localStorage.getItem(PENDING_TASK_ID_KEY);
    if (taskId) localStorage.removeItem(PENDING_TASK_ID_KEY);
    return taskId;
  } catch {
    return null;
  }
}

export async function registerTaskNotificationActionListener(
  onOpenTask?: (taskId: string) => void,
): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};

  const handle = await LocalNotifications.addListener(
    "localNotificationActionPerformed",
    (action) => {
      const taskId = String((action.notification.extra as any)?.taskId || "").trim();
      if (!taskId) return;
      rememberPendingTaskId(taskId);
      window.dispatchEvent(new CustomEvent(TASK_NOTIFICATION_OPEN_EVENT, { detail: { taskId } }));
      onOpenTask?.(taskId);
    },
  );
  return () => { void handle.remove(); };
}
