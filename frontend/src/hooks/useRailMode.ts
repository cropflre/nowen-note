/**
 * useRailMode（v16 P3 后续：Rail 视觉模式三档）
 *
 * 演进自 useRailHidden（布尔）。把"是否显示 Rail"和"Rail 是否带文字标签"
 * 合并为同一个三档枚举，统一管理 Rail 的视觉形态：
 *
 *   - "icon"   : 48px 纯图标（默认，紧凑、与早期 P3 设计一致）
 *   - "label"  : 64px 图标 + 下方 10px 标签文字（识别度优先，企微/钉钉风格）
 *   - "hidden" : 完全隐藏 Rail，腾出 48px 给编辑器（窄屏 / 长篇写作）
 *
 * 设计要点：
 * - 偏好持久化在 localStorage（key=nowen-rail-mode）。
 * - 跨 tab 同步：监听 storage 事件；同 tab 内多组件同步：自定义事件 nowen:rail-mode-changed。
 *   这样 App.tsx（控制是否渲染）/ NavRail（自身样式）/ 布局控制器（显式选择）
 *   可以独立调用而无需 state 提升或塞进 AppContext reducer。
 * - 不进 AppContext：纯 UI 偏好，没有跨业务联动；提到 reducer 反而是过度设计。
 *
 * 与 sidebarCollapsed 的边界约束：
 *   sidebarCollapsed=true（主侧栏折叠）+ mode="hidden"（Rail 也隐藏）= 完全无侧栏入口（死局）。
 *   约束在 UI 层执行——App.tsx 用 `mode !== "hidden" || sidebarCollapsed` 强制 Rail 在
 *   折叠态下出现，避免用户找不到任何导航入口。
 */
import { useCallback, useEffect, useState } from "react";

export type RailMode = "icon" | "label" | "hidden";

/** Rail 三档循环切换的固定顺序（用于"按一下按钮切到下一档"的入口） */
export const RAIL_MODE_CYCLE: readonly RailMode[] = ["icon", "label", "hidden"] as const;

const STORAGE_KEY = "nowen-rail-mode";
const SYNC_EVENT = "nowen:rail-mode-changed";
const DEFAULT_MODE: RailMode = "icon";

function isValid(v: string | null): v is RailMode {
  return v === "icon" || v === "label" || v === "hidden";
}

function readFromStorage(): RailMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isValid(v) ? v : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function useRailMode(): readonly [RailMode, (v: RailMode) => void] {
  const [mode, setMode] = useState<RailMode>(readFromStorage);

  useEffect(() => {
    // 跨 tab：localStorage 写入会在其他 tab 触发 storage 事件
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setMode(readFromStorage());
    };
    // 同 tab：localStorage 写入不会触发自身 storage 事件，需自定义事件转发
    const onLocal = () => setMode(readFromStorage());

    window.addEventListener("storage", onStorage);
    window.addEventListener(SYNC_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SYNC_EVENT, onLocal);
    };
  }, []);

  const set = useCallback((v: RailMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      /* noop：localStorage 不可用时降级为内存态，下次刷新丢失也能接受 */
    }
    // 通知同 tab 其他订阅者
    window.dispatchEvent(new Event(SYNC_EVENT));
    setMode(v);
  }, []);

  return [mode, set] as const;
}

/** 取下一档（icon → label → hidden → icon …），用于按钮循环切换 */
export function nextRailMode(current: RailMode): RailMode {
  const idx = RAIL_MODE_CYCLE.indexOf(current);
  return RAIL_MODE_CYCLE[(idx + 1) % RAIL_MODE_CYCLE.length];
}
