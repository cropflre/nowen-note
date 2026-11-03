/**
 * 「手动刷新」总线 —— 右上角刷新键按下后，让**当前页面**重新从服务端拉最新数据。
 *
 * 为什么用总线：刷新键挂在 App 的固定层（不塞进每个页面的顶栏），
 * 而数据加载逻辑在各页面内部。页面挂载时注册自己的 reload，卸载时注销，
 * 因此同一时刻只会执行当前页面的那一个处理器。
 *
 * 刷新期间 busy>0，刷新键显示旋转态；失败不在这里吞异常（页面自己会显示错误）。
 */
import { useEffect, useRef, useState } from "react";

type RefreshHandler = () => void | Promise<void>;

let handler: RefreshHandler | null = null;
let busy = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** 页面注册自己的重载函数（用 ref 保存最新实现，避免每次渲染反复注册） */
export function useRefreshHandler(fn: RefreshHandler): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    handler = () => ref.current();
    return () => {
      handler = null;
    };
  }, []);
}

/** 触发一次刷新；没有处理器时静默返回。 */
export async function requestRefresh(): Promise<void> {
  const current = handler;
  if (!current) return;
  busy += 1;
  notify();
  try {
    await current();
  } finally {
    busy -= 1;
    notify();
  }
}

export function useRefreshing(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return busy > 0;
}
