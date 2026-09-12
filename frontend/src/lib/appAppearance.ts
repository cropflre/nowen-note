export const APP_APPEARANCE_IDS = [
  "default",
  "macos",
  "paper",
  "minimal",
  "eye-care",
  "developer",
  "magazine",
] as const;

export type AppAppearanceId = typeof APP_APPEARANCE_IDS[number];
export type AppAppearanceMode = "light" | "dark";

export interface AppAppearanceTokens {
  bg: string;
  surface: string;
  sidebar: string;
  sidebarSolid: string;
  elevated: string;
  elevatedSolid: string;
  border: string;
  hover: string;
  active: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textQuaternary: string;
  textInverse: string;
  accentPrimary: string;
  accentSecondary: string;
  accentWarning: string;
  accentDanger: string;
  accentMuted: string;
  pmText: string;
  pmHeading: string;
  pmCodeBg: string;
  pmCodeText: string;
  pmPreBg: string;
  pmPreBorder: string;
  pmPreText: string;
  pmBlockquoteBorder: string;
  pmBlockquoteText: string;
  pmHr: string;
  pmPlaceholder: string;
  pmTaskDone: string;
  pmScrollbar: string;
  pmScrollbarHover: string;
  pmSelection: string;
  radiusWindow: string;
  radiusCard: string;
  radiusButton: string;
  radiusInput: string;
  fontFamily: string;
  editorFontFamily: string;
}

export interface AppAppearanceDefinition {
  id: AppAppearanceId;
  name: { zh: string; en: string };
  description: { zh: string; en: string };
  modes: Record<AppAppearanceMode, AppAppearanceTokens>;
}

const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif";
const serif = "ui-serif, Georgia, Cambria, 'Times New Roman', 'Songti SC', 'SimSun', serif";
const mono = "ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

const defaultLight: AppAppearanceTokens = {
  bg: "#ffffff", surface: "#f9fafb", sidebar: "#f3f4f6", sidebarSolid: "#f3f4f6",
  elevated: "#ffffff", elevatedSolid: "#ffffff", border: "#e5e7eb", hover: "#f3f4f6", active: "#e0e7ff",
  textPrimary: "#111827", textSecondary: "#6b7280", textTertiary: "#9ca3af", textQuaternary: "#d1d5db", textInverse: "#ffffff",
  accentPrimary: "#3b82f6", accentSecondary: "#22c55e", accentWarning: "#f59e0b", accentDanger: "#ef4444", accentMuted: "#9ca3af",
  pmText: "#374151", pmHeading: "#111827", pmCodeBg: "#f3f4f6", pmCodeText: "#dc2626", pmPreBg: "#f9fafb", pmPreBorder: "#e5e7eb", pmPreText: "#374151",
  pmBlockquoteBorder: "#3b82f6", pmBlockquoteText: "#6b7280", pmHr: "#e5e7eb", pmPlaceholder: "#9ca3af", pmTaskDone: "#9ca3af",
  pmScrollbar: "#d1d5db", pmScrollbarHover: "#9ca3af", pmSelection: "rgba(59, 130, 246, 0.20)",
  radiusWindow: "10px", radiusCard: "8px", radiusButton: "6px", radiusInput: "6px", fontFamily: sans, editorFontFamily: sans,
};

const defaultDark: AppAppearanceTokens = {
  bg: "#0d1117", surface: "#161b22", sidebar: "#1c2128", sidebarSolid: "#1c2128",
  elevated: "#1c2333", elevatedSolid: "#1c2333", border: "#30363d", hover: "#1f2937", active: "#253040",
  textPrimary: "#e6edf3", textSecondary: "#8b949e", textTertiary: "#6e7681", textQuaternary: "#4b5563", textInverse: "#0d1117",
  accentPrimary: "#58a6ff", accentSecondary: "#7ee787", accentWarning: "#f0883e", accentDanger: "#f85149", accentMuted: "#8b949e",
  pmText: "#c9d1d9", pmHeading: "#e6edf3", pmCodeBg: "#1c2333", pmCodeText: "#f0883e", pmPreBg: "#161b22", pmPreBorder: "#30363d", pmPreText: "#c9d1d9",
  pmBlockquoteBorder: "#58a6ff", pmBlockquoteText: "#8b949e", pmHr: "#30363d", pmPlaceholder: "#6e7681", pmTaskDone: "#6e7681",
  pmScrollbar: "#30363d", pmScrollbarHover: "#484f58", pmSelection: "rgba(88, 166, 255, 0.25)",
  radiusWindow: "10px", radiusCard: "8px", radiusButton: "6px", radiusInput: "6px", fontFamily: sans, editorFontFamily: sans,
};

function variant(base: AppAppearanceTokens, patch: Partial<AppAppearanceTokens>): AppAppearanceTokens {
  return { ...base, ...patch };
}

export const APP_APPEARANCES: readonly AppAppearanceDefinition[] = [
  {
    id: "default",
    name: { zh: "Nowen 默认", en: "Nowen Default" },
    description: { zh: "现代清爽，保持 Nowen 当前跨平台视觉。", en: "Clean, modern and consistent across platforms." },
    modes: { light: defaultLight, dark: defaultDark },
  },
  {
    id: "macos",
    name: { zh: "macOS", en: "macOS" },
    description: { zh: "Apple 设计语言，系统蓝、圆角与毛玻璃层次。", en: "Apple-inspired system blue, rounded geometry and vibrancy." },
    modes: {
      light: variant(defaultLight, {
        bg: "#ececec", surface: "#ffffff", sidebar: "rgba(246, 246, 246, 0.72)", sidebarSolid: "#f6f6f6",
        elevated: "rgba(255, 255, 255, 0.85)", elevatedSolid: "#ffffff", border: "rgba(0, 0, 0, 0.10)", hover: "rgba(0, 0, 0, 0.04)", active: "#b4d8ff",
        textPrimary: "#000000", textSecondary: "rgba(0, 0, 0, 0.60)", textTertiary: "rgba(0, 0, 0, 0.40)", textQuaternary: "rgba(0, 0, 0, 0.20)",
        accentPrimary: "#007aff", accentSecondary: "#34c759", accentWarning: "#ff9500", accentDanger: "#ff3b30", accentMuted: "rgba(0, 0, 0, 0.40)",
        pmText: "#1d1d1f", pmHeading: "#000000", pmCodeBg: "rgba(0, 0, 0, 0.05)", pmCodeText: "#d70015", pmPreBg: "#f6f6f6", pmPreBorder: "rgba(0, 0, 0, 0.10)", pmPreText: "#1d1d1f",
        pmBlockquoteBorder: "#007aff", pmBlockquoteText: "rgba(0, 0, 0, 0.55)", pmHr: "rgba(0, 0, 0, 0.10)", pmPlaceholder: "rgba(0, 0, 0, 0.30)", pmTaskDone: "rgba(0, 0, 0, 0.30)",
        pmScrollbar: "rgba(0, 0, 0, 0.20)", pmScrollbarHover: "rgba(0, 0, 0, 0.35)", pmSelection: "rgba(0, 122, 255, 0.20)",
        radiusInput: "5px", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', 'PingFang SC', sans-serif",
        editorFontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', 'PingFang SC', sans-serif",
      }),
      dark: variant(defaultDark, {
        bg: "#1e1e1e", surface: "#2e2e2e", sidebar: "rgba(30, 30, 30, 0.72)", sidebarSolid: "#252525",
        elevated: "rgba(58, 58, 58, 0.85)", elevatedSolid: "#3a3a3a", border: "rgba(255, 255, 255, 0.12)", hover: "rgba(255, 255, 255, 0.06)", active: "rgba(10, 132, 255, 0.30)",
        textPrimary: "#ffffff", textSecondary: "rgba(255, 255, 255, 0.60)", textTertiary: "rgba(255, 255, 255, 0.40)", textQuaternary: "rgba(255, 255, 255, 0.20)", textInverse: "#1e1e1e",
        accentPrimary: "#0a84ff", accentSecondary: "#30d158", accentWarning: "#ff9f0a", accentDanger: "#ff453a", accentMuted: "rgba(255, 255, 255, 0.40)",
        pmText: "#e8e8e8", pmHeading: "#ffffff", pmCodeBg: "rgba(255, 255, 255, 0.08)", pmCodeText: "#ff6b6b", pmPreBg: "#252525", pmPreBorder: "rgba(255, 255, 255, 0.10)", pmPreText: "#e8e8e8",
        pmBlockquoteBorder: "#0a84ff", pmBlockquoteText: "rgba(255, 255, 255, 0.55)", pmHr: "rgba(255, 255, 255, 0.10)", pmPlaceholder: "rgba(255, 255, 255, 0.30)", pmTaskDone: "rgba(255, 255, 255, 0.30)",
        pmScrollbar: "rgba(255, 255, 255, 0.20)", pmScrollbarHover: "rgba(255, 255, 255, 0.35)", pmSelection: "rgba(10, 132, 255, 0.30)",
        radiusInput: "5px", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', 'PingFang SC', sans-serif",
        editorFontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', 'PingFang SC', sans-serif",
      }),
    },
  },
  {
    id: "paper",
    name: { zh: "纸张阅读", en: "Paper Reading" },
    description: { zh: "暖纸色覆盖整个工作台，适合长时间阅读与整理。", en: "Warm paper tones across the whole workspace for long reading sessions." },
    modes: {
      light: variant(defaultLight, {
        bg: "#f4efe4", surface: "#faf6ed", sidebar: "#eee6d8", sidebarSolid: "#eee6d8", elevated: "#fffaf1", elevatedSolid: "#fffaf1",
        border: "#d9cfbd", hover: "#eee5d6", active: "#e7d5bc", textPrimary: "#342c24", textSecondary: "#6f6253", textTertiary: "#968674", textQuaternary: "#c7baa8", textInverse: "#fffaf1",
        accentPrimary: "#9a5c2f", accentSecondary: "#6f7f55", accentMuted: "#968674",
        pmText: "#514538", pmHeading: "#2f281f", pmCodeBg: "#eee3d0", pmCodeText: "#8a3f2f", pmPreBg: "#2b2520", pmPreBorder: "#4a4034", pmPreText: "#f3eadc",
        pmBlockquoteBorder: "#b7793f", pmBlockquoteText: "#6d5d4b", pmHr: "#d9cfbd", pmPlaceholder: "#a79682", pmTaskDone: "#a79682", pmScrollbar: "#c9bda9", pmScrollbarHover: "#ad9c84", pmSelection: "rgba(154, 92, 47, 0.20)",
        radiusWindow: "12px", radiusCard: "10px", radiusButton: "8px", radiusInput: "8px", editorFontFamily: serif,
      }),
      dark: variant(defaultDark, {
        bg: "#181511", surface: "#211d18", sidebar: "#1d1915", sidebarSolid: "#1d1915", elevated: "#2a241e", elevatedSolid: "#2a241e",
        border: "#463c31", hover: "#2d271f", active: "#493a2a", textPrimary: "#eadfce", textSecondary: "#b7a690", textTertiary: "#8d7d69", textQuaternary: "#5f5447", textInverse: "#181511",
        accentPrimary: "#d7a06b", accentSecondary: "#9ab07f", accentMuted: "#8d7d69",
        pmText: "#ddd0bd", pmHeading: "#f3e7d4", pmCodeBg: "#342c23", pmCodeText: "#e7a77a", pmPreBg: "#11100e", pmPreBorder: "#463c31", pmPreText: "#eadfce",
        pmBlockquoteBorder: "#b77a48", pmBlockquoteText: "#baa993", pmHr: "#463c31", pmPlaceholder: "#8d7d69", pmTaskDone: "#8d7d69", pmScrollbar: "#463c31", pmScrollbarHover: "#665647", pmSelection: "rgba(215, 160, 107, 0.24)",
        radiusWindow: "12px", radiusCard: "10px", radiusButton: "8px", radiusInput: "8px", editorFontFamily: serif,
      }),
    },
  },
  {
    id: "minimal",
    name: { zh: "极简写作", en: "Minimal Writing" },
    description: { zh: "黑白灰低干扰界面，把注意力留给内容。", en: "Low-distraction monochrome UI that keeps focus on content." },
    modes: {
      light: variant(defaultLight, {
        bg: "#ffffff", surface: "#ffffff", sidebar: "#fafafa", sidebarSolid: "#fafafa", elevated: "#ffffff", elevatedSolid: "#ffffff",
        border: "#ececec", hover: "#f6f6f6", active: "#ededed", textPrimary: "#151515", textSecondary: "#666666", textTertiary: "#999999", textQuaternary: "#cccccc", textInverse: "#ffffff",
        accentPrimary: "#404040", accentSecondary: "#737373", accentMuted: "#999999",
        pmText: "#303030", pmHeading: "#111111", pmCodeBg: "#f4f4f4", pmCodeText: "#7a3742", pmPreBg: "#171717", pmPreBorder: "#272727", pmPreText: "#f5f5f5",
        pmBlockquoteBorder: "#a3a3a3", pmBlockquoteText: "#666666", pmHr: "#e5e5e5", pmPlaceholder: "#a3a3a3", pmTaskDone: "#a3a3a3", pmScrollbar: "#d4d4d4", pmScrollbarHover: "#a3a3a3", pmSelection: "rgba(64, 64, 64, 0.15)",
        radiusWindow: "6px", radiusCard: "5px", radiusButton: "4px", radiusInput: "4px",
      }),
      dark: variant(defaultDark, {
        bg: "#101010", surface: "#151515", sidebar: "#121212", sidebarSolid: "#121212", elevated: "#1c1c1c", elevatedSolid: "#1c1c1c",
        border: "#2a2a2a", hover: "#202020", active: "#2c2c2c", textPrimary: "#f1f1f1", textSecondary: "#aaaaaa", textTertiary: "#777777", textQuaternary: "#4f4f4f", textInverse: "#101010",
        accentPrimary: "#d4d4d4", accentSecondary: "#a3a3a3", accentMuted: "#777777",
        pmText: "#dddddd", pmHeading: "#ffffff", pmCodeBg: "#252525", pmCodeText: "#e2a5ad", pmPreBg: "#080808", pmPreBorder: "#2a2a2a", pmPreText: "#eeeeee",
        pmBlockquoteBorder: "#737373", pmBlockquoteText: "#aaaaaa", pmHr: "#2a2a2a", pmPlaceholder: "#666666", pmTaskDone: "#666666", pmScrollbar: "#333333", pmScrollbarHover: "#505050", pmSelection: "rgba(212, 212, 212, 0.16)",
        radiusWindow: "6px", radiusCard: "5px", radiusButton: "4px", radiusInput: "4px",
      }),
    },
  },
  {
    id: "eye-care",
    name: { zh: "夜间护眼", en: "Eye Care" },
    description: { zh: "低对比绿灰色系，Light/Dark 都保持柔和舒适。", en: "Gentle green-gray contrast in both light and dark modes." },
    modes: {
      light: variant(defaultLight, {
        bg: "#edf2e9", surface: "#f5f8f1", sidebar: "#e3eadf", sidebarSolid: "#e3eadf", elevated: "#f8faf5", elevatedSolid: "#f8faf5",
        border: "#cbd5c5", hover: "#e4ebe0", active: "#d2dfce", textPrimary: "#2f3b2f", textSecondary: "#62705f", textTertiary: "#849080", textQuaternary: "#b7c1b3", textInverse: "#f8faf5",
        accentPrimary: "#4f7457", accentSecondary: "#75945f", accentMuted: "#849080",
        pmText: "#3f4a3c", pmHeading: "#253225", pmCodeBg: "#e2e9dd", pmCodeText: "#7a4b43", pmPreBg: "#273129", pmPreBorder: "#465448", pmPreText: "#e5ede1",
        pmBlockquoteBorder: "#6e936e", pmBlockquoteText: "#5f6f5b", pmHr: "#cbd5c5", pmPlaceholder: "#849080", pmTaskDone: "#849080", pmScrollbar: "#bdc9b8", pmScrollbarHover: "#91a08d", pmSelection: "rgba(79, 116, 87, 0.20)",
        radiusWindow: "12px", radiusCard: "10px", radiusButton: "8px", radiusInput: "8px",
      }),
      dark: variant(defaultDark, {
        bg: "#111813", surface: "#17201a", sidebar: "#141c16", sidebarSolid: "#141c16", elevated: "#1f2922", elevatedSolid: "#1f2922",
        border: "#334238", hover: "#202b23", active: "#2c4031", textPrimary: "#dce7d8", textSecondary: "#9eae9a", textTertiary: "#788675", textQuaternary: "#4b5849", textInverse: "#111813",
        accentPrimary: "#8db394", accentSecondary: "#a2bd79", accentMuted: "#788675",
        pmText: "#cbd7c7", pmHeading: "#e7efe4", pmCodeBg: "#253028", pmCodeText: "#d3a096", pmPreBg: "#0e1410", pmPreBorder: "#334238", pmPreText: "#e0e9dd",
        pmBlockquoteBorder: "#66876b", pmBlockquoteText: "#a9b8a5", pmHr: "#334238", pmPlaceholder: "#788675", pmTaskDone: "#788675", pmScrollbar: "#334238", pmScrollbarHover: "#4c5e50", pmSelection: "rgba(141, 179, 148, 0.22)",
        radiusWindow: "12px", radiusCard: "10px", radiusButton: "8px", radiusInput: "8px",
      }),
    },
  },
  {
    id: "developer",
    name: { zh: "开发文档", en: "Developer Docs" },
    description: { zh: "技术蓝与代码优先的工作台，适合 API、方案和工程笔记。", en: "Technical blue, code-first workspace for APIs and engineering docs." },
    modes: {
      light: variant(defaultLight, {
        bg: "#f6f8fa", surface: "#ffffff", sidebar: "#eef2f6", sidebarSolid: "#eef2f6", elevated: "#ffffff", elevatedSolid: "#ffffff",
        border: "#d0d7de", hover: "#eef3f8", active: "#dbeafe", textPrimary: "#1f2328", textSecondary: "#59636e", textTertiary: "#818b98", textQuaternary: "#b9c0c8", textInverse: "#ffffff",
        accentPrimary: "#0969da", accentSecondary: "#1a7f37", accentMuted: "#818b98",
        pmText: "#24292f", pmHeading: "#1f2328", pmCodeBg: "#eff1f3", pmCodeText: "#cf222e", pmPreBg: "#0d1117", pmPreBorder: "#30363d", pmPreText: "#e6edf3",
        pmBlockquoteBorder: "#0969da", pmBlockquoteText: "#57606a", pmHr: "#d8dee4", pmPlaceholder: "#8c959f", pmTaskDone: "#8c959f", pmScrollbar: "#d0d7de", pmScrollbarHover: "#8c959f", pmSelection: "rgba(9, 105, 218, 0.18)",
        radiusWindow: "8px", radiusCard: "6px", radiusButton: "5px", radiusInput: "5px", editorFontFamily: mono,
      }),
      dark: variant(defaultDark, {
        bg: "#0d1117", surface: "#161b22", sidebar: "#10151c", sidebarSolid: "#10151c", elevated: "#1c2128", elevatedSolid: "#1c2128",
        border: "#30363d", hover: "#1f2937", active: "#1f3a5f", textPrimary: "#e6edf3", textSecondary: "#9da7b3", textTertiary: "#768390", textQuaternary: "#444c56", textInverse: "#0d1117",
        accentPrimary: "#58a6ff", accentSecondary: "#56d364", accentMuted: "#768390",
        pmText: "#c9d1d9", pmHeading: "#f0f6fc", pmCodeBg: "#1f2937", pmCodeText: "#ff7b72", pmPreBg: "#010409", pmPreBorder: "#30363d", pmPreText: "#e6edf3",
        pmBlockquoteBorder: "#58a6ff", pmBlockquoteText: "#8b949e", pmHr: "#30363d", pmPlaceholder: "#6e7681", pmTaskDone: "#6e7681", pmScrollbar: "#30363d", pmScrollbarHover: "#484f58", pmSelection: "rgba(88, 166, 255, 0.24)",
        radiusWindow: "8px", radiusCard: "6px", radiusButton: "5px", radiusInput: "5px", editorFontFamily: mono,
      }),
    },
  },
  {
    id: "magazine",
    name: { zh: "杂志排版", en: "Magazine" },
    description: { zh: "暖白、墨色与出版红，强调内容层次和阅读氛围。", en: "Warm white, ink tones and editorial red for a publication feel." },
    modes: {
      light: variant(defaultLight, {
        bg: "#f2eee7", surface: "#fbf9f5", sidebar: "#eae4da", sidebarSolid: "#eae4da", elevated: "#fffdf9", elevatedSolid: "#fffdf9",
        border: "#d7cec1", hover: "#eee8df", active: "#ead9d4", textPrimary: "#241f1b", textSecondary: "#655d55", textTertiary: "#8f857a", textQuaternary: "#c5bbb0", textInverse: "#fffdf9",
        accentPrimary: "#a33a32", accentSecondary: "#8a6d3b", accentMuted: "#8f857a",
        pmText: "#3f3832", pmHeading: "#201b17", pmCodeBg: "#eee7df", pmCodeText: "#8e312c", pmPreBg: "#241f1b", pmPreBorder: "#4a413a", pmPreText: "#f8f3ec",
        pmBlockquoteBorder: "#a33a32", pmBlockquoteText: "#6d6259", pmHr: "#d7cec1", pmPlaceholder: "#9a8f84", pmTaskDone: "#9a8f84", pmScrollbar: "#c9beb2", pmScrollbarHover: "#9f9184", pmSelection: "rgba(163, 58, 50, 0.18)",
        radiusWindow: "4px", radiusCard: "3px", radiusButton: "3px", radiusInput: "3px", editorFontFamily: serif,
      }),
      dark: variant(defaultDark, {
        bg: "#161310", surface: "#1d1916", sidebar: "#191512", sidebarSolid: "#191512", elevated: "#27211d", elevatedSolid: "#27211d",
        border: "#413832", hover: "#2a231f", active: "#4a2b29", textPrimary: "#eee7df", textSecondary: "#b5a89c", textTertiary: "#877b70", textQuaternary: "#574d46", textInverse: "#161310",
        accentPrimary: "#df7167", accentSecondary: "#c6a269", accentMuted: "#877b70",
        pmText: "#ddd2c8", pmHeading: "#fff7ef", pmCodeBg: "#2d2621", pmCodeText: "#ed938b", pmPreBg: "#0f0d0b", pmPreBorder: "#413832", pmPreText: "#eee7df",
        pmBlockquoteBorder: "#df7167", pmBlockquoteText: "#b5a89c", pmHr: "#413832", pmPlaceholder: "#877b70", pmTaskDone: "#877b70", pmScrollbar: "#413832", pmScrollbarHover: "#65564c", pmSelection: "rgba(223, 113, 103, 0.20)",
        radiusWindow: "4px", radiusCard: "3px", radiusButton: "3px", radiusInput: "3px", editorFontFamily: serif,
      }),
    },
  },
] as const;

const APPEARANCE_SET = new Set<string>(APP_APPEARANCE_IDS);
const APPEARANCE_BY_ID = new Map(APP_APPEARANCES.map((item) => [item.id, item]));

const TOKEN_PROPERTIES: Array<[keyof AppAppearanceTokens, string]> = [
  ["bg", "--color-bg"], ["surface", "--color-surface"], ["sidebar", "--color-sidebar"], ["sidebarSolid", "--color-sidebar-solid"],
  ["elevated", "--color-elevated"], ["elevatedSolid", "--color-elevated-solid"], ["border", "--color-border"], ["hover", "--color-hover"], ["active", "--color-active"],
  ["textPrimary", "--color-text-primary"], ["textSecondary", "--color-text-secondary"], ["textTertiary", "--color-text-tertiary"], ["textQuaternary", "--color-text-quaternary"], ["textInverse", "--color-text-inverse"],
  ["accentPrimary", "--color-accent-primary"], ["accentSecondary", "--color-accent-secondary"], ["accentWarning", "--color-accent-warning"], ["accentDanger", "--color-accent-danger"], ["accentMuted", "--color-accent-muted"],
  ["pmText", "--pm-text"], ["pmHeading", "--pm-heading"], ["pmCodeBg", "--pm-code-bg"], ["pmCodeText", "--pm-code-text"], ["pmPreBg", "--pm-pre-bg"], ["pmPreBorder", "--pm-pre-border"], ["pmPreText", "--pm-pre-text"],
  ["pmBlockquoteBorder", "--pm-blockquote-border"], ["pmBlockquoteText", "--pm-blockquote-text"], ["pmHr", "--pm-hr"], ["pmPlaceholder", "--pm-placeholder"], ["pmTaskDone", "--pm-task-done"],
  ["pmScrollbar", "--pm-scrollbar"], ["pmScrollbarHover", "--pm-scrollbar-hover"], ["pmSelection", "--pm-selection"],
  ["radiusWindow", "--radius-window"], ["radiusCard", "--radius-card"], ["radiusButton", "--radius-button"], ["radiusInput", "--radius-input"],
  ["editorFontFamily", "--editor-font-family"],
];

export const APP_APPEARANCE_STORAGE_KEY = "nowen-note-skin";
export const APP_APPEARANCE_CHANGED_EVENT = "nowen:app-appearance-change";

export function isAppAppearanceId(value: unknown): value is AppAppearanceId {
  return typeof value === "string" && APPEARANCE_SET.has(value);
}

export function normalizeAppAppearanceId(value: unknown): AppAppearanceId {
  return isAppAppearanceId(value) ? value : "default";
}

export function getAppAppearance(id: unknown): AppAppearanceDefinition {
  return APPEARANCE_BY_ID.get(normalizeAppAppearanceId(id)) || APP_APPEARANCES[0];
}

export function resolveAppAppearanceMode(root?: HTMLElement | null): AppAppearanceMode {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  return target?.classList.contains("dark") || target?.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function readStoredAppAppearance(): AppAppearanceId {
  try {
    return normalizeAppAppearanceId(localStorage.getItem(APP_APPEARANCE_STORAGE_KEY));
  } catch {
    return "default";
  }
}

export function applyAppAppearance(id: unknown, root?: HTMLElement | null): AppAppearanceId {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  const normalized = normalizeAppAppearanceId(id);
  if (!target) return normalized;

  target.setAttribute("data-app-appearance", normalized);
  if (normalized === "default") target.removeAttribute("data-skin");
  else target.setAttribute("data-skin", normalized);

  for (const [, property] of TOKEN_PROPERTIES) target.style.removeProperty(property);
  target.style.removeProperty("font-family");

  if (normalized !== "default") {
    const definition = getAppAppearance(normalized);
    const tokens = definition.modes[resolveAppAppearanceMode(target)];
    for (const [key, property] of TOKEN_PROPERTIES) target.style.setProperty(property, tokens[key]);
    target.style.setProperty("font-family", tokens.fontFamily);
  }

  const meta = typeof document === "undefined" ? null : document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = getAppAppearance(normalized).modes[resolveAppAppearanceMode(target)].accentPrimary;
  return normalized;
}

let runtimeInstalled = false;
let appearanceObserver: MutationObserver | null = null;

export function bootstrapAppAppearanceRuntime(): void {
  if (typeof window === "undefined" || typeof document === "undefined" || runtimeInstalled) return;
  runtimeInstalled = true;
  const root = document.documentElement;
  const applyStored = () => applyAppAppearance(readStoredAppAppearance(), root);
  applyStored();

  appearanceObserver = new MutationObserver((records) => {
    if (records.some((record) => record.type === "attributes" && (record.attributeName === "class" || record.attributeName === "data-theme"))) {
      applyStored();
    }
  });
  appearanceObserver.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });

  window.addEventListener("storage", (event) => {
    if (event.key === APP_APPEARANCE_STORAGE_KEY) applyStored();
  });
  window.addEventListener(APP_APPEARANCE_CHANGED_EVENT, applyStored);
}

export function appAppearanceTokenProperties(): readonly string[] {
  return TOKEN_PROPERTIES.map(([, property]) => property);
}
