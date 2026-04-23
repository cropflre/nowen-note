/**
 * useKeyboardVisible —— 订阅软键盘是否弹起以及当前高度。
 *
 * 单一事实来源：`useCapacitor.ts` 的 `useKeyboardLayout` 已经负责在键盘
 * will-show / will-hide 时写入：
 *   - `document.documentElement.dataset.keyboard = "open" | undefined`
 *   - `document.documentElement.style.setProperty("--keyboard-height", `${h}px`)`
 *
 * 本 hook 仅是"读侧"：
 *   - MutationObserver 监听 html 的 data-keyboard / style 变化
 *   - 同步返回 { visible, height } 给 UI 层
 *
 * 非原生平台（Web / Electron）下永远返回 { visible: false, height: 0 }，
 * 避免移动浏览器上 VisualViewport 事件抖动触发浮动工具栏闪烁。
 */

import { useEffect, useState } from "react";
import { isNativePlatform } from "./useCapacitor";

export interface KeyboardState {
  visible: boolean;
  height: number;
}

function readKeyboardState(): KeyboardState {
  if (typeof document === "undefined") return { visible: false, height: 0 };
  const html = document.documentElement;
  const visible = html.dataset.keyboard === "open";
  const raw = html.style.getPropertyValue("--keyboard-height").trim();
  // "300px" → 300；空串 / 0px → 0
  const n = parseFloat(raw);
  const height = Number.isFinite(n) && n > 0 ? n : 0;
  return { visible, height };
}

export function useKeyboardVisible(): KeyboardState {
  const [state, setState] = useState<KeyboardState>(() => readKeyboardState());

  useEffect(() => {
    // 非原生平台：始终隐藏，且不挂 observer
    if (!isNativePlatform()) {
      if (state.visible || state.height !== 0) {
        setState({ visible: false, height: 0 });
      }
      return;
    }

    if (typeof document === "undefined") return;
    const html = document.documentElement;

    // 首次挂载时取一次当前值（可能 useKeyboardLayout 已经先跑过）
    setState(readKeyboardState());

    const observer = new MutationObserver(() => {
      const next = readKeyboardState();
      setState((prev) =>
        prev.visible === next.visible && prev.height === next.height ? prev : next,
      );
    });

    observer.observe(html, {
      attributes: true,
      attributeFilter: ["data-keyboard", "style"],
    });

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
