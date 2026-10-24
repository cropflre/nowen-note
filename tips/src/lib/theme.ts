/**
 * 浅色 / 深色 / 跟随系统。
 *
 * 三个刻意的设计决定：
 *
 * 1. **「跟随系统」在 JS 里 resolve，不用 CSS 媒体查询。**
 *    用媒体查询的话，深色 token 得写两遍（`[data-theme=dark]` 和
 *    `@media (prefers-color-scheme: dark) [data-theme=auto]`）—— 两份迟早漂移。
 *    这里统一解析成 `data-theme="light" | "dark"` 再写到 <html> 上，
 *    深色 token 只写一份，而且系统切换时能立刻响应（matchMedia 监听）。
 *
 * 2. **首帧不能闪白。** 主题要在 CSS 生效前就定下来，所以 index.html 里有一小段
 *    内联脚本做同样的事（读 localStorage + matchMedia）。那段是**唯一**的重复实现，
 *    故意保留 —— 走 JS bundle 就一定会先渲染一帧浅色。
 *    ⚠️ 改这里的键名/取值时，**必须同步改 index.html 里那段**。
 *
 * 3. **顺手更新 <meta name="theme-color">** —— 手机上浏览器地址栏/状态栏会跟着变，
 *    否则深色页面顶一条白边。
 */
import { DEFAULT_UI_STYLE, themeColorFor, type UiStyle } from "./uiStyle";

const THEME_KEY = "nowen-lite.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export type ThemePreference = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_THEME: ThemePreference = "auto";

export const THEME_OPTIONS: { id: ThemePreference; label: string; icon: string }[] = [
  { id: "light", label: "浅色", icon: "☀️" },
  { id: "dark", label: "深色", icon: "🌙" },
  { id: "auto", label: "跟随系统", icon: "⚙️" },
];

export function getThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === "light" || raw === "dark" || raw === "auto" ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* 隐私模式下忽略：不记住，但本次仍然生效 */
  }
  applyTheme(pref);
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "auto") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

/** 把解析后的主题写到 <html data-theme>，并同步 theme-color */
export function applyTheme(pref: ThemePreference = getThemePreference()): ResolvedTheme {
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  // 让原生控件与滚动条也跟着走
  root.style.colorScheme = resolved;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    // 地址栏色同时取决于「皮肤」和「深浅色」—— 两者正交
    const style = (document.documentElement.dataset.style as UiStyle) || DEFAULT_UI_STYLE;
    meta.setAttribute("content", themeColorFor(style, resolved));
  }

  return resolved;
}

/**
 * 系统主题变化时重新应用（只在「跟随系统」时才有意义）。
 * 返回取消订阅函数。
 */
export function watchSystemTheme(): () => void {
  let mq: MediaQueryList;
  try {
    mq = window.matchMedia(DARK_QUERY);
  } catch {
    return () => undefined;
  }
  const onChange = () => {
    if (getThemePreference() === "auto") applyTheme("auto");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
