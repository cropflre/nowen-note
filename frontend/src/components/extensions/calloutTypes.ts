/**
 * 高亮块（Callout）类型元数据 —— 单一事实来源。
 *
 * 对齐语雀高亮块配色：10 色色板（灰/蓝/青/绿/黄/橙/红/粉/紫），选色器为横排圆角色块行
 * （与语雀截图一致：当前项 ✓ 标记，无文字标签）。
 *
 * swatch 颜色与 dragHandle.css 里 div[data-type="callout"][data-callout-type=...] 的底色完全一致，
 * 选择器里的色块就是块本身的颜色（所见即所得）。
 */

export type CalloutType =
  | "gray"
  | "blue"
  | "cyan"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "pink"
  | "purple";

export interface CalloutTypeMeta {
  label: string;
  emoji: string;
  /** 浅色模式块底色 */
  swatch: string;
  /** 深色模式块底色 */
  swatchDark: string;
}

/** 对齐语雀 10 色高亮块色板（顺序 = 选色器展示顺序） */
export const CALLOUT_TYPE_META: Record<CalloutType, CalloutTypeMeta> = {
  gray: {
    label: "默认",
    emoji: "📋",
    swatch: "#f7f8fa",
    swatchDark: "rgba(150, 150, 150, 0.16)",
  },
  blue: {
    label: "信息",
    emoji: "ℹ️",
    swatch: "#eef3fb",
    swatchDark: "rgba(59, 130, 246, 0.16)",
  },
  cyan: {
    label: "提示",
    emoji: "💧",
    swatch: "#e6f7fa",
    swatchDark: "rgba(6, 182, 212, 0.16)",
  },
  green: {
    label: "成功",
    emoji: "✅",
    swatch: "#e8f6ee",
    swatchDark: "rgba(34, 197, 94, 0.16)",
  },
  yellow: {
    label: "注意",
    emoji: "⚠️",
    swatch: "#fdf6e3",
    swatchDark: "rgba(245, 158, 11, 0.16)",
  },
  orange: {
    label: "重要",
    emoji: "🔶",
    swatch: "#fef3e6",
    swatchDark: "rgba(249, 115, 22, 0.16)",
  },
  red: {
    label: "危险",
    emoji: "🚫",
    swatch: "#fdeeee",
    swatchDark: "rgba(239, 68, 68, 0.16)",
  },
  pink: {
    label: "错误",
    emoji: "❌",
    swatch: "#fef0f3",
    swatchDark: "rgba(236, 72, 153, 0.16)",
  },
  purple: {
    label: "引用",
    emoji: "💡",
    swatch: "#f3f0fc",
    swatchDark: "rgba(139, 92, 246, 0.16)",
  },
};

/** 顺序即选择器里的展示顺序（横排从左到右） */
export const CALLOUT_TYPE_ORDER: CalloutType[] = [
  "gray", "blue", "cyan", "green", "yellow", "orange", "red", "pink", "purple",
];

export function calloutEmojiOf(type: string | undefined): string {
  const t = (type as CalloutType) ?? "blue";
  return CALLOUT_TYPE_META[t]?.emoji ?? CALLOUT_TYPE_META.blue.emoji;
}
