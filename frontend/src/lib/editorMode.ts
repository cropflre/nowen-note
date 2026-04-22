/**
 * 编辑器模式（MD / Tiptap）的读写工具 —— 从 EditorPane 抽出来的独立模块。
 *
 * 抽离的价值：
 *   1. EditorPane.tsx 已经超过 1800 行，`resolveEditorMode` 这类纯逻辑工具放
 *      在里面只是徒增阅读成本，拆出来后该组件视角更聚焦在"编辑器装配 +
 *      切换协调"上。
 *   2. 这些函数没有 React 依赖，单元测试可以直接调用，不需要 renderHook。
 *   3. 将来若要加"CLI 参数 / 新 URL 查询参数覆盖"等 storage 层策略，统一在
 *      这里扩展，而不是散落在组件里。
 *
 * 兼容约定：
 *   - 读取优先级：URL `?md=1|0` → localStorage → 默认 `"tiptap"`
 *   - 写入只写 localStorage；URL 上的强制标记由 clearForcedModeFromUrl 显式清除
 *   - 所有方法对 SSR / 无 window 环境安全，读取失败时返回默认值
 */

export type EditorMode = "md" | "tiptap";

export const EDITOR_MODE_KEY = "nowen.editor_mode";

/** URL 查询参数 key；`?md=1` 强制启用 MD，`?md=0` 强制启用 Tiptap */
const URL_FORCE_KEY = "md";

/**
 * 根据 URL / localStorage 解析当前编辑器模式。
 *
 * - `?md=1` → "md"
 * - `?md=0` → "tiptap"
 * - 否则取 localStorage，非法值回落到 "tiptap"
 *
 * 所有异常（SSR、localStorage 禁用）都吞掉并返回默认值。
 */
export function resolveEditorMode(defaultMode: EditorMode = "tiptap"): EditorMode {
  try {
    if (typeof window === "undefined") return defaultMode;

    const sp = new URLSearchParams(window.location.search);
    const forced = sp.get(URL_FORCE_KEY);
    if (forced === "1") return "md";
    if (forced === "0") return "tiptap";

    const stored = localStorage.getItem(EDITOR_MODE_KEY);
    if (stored === "md" || stored === "tiptap") return stored;
  } catch {
    /* SSR / 无 localStorage / 权限异常 */
  }
  return defaultMode;
}

/**
 * 把当前选择持久化到 localStorage。失败时静默（隐私模式 / quota）。
 * 调用方应在成功切换后调用。
 */
export function persistEditorMode(mode: EditorMode): void {
  try {
    localStorage.setItem(EDITOR_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/**
 * 清除 URL 上的 `?md=` 强制标记。切换后必须调一次，否则刷新页面会
 * 回到"URL 强制模式"，localStorage 里的用户选择被永久忽略。
 *
 * 用 history.replaceState 不触发 React Router / 浏览器跳转。
 */
export function clearForcedModeFromUrl(): void {
  try {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(URL_FORCE_KEY)) return;
    url.searchParams.delete(URL_FORCE_KEY);
    window.history.replaceState(
      null,
      "",
      url.pathname + (url.search || "") + url.hash,
    );
  } catch {
    /* ignore */
  }
}

/** 取另一个模式的便捷函数，避免调用方写 ternary */
export function nextEditorMode(current: EditorMode): EditorMode {
  return current === "md" ? "tiptap" : "md";
}
