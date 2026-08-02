import type { FolderAutoLockMinutes } from "@/lib/userPreferenceAccountCache";
import {
  clearFolderUnlockTokens,
  getFolderUnlockSessionSnapshot,
  KNOWLEDGE_TREE_PASSWORD_LOCK_BROADCAST_KEY,
  KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT,
  type KnowledgeTreeFolderLockReason,
} from "@/lib/knowledgeTreePassword";

export const FOLDER_BACKGROUND_LOCK_DELAY_MS = 5 * 60 * 1000;
export const FOLDER_AUTO_LOCK_OPTIONS: ReadonlyArray<{
  value: FolderAutoLockMinutes;
  label: string;
}> = [
  { value: 0, label: "不按闲置时间锁定" },
  { value: 5, label: "闲置 5 分钟" },
  { value: 15, label: "闲置 15 分钟（推荐）" },
  { value: 30, label: "闲置 30 分钟" },
  { value: 60, label: "闲置 1 小时" },
];

export interface KnowledgeTreeAutoLockOptions {
  idleMinutes: FolderAutoLockMinutes;
  lockOnBackground: boolean;
}

export function shouldLockAfterIdle(
  lastActivityAt: number,
  now: number,
  idleMinutes: FolderAutoLockMinutes,
): boolean {
  return idleMinutes > 0 && now - lastActivityAt >= idleMinutes * 60 * 1000;
}

export function shouldLockAfterBackground(backgroundAt: number, now: number): boolean {
  return now - backgroundAt >= FOLDER_BACKGROUND_LOCK_DELAY_MS;
}

export function installKnowledgeTreeAutoLock(options: KnowledgeTreeAutoLockOptions): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};

  let disposed = false;
  let lastActivityAt = Date.now();
  let backgroundAt: number | null = null;
  let deadlineTimer: number | null = null;
  let backgroundTimer: number | null = null;
  let nativeListener: { remove: () => Promise<void> } | null = null;

  const clearTimer = (timer: number | null) => {
    if (timer !== null) window.clearTimeout(timer);
  };

  const cancelTimers = () => {
    clearTimer(deadlineTimer);
    clearTimer(backgroundTimer);
    deadlineTimer = null;
    backgroundTimer = null;
  };

  const lock = (reason: KnowledgeTreeFolderLockReason, broadcast = true) => {
    const snapshot = getFolderUnlockSessionSnapshot();
    if (snapshot.folderIds.size === 0 && reason !== "expired") return;
    cancelTimers();
    backgroundAt = null;
    lastActivityAt = Date.now();
    clearFolderUnlockTokens({ reason, broadcast });
  };

  const scheduleBackground = () => {
    clearTimer(backgroundTimer);
    backgroundTimer = null;
    if (!options.lockOnBackground || backgroundAt === null) return;
    if (getFolderUnlockSessionSnapshot().folderIds.size === 0) return;
    const remaining = FOLDER_BACKGROUND_LOCK_DELAY_MS - (Date.now() - backgroundAt);
    if (remaining <= 0) {
      lock("background");
      return;
    }
    backgroundTimer = window.setTimeout(() => lock("background"), remaining);
  };

  const scheduleDeadline = () => {
    clearTimer(deadlineTimer);
    deadlineTimer = null;
    const snapshot = getFolderUnlockSessionSnapshot();
    if (snapshot.folderIds.size === 0) return;

    const idleDeadline = options.idleMinutes > 0
      ? lastActivityAt + options.idleMinutes * 60 * 1000
      : Number.POSITIVE_INFINITY;
    const expiryDeadline = snapshot.earliestExpiresAt ?? Number.POSITIVE_INFINITY;
    const deadline = Math.min(idleDeadline, expiryDeadline);
    if (!Number.isFinite(deadline)) return;

    const reason: KnowledgeTreeFolderLockReason = expiryDeadline <= idleDeadline ? "expired" : "idle";
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lock(reason);
      return;
    }
    deadlineTimer = window.setTimeout(() => lock(reason), remaining);
  };

  const scheduleAll = () => {
    scheduleDeadline();
    scheduleBackground();
  };

  const recordActivity = () => {
    if (backgroundAt !== null) return;
    lastActivityAt = Date.now();
    scheduleDeadline();
  };

  const enterBackground = () => {
    if (!options.lockOnBackground || getFolderUnlockSessionSnapshot().folderIds.size === 0) return;
    if (backgroundAt === null) backgroundAt = Date.now();
    scheduleBackground();
  };

  const enterForeground = () => {
    if (backgroundAt !== null && shouldLockAfterBackground(backgroundAt, Date.now())) {
      lock("background");
      return;
    }
    backgroundAt = null;
    recordActivity();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") enterBackground();
    else enterForeground();
  };

  const onSessionChanged = () => {
    const snapshot = getFolderUnlockSessionSnapshot();
    if (snapshot.folderIds.size === 0) {
      cancelTimers();
      backgroundAt = null;
      return;
    }
    lastActivityAt = Date.now();
    if (document.visibilityState === "hidden") enterBackground();
    scheduleAll();
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key !== KNOWLEDGE_TREE_PASSWORD_LOCK_BROADCAST_KEY || !event.newValue) return;
    clearFolderUnlockTokens({ reason: "remote", broadcast: false });
  };

  const onAccountChanged = () => {
    cancelTimers();
    backgroundAt = null;
    clearFolderUnlockTokens({ reason: "account-changed", broadcast: false });
  };
  const activityEvents: Array<keyof WindowEventMap> = [
    "pointerdown",
    "keydown",
    "touchstart",
    "wheel",
    "scroll",
  ];

  activityEvents.forEach((eventName) => {
    window.addEventListener(eventName, recordActivity, { passive: true });
  });
  window.addEventListener("blur", enterBackground);
  window.addEventListener("focus", enterForeground);
  window.addEventListener("storage", onStorage);
  window.addEventListener("nowen:token-changed", onAccountChanged);
  window.addEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, onSessionChanged);
  document.addEventListener("visibilitychange", onVisibilityChange);

  void import("@capacitor/app")
    .then(async ({ App }) => {
      const listener = await App.addListener("appStateChange", ({ isActive }) => {
        if (isActive) enterForeground();
        else enterBackground();
      });
      if (disposed) await listener.remove();
      else nativeListener = listener;
    })
    .catch(() => {
      // Web / Electron 环境通过 visibility、blur 和 focus 覆盖生命周期。
    });

  scheduleAll();

  return () => {
    disposed = true;
    cancelTimers();
    activityEvents.forEach((eventName) => {
      window.removeEventListener(eventName, recordActivity);
    });
    window.removeEventListener("blur", enterBackground);
    window.removeEventListener("focus", enterForeground);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("nowen:token-changed", onAccountChanged);
    window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, onSessionChanged);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (nativeListener) void nativeListener.remove();
  };
}
