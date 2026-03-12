import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

// 预设颜色面板 — 16 种常用标签颜色
const PRESET_COLORS = [
  "#f85149", // 红
  "#f0883e", // 橙
  "#d29922", // 黄
  "#7ee787", // 绿
  "#58a6ff", // 蓝
  "#bc8cff", // 紫
  "#f778ba", // 粉
  "#79c0ff", // 浅蓝
  "#56d4dd", // 青
  "#a5d6ff", // 天蓝
  "#ffa657", // 浅橙
  "#d2a8ff", // 浅紫
  "#ff7b72", // 浅红
  "#8b949e", // 灰
  "#e6edf3", // 浅灰
  "#ffffff", // 白
];

interface TagColorPickerProps {
  currentColor: string;
  onColorChange: (color: string) => void;
  /** 触发器大小 — sidebar 用小圆点，TagInput 用正常大小 */
  size?: "sm" | "md";
}

export default function TagColorPicker({ currentColor, onColorChange, size = "sm" }: TagColorPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // 面板定位：自动判断上下方向
  useEffect(() => {
    if (!open || !panelRef.current || !containerRef.current) return;
    const trigger = containerRef.current.getBoundingClientRect();
    const panel = panelRef.current;
    const spaceBelow = window.innerHeight - trigger.bottom;
    const spaceAbove = trigger.top;
    if (spaceBelow < 180 && spaceAbove > spaceBelow) {
      panel.style.bottom = "100%";
      panel.style.top = "auto";
      panel.style.marginBottom = "4px";
    } else {
      panel.style.top = "100%";
      panel.style.bottom = "auto";
      panel.style.marginTop = "4px";
    }
  }, [open]);

  const dotSize = size === "sm" ? "w-2 h-2" : "w-3 h-3";

  return (
    <div ref={containerRef} className="relative inline-flex">
      {/* 触发器：颜色圆点 */}
      <button
        type="button"
        className={`${dotSize} rounded-full shrink-0 ring-2 ring-transparent hover:ring-accent-primary/40 transition-all cursor-pointer`}
        style={{ backgroundColor: currentColor }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        title={t("tags.changeColor")}
      />

      {/* 颜色面板 */}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.12 }}
            className="absolute z-[100] left-1/2 -translate-x-1/2 w-[168px] p-2 bg-app-elevated border border-app-border rounded-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[10px] text-tx-tertiary mb-1.5 px-0.5">{t("tags.tagColor")}</p>
            <div className="grid grid-cols-8 gap-1">
              {PRESET_COLORS.map((color) => {
                const isActive = currentColor.toLowerCase() === color.toLowerCase();
                return (
                  <button
                    key={color}
                    type="button"
                    className={`w-4 h-4 rounded-full flex items-center justify-center transition-transform hover:scale-125 ${
                      isActive ? "ring-2 ring-accent-primary ring-offset-1 ring-offset-app-elevated" : ""
                    } ${color === "#ffffff" || color === "#e6edf3" ? "border border-app-border" : ""}`}
                    style={{ backgroundColor: color }}
                    onClick={() => {
                      onColorChange(color);
                      setOpen(false);
                    }}
                  >
                    {isActive && (
                      <Check size={10} className={color === "#ffffff" || color === "#e6edf3" ? "text-zinc-600" : "text-white"} strokeWidth={3} />
                    )}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
