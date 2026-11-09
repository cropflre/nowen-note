import { useLayoutEffect, useRef, type RefObject } from "react";
import useReducedMotion from "./useReducedMotion";

/**
 * 页面级切换（笔记 ↔ 任务 ↔ 日记 …）时给主内容槽做一次轻量淡入。
 *
 * - 只动 opacity：不引入 transform，避免动画期间 fixed 子元素改用该容器做定位基准；
 * - 不改各视图容器的 className / 结构（它们受布局契约测试保护），而是在 App 外壳上
 *   查找 `:scope > .flex-1` 这个唯一的弹性主槽，用 Web Animations API 播放；
 * - 同一视图内的导航（切笔记本、切笔记）key 不变，不会触发；
 * - 首次渲染、减少动态效果、或运行环境不支持 Element.animate 时直接跳过。
 */
export function useViewSwitchFade(shellRef: RefObject<HTMLElement | null>, viewKey: string): void {
  const reduceMotion = useReducedMotion();
  const previousKey = useRef(viewKey);

  useLayoutEffect(() => {
    if (previousKey.current === viewKey) return;
    previousKey.current = viewKey;
    if (reduceMotion) return;
    const slot = shellRef.current?.querySelector<HTMLElement>(":scope > .flex-1");
    if (!slot || typeof slot.animate !== "function") return;
    // 与 --motion-duration-normal / --motion-ease-standard 保持一致。
    slot.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 200,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  }, [reduceMotion, shellRef, viewKey]);
}

export default useViewSwitchFade;
