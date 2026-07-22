export const DEFAULT_WORKSPACE_ICON = "🏢";
export const MAX_WORKSPACE_ICON_LENGTH = 32;

export interface WorkspaceIconValidationResult {
  ok: boolean;
  icon: string;
  error?: string;
}

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const EMOJI_GRAPHEME_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u;

function splitGraphemes(value: string): string[] {
  const Segmenter = (Intl as any).Segmenter;
  if (typeof Segmenter === "function") {
    const segmenter = new Segmenter("en", { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (entry: any) => String(entry.segment));
  }
  return Array.from(value);
}

/**
 * Normalize and validate the workspace icon boundary.
 *
 * Product semantics:
 * - missing / blank values reset to the stable default icon;
 * - exactly one user-perceived grapheme is accepted;
 * - that grapheme must contain an Emoji code point (including flags/keycaps/ZWJ sequences);
 * - HTML, URLs, control characters and arbitrary text are rejected.
 */
export function normalizeWorkspaceIcon(value: unknown): WorkspaceIconValidationResult {
  if (value === undefined || value === null) {
    return { ok: true, icon: DEFAULT_WORKSPACE_ICON };
  }
  if (typeof value !== "string") {
    return { ok: false, icon: DEFAULT_WORKSPACE_ICON, error: "团队空间图标必须是 Emoji 字符串" };
  }

  const icon = value.normalize("NFC").trim();
  if (!icon) return { ok: true, icon: DEFAULT_WORKSPACE_ICON };
  if (icon.length > MAX_WORKSPACE_ICON_LENGTH) {
    return { ok: false, icon: DEFAULT_WORKSPACE_ICON, error: "团队空间图标长度超出限制" };
  }
  if (CONTROL_CHAR_RE.test(icon)) {
    return { ok: false, icon: DEFAULT_WORKSPACE_ICON, error: "团队空间图标包含非法控制字符" };
  }

  const graphemes = splitGraphemes(icon);
  if (graphemes.length !== 1 || graphemes[0] !== icon || !EMOJI_GRAPHEME_RE.test(icon)) {
    return { ok: false, icon: DEFAULT_WORKSPACE_ICON, error: "请选择单个有效的 Emoji 图标" };
  }

  return { ok: true, icon };
}

/** Read-side compatibility for historical rows with blank or invalid icon values. */
export function workspaceIconForRead(value: unknown): string {
  const result = normalizeWorkspaceIcon(value);
  return result.ok ? result.icon : DEFAULT_WORKSPACE_ICON;
}
