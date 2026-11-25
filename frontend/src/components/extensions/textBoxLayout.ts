/**
 * 文本框（带 float / width 的 callout，Issue #915）的布局规则。
 * 不依赖 ProseMirror，编辑器扩展和只读的分享页渲染共用。
 */

export type TextBoxFloat = "left" | "right";

export const TEXT_BOX_DEFAULT_WIDTH = 40;
export const TEXT_BOX_MIN_WIDTH = 20;
export const TEXT_BOX_MAX_WIDTH = 80;

export function normalizeTextBoxFloat(value: unknown): TextBoxFloat | null {
  return value === "left" || value === "right" ? value : null;
}

export function normalizeTextBoxWidth(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return TEXT_BOX_DEFAULT_WIDTH;
  return Math.min(TEXT_BOX_MAX_WIDTH, Math.max(TEXT_BOX_MIN_WIDTH, Math.round(parsed)));
}

/** 靠右的文本框在左侧留出与正文的间距，靠左的反之。 */
export function textBoxMargin(float: TextBoxFloat): string {
  return float === "right" ? "4px 0 12px 20px" : "4px 20px 12px 0";
}
