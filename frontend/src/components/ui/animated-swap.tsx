import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { swapMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * 原地切换的小块状态内容（图标 / 短标记），例如 loading → success → error。
 *
 * 新旧内容叠放在同一个 grid 单元里交叉淡入（不是先退后进），因此不会闪空、
 * 也不会撑开或挤动相邻文字。swapKey 不变时只是普通重渲染，不重播动画；
 * 首次挂载不播放进入动画。
 */
export function AnimatedSwap({
  swapKey,
  children,
  className,
}: {
  swapKey: string | number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-grid shrink-0 place-items-center", className)}>
      <AnimatePresence initial={false}>
        <motion.span
          key={swapKey}
          className="col-start-1 row-start-1 inline-flex items-center justify-center"
          initial={swapMotion.initial}
          animate={swapMotion.animate}
          exit={swapMotion.exit}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export default AnimatedSwap;
