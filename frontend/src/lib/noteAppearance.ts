import { fetchWithAuthRefresh, getAccessToken } from "@/lib/authSession";
import { getBaseUrl } from "@/lib/api.impl";

export const DEFAULT_NOTE_THEME_ID = "nowen.default";

export interface NoteThemeTokens {
  canvas: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  quoteBackground: string;
  codeBackground: string;
  inlineCodeBackground: string;
  maxWidth: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
}

export interface NoteThemeDefinition {
  id: string;
  name: string;
  description: string;
  preview: { background: string; surface: string; text: string; accent: string };
  tokens: NoteThemeTokens;
}

export const NOTE_THEMES: readonly NoteThemeDefinition[] = [
  {
    id: DEFAULT_NOTE_THEME_ID,
    name: "Nowen 默认",
    description: "跟随 Nowen 当前界面与编辑器样式",
    preview: { background: "#f8fafc", surface: "#ffffff", text: "#0f172a", accent: "#6366f1" },
    tokens: {
      canvas: "var(--color-app-bg, #f8fafc)",
      surface: "var(--color-app-surface, #ffffff)",
      text: "var(--color-text-primary, #0f172a)",
      muted: "var(--color-text-secondary, #64748b)",
      accent: "var(--color-accent-primary, #6366f1)",
      border: "var(--color-border, #e2e8f0)",
      quoteBackground: "var(--color-app-hover, #f1f5f9)",
      codeBackground: "var(--color-app-hover, #f1f5f9)",
      inlineCodeBackground: "var(--color-app-hover, #f1f5f9)",
      maxWidth: "none",
      fontFamily: "inherit",
      fontSize: "inherit",
      lineHeight: "inherit",
    },
  },
  {
    id: "nowen.paper",
    name: "纸张阅读",
    description: "温暖纸张底色，适合日记、长文和沉浸阅读",
    preview: { background: "#eee9df", surface: "#fffaf0", text: "#3f372d", accent: "#9a6034" },
    tokens: {
      canvas: "#eee9df",
      surface: "#fffaf0",
      text: "#3f372d",
      muted: "#7c7062",
      accent: "#9a6034",
      border: "#ded3c2",
      quoteBackground: "#f5ecdc",
      codeBackground: "#292623",
      inlineCodeBackground: "#eee4d3",
      maxWidth: "780px",
      fontFamily: "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
      fontSize: "16px",
      lineHeight: "1.82",
    },
  },
  {
    id: "nowen.minimal",
    name: "极简写作",
    description: "低干扰、高留白，适合方案、写作与知识整理",
    preview: { background: "#f5f5f4", surface: "#ffffff", text: "#171717", accent: "#525252" },
    tokens: {
      canvas: "#f5f5f4",
      surface: "#ffffff",
      text: "#171717",
      muted: "#737373",
      accent: "#525252",
      border: "#e7e5e4",
      quoteBackground: "#fafaf9",
      codeBackground: "#18181b",
      inlineCodeBackground: "#f1f1f0",
      maxWidth: "860px",
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: "15px",
      lineHeight: "1.72",
    },
  },
  {
    id: "nowen.night",
    name: "夜间护眼",
    description: "独立于 App Skin 的深色正文主题，适合夜间阅读与技术笔记",
    preview: { background: "#111315", surface: "#171a1d", text: "#e7e5e4", accent: "#7dd3fc" },
    tokens: {
      canvas: "#111315",
      surface: "#171a1d",
      text: "#e7e5e4",
      muted: "#a8a29e",
      accent: "#7dd3fc",
      border: "#2c3035",
      quoteBackground: "#1e2227",
      codeBackground: "#0b0d0f",
      inlineCodeBackground: "#252a30",
      maxWidth: "900px",
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: "15px",
      lineHeight: "1.75",
    },
  },
] as const;

const THEME_BY_ID = new Map(NOTE_THEMES.map((theme) => [theme.id, theme]));

export function resolveNoteTheme(themeId: string | null | undefined): NoteThemeDefinition {
  return THEME_BY_ID.get(String(themeId || "").trim().toLowerCase())
    || THEME_BY_ID.get(DEFAULT_NOTE_THEME_ID)!;
}

export function isKnownNoteTheme(themeId: string): boolean {
  return THEME_BY_ID.has(themeId.trim().toLowerCase());
}

export function noteThemeCssVariables(theme: NoteThemeDefinition): Record<string, string> {
  const t = theme.tokens;
  return {
    "--note-theme-canvas": t.canvas,
    "--note-theme-surface": t.surface,
    "--note-theme-text": t.text,
    "--note-theme-muted": t.muted,
    "--note-theme-accent": t.accent,
    "--note-theme-border": t.border,
    "--note-theme-quote-bg": t.quoteBackground,
    "--note-theme-code-bg": t.codeBackground,
    "--note-theme-inline-code-bg": t.inlineCodeBackground,
    "--note-theme-max-width": t.maxWidth,
    "--note-theme-font-family": t.fontFamily,
    "--note-theme-font-size": t.fontSize,
    "--note-theme-line-height": t.lineHeight,
  };
}

async function appearanceRequest<T>(noteId: string, init: RequestInit): Promise<T> {
  const baseUrl = getBaseUrl().replace(/\/+$/, "");
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${baseUrl}/note-appearance/${encodeURIComponent(noteId)}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  }, baseUrl);
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || `HTTP ${response.status}`);
  }
  return payload;
}

export async function getNoteAppearance(noteId: string): Promise<{ noteId: string; themeId: string }> {
  return appearanceRequest(noteId, { method: "GET" });
}

export async function setNoteAppearance(
  noteId: string,
  themeId: string,
): Promise<{ noteId: string; themeId: string; updated: boolean }> {
  if (!isKnownNoteTheme(themeId)) throw new Error("未知笔记主题");
  return appearanceRequest(noteId, {
    method: "PUT",
    body: JSON.stringify({ themeId }),
  });
}
