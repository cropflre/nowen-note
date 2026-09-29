import { useEffect, useState } from "react";

function readVisibleViewport() {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const html = document.documentElement;
  const keyboardHeight = html.dataset.keyboard === "open"
    ? Math.max(0, Number.parseFloat(html.style.getPropertyValue("--keyboard-height")) || 0)
    : 0;
  // 浏览器使用可视视口；Android adjustNothing 模式还需扣除覆盖在 WebView 上的键盘。
  // 两者取较小的底边，避免原生事件与视口事件同时到达时重复避让。
  const bottom = Math.min(top + (viewport?.height ?? window.innerHeight), window.innerHeight - keyboardHeight);
  return {
    top,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: Math.max(0, bottom - top),
  };
}

/** 只在浮层打开期间跟踪可用区域，不改变页面或编辑器的整体高度。 */
export function useVisibleViewport(enabled: boolean) {
  const [bounds, setBounds] = useState(readVisibleViewport);
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const update = () => {
      const next = readVisibleViewport();
      setBounds((previous) => previous.top === next.top && previous.left === next.left
        && previous.width === next.width && previous.height === next.height ? previous : next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const viewport = window.visualViewport;
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-keyboard"] });
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
  }, [enabled]);
  return bounds;
}
