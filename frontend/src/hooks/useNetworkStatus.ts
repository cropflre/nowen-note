/**
 * useNetworkStatus — 网络在线/离线状态探测
 * =========================================================================
 *
 * 提供：
 *   - isOnline: boolean     当前是否在线
 *   - wasOffline: boolean   自上次在线以来是否经历过离线（用于 UI 提示"已恢复"）
 *   - pendingCount: number  离线队列中待同步的操作数
 *
 * 探测策略：
 *   1) navigator.onLine + window online/offline 事件（即时感知）
 *   2) 每 30s 对后端 health endpoint 发 HEAD 探活（防止 navigator.onLine 误报——
 *      某些平台连着 Wi-Fi 但网关不通时 onLine 仍为 true）
 *   3) online 事件触发时立即探活一次（快速确认）
 *
 * 与离线队列联动：
 *   online 恢复时自动触发 offlineQueue.flushQueue()
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { getBaseUrl } from "@/lib/api";
import { getQueueLength, subscribe } from "@/lib/offlineQueue";
import { syncNow } from "@/lib/syncEngine";

const PROBE_INTERVAL = 30_000; // 30s

export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [wasOffline, setWasOffline] = useState(false);
  const [pendingCount, setPendingCount] = useState(() => getQueueLength());
  const flushingRef = useRef(false);

  // 探活：HEAD 请求后端（不走 request() 避免鸡蛋问题）
  const probe = useCallback(async (): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${getBaseUrl()}/health`, {
        method: "HEAD",
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return res.ok || res.status === 404; // 后端没有 /health 但能连通也算在线
    } catch {
      return false;
    }
  }, []);

  // flush 队列
  const doFlush = useCallback(async (force = false) => {
    if (flushingRef.current) return;
    if (!force && getQueueLength() === 0) return;
    flushingRef.current = true;
    try {
      await syncNow();
    } finally {
      flushingRef.current = false;
      setPendingCount(getQueueLength());
    }
  }, []);

  useEffect(() => {
    const handleOnline = async () => {
      // 确认真正在线
      const alive = await probe();
      if (alive) {
        setIsOnline(true);
        setWasOffline(true);
        // 恢复后自动 flush
        doFlush(true);
        // 5s 后清除 wasOffline 提示
        setTimeout(() => setWasOffline(false), 5000);
      }
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void handleOnline();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // 定期探活
    const interval = setInterval(async () => {
      const alive = await probe();
      setIsOnline(alive);
      if (alive && getQueueLength() > 0) {
        doFlush(true);
      }
    }, PROBE_INTERVAL);

    // 初始探活
    probe().then((alive) => {
      setIsOnline(alive);
      if (alive && getQueueLength() > 0) {
        doFlush(true);
      }
    });

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearInterval(interval);
    };
  }, [probe, doFlush]);

  // 订阅队列变化
  useEffect(() => {
    const unsub = subscribe((count: number) => setPendingCount(count));
    return unsub;
  }, []);

  return { isOnline, wasOffline, pendingCount, flush: doFlush };
}
