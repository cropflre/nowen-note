/**
 * 服务端连接状态 —— 延迟 + 可用性。
 *
 * 用 /api/health 探活：它不需要鉴权、真实服务端与 mock 都有，是最干净的一根探针。
 * 只测这一根，不拿业务接口去测（业务接口可能因为权限/参数失败，那不算"连不上"）。
 *
 * 轮询策略：可见时才轮询（页面切到后台就停），避免手机后台白耗电。
 */
import { useEffect, useState } from "react";
import { getServerUrl } from "../auth/auth";
import { ensureScheme } from "./serverAddress";

const BADGE_KEY = "nowen-lite.conn-badge";
const POLL_MS = 30_000;

export type ConnState = "idle" | "checking" | "ok" | "slow" | "fail";

export interface ConnStatus {
  state: ConnState;
  /** 往返毫秒；失败时为 null */
  latency: number | null;
  /** 最近一次成功探测的时间戳 */
  at: number | null;
  version?: string;
}

/** 「慢」的阈值：超过它就算黄灯（局域网内一般 <50ms） */
export const SLOW_MS = 800;

export function isBadgeEnabled(): boolean {
  try {
    return localStorage.getItem(BADGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setBadgeEnabled(on: boolean): void {
  try {
    localStorage.setItem(BADGE_KEY, on ? "1" : "0");
  } catch {
    /* 隐私模式 */
  }
  for (const fn of listeners) fn();
}

let current: ConnStatus = { state: "idle", latency: null, at: null };
const listeners = new Set<() => void>();

function emit(next: ConnStatus): void {
  current = next;
  for (const fn of listeners) fn();
}

/** 探一次；返回最新状态。失败不抛，转成 fail 状态。 */
export async function probeConnection(): Promise<ConnStatus> {
  emit({ ...current, state: "checking" });
  const base = ensureScheme(getServerUrl());
  const started = performance.now();
  try {
    const res = await fetch(`${base}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const latency = Math.round(performance.now() - started);
    if (!res.ok) {
      emit({ state: "fail", latency: null, at: current.at });
      return current;
    }
    const data = (await res.json().catch(() => ({}))) as { version?: string };
    emit({
      state: latency >= SLOW_MS ? "slow" : "ok",
      latency,
      at: Date.now(),
      version: data.version,
    });
  } catch {
    emit({ state: "fail", latency: null, at: current.at });
  }
  return current;
}

/** 组件订阅 */
export function useConnStatus(): ConnStatus {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return current;
}

/** 全局轮询（只在页面可见时跑） */
export function useConnPolling(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const tick = () => {
      if (document.visibilityState === "visible") void probeConnection();
    };
    tick();
    timer = window.setInterval(tick, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled]);
}
