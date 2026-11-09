import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from "lucide-react";
import { subscribeToasts, ToastItem, toast } from "@/lib/toast";
import { MOTION_SPRING, toastMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

const ICONS: Record<ToastItem["type"], React.ReactNode> = {
  success: <CheckCircle2 size={16} className="text-emerald-500" />,
  error: <AlertCircle size={16} className="text-red-500" />,
  info: <Info size={16} className="text-blue-500" />,
  warning: <AlertTriangle size={16} className="text-amber-500" />,
};

const ACCENTS: Record<ToastItem["type"], string> = {
  success: "border-emerald-500/30",
  error: "border-red-500/30",
  info: "border-blue-500/30",
  warning: "border-amber-500/30",
};

/**
 * popLayout 模式下 AnimatePresence 需要拿到 DOM ref 来把退出中的 toast 移出文档流，
 * 其余 toast 才能立即用 layout 弹簧补位，而不是等退出结束后瞬跳。
 */
const ToastCard = React.forwardRef<HTMLDivElement, { item: ToastItem }>(function ToastCard({ item }, ref) {
  // 退出动画期间不再接收点击，避免连点“关闭”或误触到正在消失的卡片。
  const isPresent = useIsPresent();
  return (
    <motion.div
      ref={ref}
      layout="position"
      initial={toastMotion.initial}
      animate={toastMotion.animate}
      exit={toastMotion.exit}
      transition={{ layout: MOTION_SPRING.layout }}
      aria-hidden={isPresent ? undefined : true}
      className={cn(
        "flex items-center gap-2 px-3.5 py-2.5 rounded-lg shadow-popover",
        "bg-app-elevated border text-sm text-tx-primary max-w-[480px]",
        isPresent ? "pointer-events-auto" : "pointer-events-none",
        ACCENTS[item.type]
      )}
    >
      <motion.span
        className="flex shrink-0"
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ ...MOTION_SPRING.snappy, delay: 0.04 }}
      >
        {ICONS[item.type]}
      </motion.span>
      <span className="flex-1 break-words">{item.message}</span>
      <button
        onClick={() => toast.dismiss(item.id)}
        className="p-0.5 rounded hover:bg-app-hover text-tx-tertiary hover:text-tx-secondary transition-colors"
        aria-label="dismiss"
      >
        <X size={14} />
      </button>
    </motion.div>
  );
});

export default function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setItems), []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      // 固定宽度容器：退出中的 toast 被移出文档流时，容器不会因最宽项消失而重新居中。
      className="pointer-events-none fixed top-4 left-1/2 -translate-x-1/2 z-[9999] flex w-[min(480px,calc(100vw-2rem))] flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {items.map((it) => (
          <ToastCard key={it.id} item={it} />
        ))}
      </AnimatePresence>
    </div>,
    document.body
  );
}
