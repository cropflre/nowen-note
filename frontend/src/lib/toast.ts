// 轻量级 Toast 系统：事件总线 + 单例 Toaster 组件消费
// 不依赖第三方库，支持 success / error / info / warning 四种类型

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

type Listener = (items: ToastItem[]) => void;

type RecentToast = {
  id: number;
  createdAt: number;
};

const DUPLICATE_TOAST_WINDOW_MS = 900;

let items: ToastItem[] = [];
let seq = 1;
const listeners = new Set<Listener>();
const recentByKey = new Map<string, RecentToast>();

function emit() {
  // 复制一份，避免订阅端直接持有内部引用
  const snapshot = items.slice();
  listeners.forEach((l) => l(snapshot));
}

function toastKey(type: ToastType, message: string): string {
  return `${type}\u0000${message}`;
}

function remove(id: number) {
  items = items.filter((it) => it.id !== id);
  for (const [key, recent] of recentByKey) {
    if (recent.id === id) recentByKey.delete(key);
  }
  emit();
}

function push(type: ToastType, message: string, duration = 2800): number {
  const now = Date.now();
  const key = toastKey(type, message);
  const recent = recentByKey.get(key);

  // Android WebView can dispatch both touch/click paths before React finishes
  // disabling a create button. Keep the first notification and collapse only the
  // near-simultaneous duplicates; later legitimate messages remain visible.
  if (
    recent
    && now - recent.createdAt < DUPLICATE_TOAST_WINDOW_MS
    && items.some((item) => item.id === recent.id)
  ) {
    return recent.id;
  }

  const id = seq++;
  items = [...items, { id, type, message, duration }];
  recentByKey.set(key, { id, createdAt: now });
  emit();
  if (duration > 0) {
    window.setTimeout(() => remove(id), duration);
  }
  return id;
}

export const toast = {
  success: (message: string, duration?: number) => push("success", message, duration),
  error: (message: string, duration?: number) => push("error", message, duration),
  info: (message: string, duration?: number) => push("info", message, duration),
  warning: (message: string, duration?: number) => push("warning", message, duration),
  dismiss: (id: number) => remove(id),
};

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  // 立即回送当前状态
  listener(items.slice());
  return () => { listeners.delete(listener); };
}
