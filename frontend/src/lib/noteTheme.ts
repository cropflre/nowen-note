export const NOTE_THEME_IDS = ["default", "paper", "minimal", "eye-care", "developer", "magazine"] as const;

export type NoteThemeId = typeof NOTE_THEME_IDS[number];
export type NoteThemeMode = "light" | "dark";
export type NoteThemePreviewKind = "document" | "code" | "magazine";

export interface NoteThemeTokens {
  surface: string;
  text: string;
  heading: string;
  muted: string;
  border: string;
  accent: string;
  accentHover: string;
  inlineCodeBackground: string;
  inlineCodeText: string;
  preBackground: string;
  preText: string;
  quoteBorder: string;
  quoteText: string;
  softBackground: string;
  tableStripe: string;
  markBackground: string;
  selection: string;
  contentMaxWidth: string;
  lineHeight: string;
  fontFamily: string;
  fontSize: string;
}

export interface NoteThemeDefinition {
  id: NoteThemeId;
  name: { zh: string; en: string };
  description: { zh: string; en: string };
  previewKind: NoteThemePreviewKind;
  modes: Record<NoteThemeMode, NoteThemeTokens>;
}

const sansFont = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const serifFont = "ui-serif, Georgia, Cambria, 'Times New Roman', 'Songti SC', 'SimSun', serif";

const defaultLight: NoteThemeTokens = {
  surface: "#ffffff", text: "#1f2328", heading: "#1f2328", muted: "#6b7280",
  border: "#d0d7de", accent: "#0969da", accentHover: "#0550ae",
  inlineCodeBackground: "#f3f4f6", inlineCodeText: "#dc2626",
  preBackground: "#0d1117", preText: "#e6edf3", quoteBorder: "#3b82f6",
  quoteText: "#6b7280", softBackground: "#f6f8fa", tableStripe: "#f9fafb",
  markBackground: "#fff3a3", selection: "rgba(59, 130, 246, 0.2)",
  contentMaxWidth: "860px", lineHeight: "1.75", fontFamily: sansFont, fontSize: "15px",
};

const defaultDark: NoteThemeTokens = {
  surface: "#0d1117", text: "#e7e9ee", heading: "#e7e9ee", muted: "#8b949e",
  border: "#343943", accent: "#79b8ff", accentHover: "#a5d6ff",
  inlineCodeBackground: "#1c2333", inlineCodeText: "#f0883e",
  preBackground: "#0b0e14", preText: "#e6edf3", quoteBorder: "#58a6ff",
  quoteText: "#8b949e", softBackground: "#1b1f27", tableStripe: "#161b22",
  markBackground: "#5c4b14", selection: "rgba(88, 166, 255, 0.25)",
  contentMaxWidth: "860px", lineHeight: "1.75", fontFamily: sansFont, fontSize: "15px",
};

export const NOTE_THEMES: readonly NoteThemeDefinition[] = [
  {
    id: "default",
    name: { zh: "Nowen 默认", en: "Nowen Default" },
    description: { zh: "均衡清爽，适合大多数日常笔记。", en: "A balanced, clean style for everyday notes." },
    previewKind: "document",
    modes: { light: defaultLight, dark: defaultDark },
  },
  {
    id: "paper",
    name: { zh: "纸张阅读", en: "Paper Reading" },
    description: { zh: "温暖纸色与衬线字体，适合日记和长文。", en: "Warm paper tones and serif typography for journals and long-form reading." },
    previewKind: "document",
    modes: {
      light: {
        surface: "#fbf6ea", text: "#514538", heading: "#2f281f", muted: "#857562",
        border: "#ded1bc", accent: "#9a5c2f", accentHover: "#74411e",
        inlineCodeBackground: "#eee3d0", inlineCodeText: "#8a3f2f",
        preBackground: "#2b2520", preText: "#f3eadc", quoteBorder: "#b7793f",
        quoteText: "#6d5d4b", softBackground: "#f3ead9", tableStripe: "#f6eedf",
        markBackground: "#efd992", selection: "rgba(154, 92, 47, 0.22)",
        contentMaxWidth: "760px", lineHeight: "1.86", fontFamily: serifFont, fontSize: "16px",
      },
      dark: {
        surface: "#211d18", text: "#ddd0bd", heading: "#f3e7d4", muted: "#aa9983",
        border: "#4a4034", accent: "#d7a06b", accentHover: "#efbd88",
        inlineCodeBackground: "#342c23", inlineCodeText: "#e7a77a",
        preBackground: "#171411", preText: "#eadfce", quoteBorder: "#b77a48",
        quoteText: "#baa993", softBackground: "#2c261f", tableStripe: "#28221c",
        markBackground: "#67501f", selection: "rgba(215, 160, 107, 0.24)",
        contentMaxWidth: "760px", lineHeight: "1.86", fontFamily: serifFont, fontSize: "16px",
      },
    },
  },
  {
    id: "minimal",
    name: { zh: "极简写作", en: "Minimal Writing" },
    description: { zh: "高留白、窄版心，让注意力回到文字。", en: "More whitespace and a narrow measure for focused writing." },
    previewKind: "document",
    modes: {
      light: {
        surface: "#ffffff", text: "#30343b", heading: "#111318", muted: "#7b818b",
        border: "#e8eaed", accent: "#3d5a80", accentHover: "#273f5d",
        inlineCodeBackground: "#f2f4f7", inlineCodeText: "#9b3b45",
        preBackground: "#17191d", preText: "#eef0f3", quoteBorder: "#9aa4b2",
        quoteText: "#646b75", softBackground: "#f6f7f9", tableStripe: "#fafbfc",
        markBackground: "#fff0a8", selection: "rgba(61, 90, 128, 0.18)",
        contentMaxWidth: "700px", lineHeight: "1.8", fontFamily: sansFont, fontSize: "15px",
      },
      dark: {
        surface: "#111214", text: "#d9dce1", heading: "#f4f5f7", muted: "#9197a1",
        border: "#2d3035", accent: "#91a9c6", accentHover: "#b4c5d9",
        inlineCodeBackground: "#22252a", inlineCodeText: "#e0a0a7",
        preBackground: "#090a0c", preText: "#e8eaed", quoteBorder: "#68717d",
        quoteText: "#a9afb8", softBackground: "#1b1d21", tableStripe: "#17191c",
        markBackground: "#5a4b1d", selection: "rgba(145, 169, 198, 0.22)",
        contentMaxWidth: "700px", lineHeight: "1.8", fontFamily: sansFont, fontSize: "15px",
      },
    },
  },
  {
    id: "eye-care",
    name: { zh: "夜间护眼", en: "Night Eye Care" },
    description: { zh: "低刺激深色正文，适合夜间阅读和长时间整理。", en: "A low-glare dark reading surface for night use and long sessions." },
    previewKind: "document",
    modes: {
      light: {
        surface: "#171c1a", text: "#d6ded2", heading: "#f0f4ec", muted: "#94a18f",
        border: "#344039", accent: "#8fb69a", accentHover: "#b3d3bb",
        inlineCodeBackground: "#252e29", inlineCodeText: "#d9a59a",
        preBackground: "#0d120f", preText: "#e5ece2", quoteBorder: "#66876b",
        quoteText: "#adb9a8", softBackground: "#202823", tableStripe: "#1c231f",
        markBackground: "#56511e", selection: "rgba(143, 182, 154, 0.22)",
        contentMaxWidth: "820px", lineHeight: "1.8", fontFamily: sansFont, fontSize: "15px",
      },
      dark: {
        surface: "#111613", text: "#cfd9cc", heading: "#edf3e9", muted: "#8e9b8a",
        border: "#2c3931", accent: "#8db394", accentHover: "#afd0b4",
        inlineCodeBackground: "#202923", inlineCodeText: "#d3a096",
        preBackground: "#090d0a", preText: "#e0e9dd", quoteBorder: "#5f8065",
        quoteText: "#a5b2a1", softBackground: "#1a211d", tableStripe: "#171e1a",
        markBackground: "#4d4b1b", selection: "rgba(141, 179, 148, 0.22)",
        contentMaxWidth: "820px", lineHeight: "1.8", fontFamily: sansFont, fontSize: "15px",
      },
    },
  },
  {
    id: "developer",
    name: { zh: "开发文档", en: "Developer Docs" },
    description: { zh: "强化代码、表格与信息层级，适合技术方案和 API 文档。", en: "Stronger code, tables, and hierarchy for technical notes and API docs." },
    previewKind: "code",
    modes: {
      light: {
        surface: "#f8fafc", text: "#1e293b", heading: "#0f172a", muted: "#64748b",
        border: "#cbd5e1", accent: "#2563eb", accentHover: "#1d4ed8",
        inlineCodeBackground: "#e2e8f0", inlineCodeText: "#be123c",
        preBackground: "#0f172a", preText: "#e2e8f0", quoteBorder: "#3b82f6",
        quoteText: "#475569", softBackground: "#eef2f7", tableStripe: "#f1f5f9",
        markBackground: "#fde68a", selection: "rgba(37, 99, 235, 0.18)",
        contentMaxWidth: "960px", lineHeight: "1.66", fontFamily: sansFont, fontSize: "14px",
      },
      dark: {
        surface: "#0b1220", text: "#dbe7f4", heading: "#f8fafc", muted: "#94a3b8",
        border: "#263449", accent: "#60a5fa", accentHover: "#93c5fd",
        inlineCodeBackground: "#162033", inlineCodeText: "#fda4af",
        preBackground: "#060b14", preText: "#dbeafe", quoteBorder: "#3b82f6",
        quoteText: "#a9b7c9", softBackground: "#111b2b", tableStripe: "#0e1726",
        markBackground: "#5b4812", selection: "rgba(96, 165, 250, 0.2)",
        contentMaxWidth: "960px", lineHeight: "1.66", fontFamily: sansFont, fontSize: "14px",
      },
    },
  },
  {
    id: "magazine",
    name: { zh: "杂志排版", en: "Magazine" },
    description: { zh: "更强标题层级与阅读节奏，适合文章、方案和展示型内容。", en: "Editorial hierarchy and rhythm for articles, proposals, and presentation-ready notes." },
    previewKind: "magazine",
    modes: {
      light: {
        surface: "#fffdf9", text: "#312a26", heading: "#12100f", muted: "#786d66",
        border: "#d9d0c8", accent: "#b42318", accentHover: "#8f1d14",
        inlineCodeBackground: "#f2ece6", inlineCodeText: "#8f2d2d",
        preBackground: "#211d1b", preText: "#f7f1ec", quoteBorder: "#111111",
        quoteText: "#625852", softBackground: "#f6f0e9", tableStripe: "#faf6f1",
        markBackground: "#f6df8f", selection: "rgba(180, 35, 24, 0.17)",
        contentMaxWidth: "800px", lineHeight: "1.88", fontFamily: serifFont, fontSize: "16px",
      },
      dark: {
        surface: "#191614", text: "#e6ddd5", heading: "#fffaf5", muted: "#a99c92",
        border: "#443a35", accent: "#f08072", accentHover: "#f6a096",
        inlineCodeBackground: "#2b2522", inlineCodeText: "#f2aaa2",
        preBackground: "#0f0d0c", preText: "#f4ece5", quoteBorder: "#d9cdc4",
        quoteText: "#c1b4aa", softBackground: "#241f1c", tableStripe: "#201b18",
        markBackground: "#64501a", selection: "rgba(240, 128, 114, 0.2)",
        contentMaxWidth: "800px", lineHeight: "1.88", fontFamily: serifFont, fontSize: "16px",
      },
    },
  },
] as const;

const NOTE_THEME_ID_SET = new Set<string>(NOTE_THEME_IDS);
const THEME_BY_ID = new Map(NOTE_THEMES.map((theme) => [theme.id, theme]));

export function isNoteThemeId(value: unknown): value is NoteThemeId {
  return typeof value === "string" && NOTE_THEME_ID_SET.has(value);
}

export function normalizeNoteThemeId(value: unknown): NoteThemeId {
  return isNoteThemeId(value) ? value : "default";
}

export function getNoteTheme(id: unknown): NoteThemeDefinition {
  return THEME_BY_ID.get(normalizeNoteThemeId(id)) || NOTE_THEMES[0];
}

export function resolveNoteThemeTokens(id: unknown, mode: NoteThemeMode): NoteThemeTokens {
  return getNoteTheme(id).modes[mode];
}

export function resolveDocumentThemeMode(root?: HTMLElement | null): NoteThemeMode {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  return target?.classList.contains("dark") || target?.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

const ROOT_TOKEN_PROPERTIES: Array<[keyof NoteThemeTokens, string]> = [
  ["surface", "--note-theme-surface"], ["text", "--pm-text"], ["heading", "--pm-heading"],
  ["muted", "--note-theme-muted"], ["border", "--note-theme-border"],
  ["accent", "--note-theme-accent"], ["accentHover", "--note-theme-accent-hover"],
  ["inlineCodeBackground", "--pm-code-bg"], ["inlineCodeText", "--pm-code-text"],
  ["preBackground", "--pm-pre-bg"], ["preText", "--pm-pre-text"],
  ["quoteBorder", "--pm-blockquote-border"], ["quoteText", "--pm-blockquote-text"],
  ["softBackground", "--note-theme-soft"], ["tableStripe", "--note-theme-table-stripe"],
  ["markBackground", "--note-theme-mark"], ["selection", "--pm-selection"],
  ["contentMaxWidth", "--note-theme-content-width"], ["lineHeight", "--pm-p-line-height"],
  ["fontFamily", "--note-theme-font-family"], ["fontSize", "--note-theme-font-size"],
];

export function noteThemeTokenProperties(): readonly string[] {
  return ROOT_TOKEN_PROPERTIES.map(([, property]) => property);
}

export function applyNoteTheme(id: unknown, root?: HTMLElement | null): NoteThemeId {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  const normalized = normalizeNoteThemeId(id);
  if (!target) return normalized;
  target.setAttribute("data-note-theme", normalized);
  if (normalized === "default") {
    for (const [, property] of ROOT_TOKEN_PROPERTIES) target.style.removeProperty(property);
    return normalized;
  }
  const tokens = resolveNoteThemeTokens(normalized, resolveDocumentThemeMode(target));
  for (const [key, property] of ROOT_TOKEN_PROPERTIES) target.style.setProperty(property, tokens[key]);
  return normalized;
}

export function currentNoteThemeId(root?: HTMLElement | null): NoteThemeId {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  return normalizeNoteThemeId(target?.getAttribute("data-note-theme"));
}
