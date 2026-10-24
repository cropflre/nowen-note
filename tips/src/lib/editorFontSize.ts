/**
 * 编辑器默认字号 —— 与 Nowen Note 1.5.0 标准版同一套档位。
 *
 * 实现方式照搬标准版：**写一个 CSS 变量**（`--editor-font-size`），
 * 由样式表决定它作用在哪些元素上（正文 / Markdown 源码 / 预览）。
 * 好处是切换字号不触发 React 重渲染，也不会把字号硬编码到各个组件里。
 *
 * 0 = 「默认」：此时把变量**移除**，让样式表回落到自己的默认值
 * （标准版的默认是 15px），而不是把 15 写死在这里 —— 免得两边各写一份、迟早不一致。
 */
export const FONT_SIZES = [0, 14, 16, 18, 20, 22, 24] as const;
export type FontSize = (typeof FONT_SIZES)[number];

const KEY = "nowen-lite.editor-font-size";

/** 0 表示「跟样式表的默认值走」 */
export const DEFAULT_FONT_SIZE: FontSize = 0;

export function getEditorFontSize(): FontSize {
  try {
    const raw = Number(localStorage.getItem(KEY));
    return FONT_SIZES.includes(raw as FontSize) ? (raw as FontSize) : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

export function setEditorFontSize(size: FontSize): void {
  try {
    localStorage.setItem(KEY, String(size));
  } catch {
    /* 隐私模式：不记住，但本次生效 */
  }
  applyEditorFontSize(size);
}

/** 把字号写到 :root 的 CSS 变量上；0 就移除，交给样式表默认值 */
export function applyEditorFontSize(size: FontSize = getEditorFontSize()): void {
  try {
    const root = document.documentElement;
    if (size > 0) root.style.setProperty("--editor-font-size", `${size}px`);
    else root.style.removeProperty("--editor-font-size");
  } catch {
    /* ignore */
  }
}
