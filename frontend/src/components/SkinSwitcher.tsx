import React from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { useSkin, type Skin } from "@/hooks/useSkin";
import { cn } from "@/lib/utils";

/**
 * 外观"风格"切换器（Skin）。
 *
 * 与 ThemeToggle（明/暗/跟随系统）是正交的两个维度，按 Apple 系统偏好设置
 * 的习惯拆成两块而非拧成一个下拉。
 *
 * 视觉采用 2-up 预览卡片（Apple"桌面与程序坞"里选壁纸那种），每张卡片用对应
 * 皮肤的代表色做迷你预览——用户无需切换就能看到差异。
 */

type SkinDescriptor = {
  key: Skin;
  titleKey: string;
  titleDefault: string;
  descKey: string;
  descDefault: string;
  /** 小预览色板：[窗口底, 侧栏, 强调] */
  swatch: {
    bg: string;
    sidebar: string;
    accent: string;
    text: string;
  };
};

const SKINS: SkinDescriptor[] = [
  {
    key: "default",
    titleKey: "appearance.skinDefault",
    titleDefault: "默认",
    descKey: "appearance.skinDefaultDesc",
    descDefault: "现代简约风格，跨平台一致",
    swatch: {
      bg: "#ffffff",
      sidebar: "#f3f4f6",
      accent: "#3b82f6",
      text: "#111827",
    },
  },
  {
    key: "macos",
    titleKey: "appearance.skinMacos",
    titleDefault: "macOS",
    descKey: "appearance.skinMacosDesc",
    descDefault: "Apple 设计语言，毛玻璃与系统蓝",
    swatch: {
      bg: "#ECECEC",
      sidebar: "rgba(246,246,246,0.85)",
      accent: "#007AFF",
      text: "#000000",
    },
  },
];

export default function SkinSwitcher() {
  const { t } = useTranslation();
  const { skin, setSkin } = useSkin();

  return (
    <div className="grid grid-cols-2 gap-3">
      {SKINS.map((item) => {
        const selected = skin === item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => setSkin(item.key)}
            className={cn(
              "group relative text-left p-3 rounded-xl border-2 transition-all",
              "focus:outline-none",
              selected
                ? "border-accent-primary bg-accent-primary/5"
                : "border-app-border hover:border-tx-tertiary bg-app-surface"
            )}
          >
            {/* 预览画布：窗口 + 侧栏 + 内容区 + 强调点 */}
            <div
              className="relative h-20 rounded-lg overflow-hidden mb-3 border border-app-border"
              style={{ background: item.swatch.bg }}
            >
              {/* 侧栏 */}
              <div
                className="absolute left-0 top-0 bottom-0 w-1/3"
                style={{ background: item.swatch.sidebar }}
              />
              {/* 三个 macOS 风窗口按钮（纯装饰，两个皮肤都画以保持视觉一致） */}
              <div className="absolute left-2 top-2 flex gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: "#FF5F57" }} />
                <span className="w-2 h-2 rounded-full" style={{ background: "#FEBC2E" }} />
                <span className="w-2 h-2 rounded-full" style={{ background: "#28C840" }} />
              </div>
              {/* 正文区"假文字" */}
              <div className="absolute left-[38%] right-3 top-3 space-y-1.5">
                <div
                  className="h-1.5 w-2/3 rounded-full opacity-80"
                  style={{ background: item.swatch.text }}
                />
                <div
                  className="h-1.5 w-1/2 rounded-full opacity-40"
                  style={{ background: item.swatch.text }}
                />
                <div
                  className="h-1.5 w-3/4 rounded-full opacity-30"
                  style={{ background: item.swatch.text }}
                />
              </div>
              {/* 强调色小按钮 */}
              <div
                className="absolute right-3 bottom-3 h-3 w-6 rounded-md"
                style={{ background: item.swatch.accent }}
              />
            </div>

            {/* 标题 + 描述 */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-tx-primary truncate">
                  {t(item.titleKey, { defaultValue: item.titleDefault })}
                </div>
                <div className="text-xs text-tx-tertiary mt-0.5 line-clamp-2">
                  {t(item.descKey, { defaultValue: item.descDefault })}
                </div>
              </div>
              {selected && (
                <motion.div
                  layoutId="skin-selected-check"
                  className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-accent-primary flex items-center justify-center"
                  transition={{ type: "spring", duration: 0.3, bounce: 0.2 }}
                >
                  <Check size={12} className="text-white" strokeWidth={3} />
                </motion.div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
