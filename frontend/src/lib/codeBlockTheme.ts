/**
 * 代码块主题（全局偏好，非笔记数据）
 *
 * 设计：
 *  - 每套主题就是一组 CSS 变量值，通过根 `<html>` 上的 data-code-theme 属性驱动。
 *  - 用户选择保存在 localStorage，刷新保持。
 *  - 编辑器（CodeBlockView）与分享页（SharedNoteView）都读取同一配置。
 */

export type CodeBlockThemeId =
  | "github-dark"
  | "github-light"
  | "dracula"
  | "monokai"
  | "solarized-light"
  | "one-dark"
  | "nord";

export interface CodeBlockThemeMeta {
  id: CodeBlockThemeId;
  label: string;
  /** 预览小圆点颜色，用于在选择器中可视化 */
  preview: { bg: string; fg: string; accent: string };
}

export const CODE_BLOCK_THEMES: CodeBlockThemeMeta[] = [
  { id: "github-dark", label: "GitHub Dark", preview: { bg: "#0d1117", fg: "#c9d1d9", accent: "#ff7b72" } },
  { id: "github-light", label: "GitHub Light", preview: { bg: "#f6f8fa", fg: "#24292f", accent: "#cf222e" } },
  { id: "one-dark", label: "One Dark", preview: { bg: "#282c34", fg: "#abb2bf", accent: "#c678dd" } },
  { id: "dracula", label: "Dracula", preview: { bg: "#282a36", fg: "#f8f8f2", accent: "#ff79c6" } },
  { id: "monokai", label: "Monokai", preview: { bg: "#272822", fg: "#f8f8f2", accent: "#a6e22e" } },
  { id: "nord", label: "Nord", preview: { bg: "#2e3440", fg: "#d8dee9", accent: "#88c0d0" } },
  { id: "solarized-light", label: "Solarized Light", preview: { bg: "#fdf6e3", fg: "#586e75", accent: "#b58900" } },
];

export const DEFAULT_CODE_BLOCK_THEME: CodeBlockThemeId = "github-light";

const STORAGE_KEY = "nowen.codeBlockTheme";

export function getSavedCodeBlockTheme(): CodeBlockThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as CodeBlockThemeId | null;
    if (v && CODE_BLOCK_THEMES.some((t) => t.id === v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_CODE_BLOCK_THEME;
}

export function applyCodeBlockTheme(theme: CodeBlockThemeId) {
  try {
    document.documentElement.setAttribute("data-code-theme", theme);
  } catch {
    /* ignore */
  }
}

export function setCodeBlockTheme(theme: CodeBlockThemeId) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  applyCodeBlockTheme(theme);
  // 广播，其它组件可订阅同步
  try {
    window.dispatchEvent(new CustomEvent("nowen:codeblock-theme-change", { detail: theme }));
  } catch {
    /* ignore */
  }
}

/** 在应用启动时调用一次，确保 data-code-theme 被设置 */
export function initCodeBlockTheme() {
  applyCodeBlockTheme(getSavedCodeBlockTheme());
}
