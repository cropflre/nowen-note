/**
 * 界面风格（皮肤）—— 与 Nowen Note 标准版同一种做法：切皮肤 = 切一组 CSS 令牌，
 * 组件代码一行都不用改（标准版用的是 `data-skin` + 语义 `--radius-*`）。
 *
 * 两套皮肤：
 *   native  原生 —— 对齐标准版 index.css 的 --color-* 一套：
 *           不透明表面、无模糊、小圆角（卡片 10px / 字段 6px）
 *   liquid  液态玻璃 —— 折射（backdrop-filter）+ 大圆角 + 页面网格渐变
 *
 * ⚠️ **默认是 native**，而且这个默认写在 CSS 里（`:root` 就是 native 的值）——
 *    就算 JS 完全没跑，看到的也是原生风格，不会是"半个玻璃"。
 *    `liquid` 才是那个覆盖层（`[data-style="liquid"]`）。
 */
export type UiStyle = "native" | "liquid";

const KEY = "nowen-lite.ui-style";

export const DEFAULT_UI_STYLE: UiStyle = "native";

export const UI_STYLE_OPTIONS: { id: UiStyle; labelKey: string; icon: string }[] = [
  { id: "native", labelKey: "settings.styleNative", icon: "▢" },
  { id: "liquid", labelKey: "settings.styleLiquid", icon: "◈" },
];

export function getUiStyle(): UiStyle {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "liquid" || raw === "native" ? raw : DEFAULT_UI_STYLE;
  } catch {
    return DEFAULT_UI_STYLE;
  }
}

export function setUiStyle(style: UiStyle): void {
  try {
    localStorage.setItem(KEY, style);
  } catch {
    /* 隐私模式：不记住，但本次生效 */
  }
  applyUiStyle(style);
}

/** 写入 <html data-style="…">；顺带把浏览器地址栏色（theme-color）跟着换 */
export function applyUiStyle(style: UiStyle = getUiStyle()): UiStyle {
  try {
    document.documentElement.dataset.style = style;
    syncThemeColor();
  } catch {
    /* ignore */
  }
  return style;
}

/** 地址栏色要同时看「皮肤」和「深浅色」—— 两者是正交的 */
export function themeColorFor(style: UiStyle, theme: "light" | "dark"): string {
  if (style === "liquid") return theme === "dark" ? "#0f1116" : "#eef1f7";
  return theme === "dark" ? "#0d1117" : "#f9fafb";
}

/** 供 theme.ts 在切换深浅色时复用 */
export function syncThemeColor(): void {
  try {
    const style = (document.documentElement.dataset.style as UiStyle) || DEFAULT_UI_STYLE;
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", themeColorFor(style, theme));
  } catch {
    /* ignore */
  }
}
