import { useEffect, useRef } from "react";
import { api } from "@/lib/api";

/**
 * Background reminder notifier.
 *
 * Strategy:
 *   1. Frontend polls GET /api/task-reminders/recent?since=<ms> every 30s
 *   2. Backend scanner (30s interval) detects due reminders and stores them
 *      in a 5-min ring buffer, keyed by userId
 *   3. Uses session-local notifiedSet to deduplicate
 *   4. Stops polling when tab is hidden
 */

interface RecentReminder {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  triggeredAt: number;
}

// Session-scoped dedup set (cleared on full page reload, survives HMR)
const globalKey = "__nowen_notified_set__";
const notifiedSet: Set<string> =
  (window as any)[globalKey] || ((window as any)[globalKey] = new Set());

function sendNotification(title: string, body: string) {
  // Try Electron first
  const desktop = (window as any).nowenDesktop;
  if (desktop?.taskNotify) {
    desktop.taskNotify(title, body).catch(() => {});
    return;
  }
  // Browser Notification API
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, { body });
    } catch {
      // silently ignore
    }
  }
}

function getAuthHeaders(): Record<string, string> {
  // Try to get auth token from localStorage or cookie
  const token = localStorage.getItem("token") || localStorage.getItem("authToken") || "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export function useReminderNotifier() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastScanRef = useRef<number>(Date.now());
  const permissionRequestedRef = useRef(false);

  useEffect(() => {
    // Request notification permission once on mount (if not Electron)
    const requestPermission = async () => {
      if (permissionRequestedRef.current) return;
      const desktop = (window as any).nowenDesktop;
      if (desktop?.taskNotify) return; // Electron has native notifications
      if ("Notification" in window && Notification.permission === "default") {
        permissionRequestedRef.current = true;
        // Don't auto-request; let the test button trigger it
      }
    };
    requestPermission();

    const scan = async () => {
      try {
        // Poll backend recent reminders endpoint
        try {
          const res = await fetch(
            `/api/task-reminders/recent?since=${lastScanRef.current}`,
            { headers: getAuthHeaders() }
          );
          if (res.ok) {
            const data = await res.json();
            const recent: RecentReminder[] = data.reminders || [];
            for (const r of recent) {
              if (notifiedSet.has(r.reminderId)) continue;
              notifiedSet.add(r.reminderId);
              sendNotification(
                `\u23F0 ${r.taskTitle}`,
                r.taskTitle
              );
            }
          }
        } catch {
          // fallback to test-now
        }

        lastScanRef.current = Date.now();
      } catch {
        // ignore network errors
      }
    };

    // Initial scan after 3s
    const initialTimeout = setTimeout(scan, 3000);

    // Poll every 30s when visible
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (!timerRef.current) {
          timerRef.current = setInterval(scan, 30000);
        }
      } else {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") {
      timerRef.current = setInterval(scan, 30000);
    }

    return () => {
      clearTimeout(initialTimeout);
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
