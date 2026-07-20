/**
 * useNetworkStatus — 网络在线/离线状态探测
 * =========================================================================
 *
 * 提供：
 *   - isOnline: boolean     当前是否在线
 *   - wasOffline: boolean   真实离线期间存在本地修改，且恢复后已成功同步
 *   - pendingCount: number  离线队列中待同步的操作数
 *
 * 探测策略：
 *   1) navigator.onLine + window online/offline 事件（即时感知）
 *   2) 每 30s 对后端 health endpoint 发 HEAD 探活（防止 navigator.onLine 误报——
 *      某些平台连着 Wi-Fi 但网关不通时 onLine 仍为 true）
 *   3) 页面恢复可见时只做静默探活，不把“仍然在线”误判成“离线恢复”
 *
 * 与离线队列联动：
 *   - 只有队列非空时才执行同步，普通标签页切换不会强制 syncNow()
 *   - 只有真实离线期间产生/保留过待同步修改，且恢复后队列成功清空，
 *     才短暂发出 wasOffline=true，供 UI 显示一次恢复成功提示
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { getBaseUrl } from "@/lib/api";
import { getQueueLength, subscribe } from "@/lib/offlineQueue";
import { syncNow } from "@/lib/syncEngine";

const PROBE_INTERVAL = 30_000;
const PROBE_TIMEOUT = 3_000;
const RECOVERY_SIGNAL_DURATION = 5_000;

export interface RecoverySignalInput {
  wasActuallyOffline: boolean;
  pendingBefore: number;
  pendingAfter: number;
  flushSucceeded: boolean;
}

export function shouldSignalRecoveredOfflineChanges({
  wasActuallyOffline,
  pendingBefore,
  pendingAfter,
  flushSucceeded,
}: RecoverySignalInput): boolean {
  return wasActuallyOffline
    && pendingBefore > 0
    && pendingAfter === 0
    && flushSucceeded;
}

export function useNetworkStatus() {
  const initialOnline = navigator.onLine;
  const initialQueueLength = getQueueLength();
  const [isOnline, setIsOnline] = useState(initialOnline);
  const [wasOffline, setWasOffline] = useState(false);
  const [pendingCount, setPendingCount] = useState(initialQueueLength);

  const mountedRef = useRef(true);
  const onlineRef = useRef(initialOnline);
  const offlineObservedRef = useRef(!initialOnline);
  const offlinePendingPeakRef = useRef(!initialOnline ? initialQueueLength : 0);
  const recoveryPendingCountRef = useRef(0);
  const recoverySignalActiveRef = useRef(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probePromiseRef = useRef<Promise<boolean> | null>(null);
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current !== null) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  const hideRecoverySignal = useCallback(() => {
    clearRecoveryTimer();
    recoverySignalActiveRef.current = false;
    if (mountedRef.current) setWasOffline(false);
  }, [clearRecoveryTimer]);

  const showRecoverySignal = useCallback(() => {
    if (recoverySignalActiveRef.current) return;
    recoverySignalActiveRef.current = true;
    if (mountedRef.current) setWasOffline(true);
    clearRecoveryTimer();
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      recoverySignalActiveRef.current = false;
      if (mountedRef.current) setWasOffline(false);
    }, RECOVERY_SIGNAL_DURATION);
  }, [clearRecoveryTimer]);

  // 探活采用 single-flight：快速切换标签页时复用同一个请求，避免请求风暴。
  const probe = useCallback((): Promise<boolean> => {
    if (probePromiseRef.current) return probePromiseRef.current;

    let request: Promise<boolean>;
    request = (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
      try {
        const res = await fetch(`${getBaseUrl()}/health`, {
          method: "HEAD",
          cache: "no-store",
          signal: controller.signal,
        });
        return res.ok || res.status === 404;
      } catch {
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    probePromiseRef.current = request;
    void request.finally(() => {
      if (probePromiseRef.current === request) probePromiseRef.current = null;
    });
    return request;
  }, []);

  // 同步同样采用 single-flight。force 仅供用户主动“重试”使用；自动流程永不强制空队列同步。
  const doFlush = useCallback((force = false): Promise<boolean> => {
    if (flushPromiseRef.current) return flushPromiseRef.current;
    if (!force && getQueueLength() === 0) {
      if (mountedRef.current) setPendingCount(0);
      return Promise.resolve(true);
    }

    let request: Promise<boolean>;
    request = (async () => {
      try {
        await syncNow();
        return true;
      } catch (error) {
        console.warn("[useNetworkStatus] sync failed:", error);
        return false;
      } finally {
        if (mountedRef.current) setPendingCount(getQueueLength());
        if (flushPromiseRef.current === request) flushPromiseRef.current = null;
      }
    })();

    flushPromiseRef.current = request;
    return request;
  }, []);

  const markOffline = useCallback(() => {
    onlineRef.current = false;
    offlineObservedRef.current = true;
    offlinePendingPeakRef.current = Math.max(
      offlinePendingPeakRef.current,
      getQueueLength(),
    );
    hideRecoverySignal();
    if (mountedRef.current) setIsOnline(false);
  }, [hideRecoverySignal]);

  const confirmReachability = useCallback(async () => {
    const alive = await probe();
    if (!mountedRef.current) return false;

    // 浏览器明确报告离线时，不允许一个过期的探活结果把状态重新覆盖为在线。
    if (!alive || !navigator.onLine) {
      markOffline();
      return false;
    }

    const wasActuallyOffline = offlineObservedRef.current || !onlineRef.current;
    if (wasActuallyOffline) {
      recoveryPendingCountRef.current = Math.max(
        recoveryPendingCountRef.current,
        offlinePendingPeakRef.current,
        getQueueLength(),
      );
      offlineObservedRef.current = false;
      offlinePendingPeakRef.current = 0;
    }

    onlineRef.current = true;
    setIsOnline(true);

    const pendingBefore = recoveryPendingCountRef.current;
    const queueLength = getQueueLength();
    if (queueLength === 0) {
      // 真实恢复但没有离线修改时保持静默。
      if (wasActuallyOffline) recoveryPendingCountRef.current = 0;
      setPendingCount(0);
      return true;
    }

    const flushSucceeded = await doFlush(false);
    if (!mountedRef.current) return flushSucceeded;

    const pendingAfter = getQueueLength();
    setPendingCount(pendingAfter);

    if (shouldSignalRecoveredOfflineChanges({
      wasActuallyOffline: wasActuallyOffline || pendingBefore > 0,
      pendingBefore,
      pendingAfter,
      flushSucceeded,
    })) {
      recoveryPendingCountRef.current = 0;
      showRecoverySignal();
    }

    return flushSucceeded;
  }, [doFlush, markOffline, probe, showRecoverySignal]);

  useEffect(() => {
    mountedRef.current = true;

    const handleOnline = () => {
      void confirmReachability();
    };

    const handleOffline = () => {
      markOffline();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // 只确认可达性。若此前一直在线，不产生恢复信号，也不强制空队列同步。
        void confirmReachability();
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const interval = setInterval(() => {
      void confirmReachability();
    }, PROBE_INTERVAL);

    void confirmReachability();

    return () => {
      mountedRef.current = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearInterval(interval);
      clearRecoveryTimer();
    };
  }, [clearRecoveryTimer, confirmReachability, markOffline]);

  useEffect(() => {
    const unsub = subscribe((count: number) => {
      setPendingCount(count);
      if (!onlineRef.current || offlineObservedRef.current) {
        offlinePendingPeakRef.current = Math.max(offlinePendingPeakRef.current, count);
      }
    });
    return unsub;
  }, []);

  return { isOnline, wasOffline, pendingCount, flush: doFlush };
}
