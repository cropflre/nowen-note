import {
  Compass,
  FileCode2,
  Monitor,
  Sparkles,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import {
  SHORTCUT_CATEGORY_LABELS,
  type ShortcutCategory,
  type ShortcutChord,
  type ShortcutPlatform,
} from "@/lib/shortcutRegistry";

export const SHORTCUT_CATEGORY_ORDER: readonly ShortcutCategory[] = [
  "global",
  "navigation",
  "rich-text",
  "markdown",
  "desktop",
];

export interface ShortcutCategoryMeta {
  label: string;
  tagline: string;
  icon: LucideIcon;
  badgeClass: string;
  dotClass: string;
}

export const SHORTCUT_CATEGORY_META: Readonly<Record<ShortcutCategory, ShortcutCategoryMeta>> = {
  global: {
    label: SHORTCUT_CATEGORY_LABELS.global,
    tagline: "随叫随到的全局招式",
    icon: Sparkles,
    badgeClass: "bg-sky-500/12 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
    dotClass: "bg-sky-500",
  },
  navigation: {
    label: SHORTCUT_CATEGORY_LABELS.navigation,
    tagline: "分屏与视野自由切换",
    icon: Compass,
    badgeClass: "bg-teal-500/12 text-teal-700 dark:bg-teal-400/15 dark:text-teal-300",
    dotClass: "bg-teal-500",
  },
  "rich-text": {
    label: SHORTCUT_CATEGORY_LABELS["rich-text"],
    tagline: "富文本排版顺手一击",
    icon: Wand2,
    badgeClass: "bg-amber-500/15 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    dotClass: "bg-amber-500",
  },
  markdown: {
    label: SHORTCUT_CATEGORY_LABELS.markdown,
    tagline: "纯文本写作极速语法",
    icon: FileCode2,
    badgeClass: "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    dotClass: "bg-emerald-500",
  },
  desktop: {
    label: SHORTCUT_CATEGORY_LABELS.desktop,
    tagline: "桌面端专属快捷通道",
    icon: Monitor,
    badgeClass: "bg-slate-500/12 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300",
    dotClass: "bg-slate-500",
  },
};

const MODIFIER_RAW_TOKENS = new Set(["Mod", "Alt", "Shift", "Ctrl", "Cmd", "Meta"]);

export interface KeycapToken {
  raw: string;
  label: string;
  isModifier: boolean;
}

export function formatPlatformKeyToken(token: string, platform: ShortcutPlatform): string {
  if (token === "Mod") return platform === "macos" ? "⌘" : "Ctrl";
  if (token === "Alt") return platform === "macos" ? "⌥" : "Alt";
  if (token === "Shift") return platform === "macos" ? "⇧" : "Shift";
  if (token === "Enter") return platform === "macos" ? "↩" : "Enter";
  if (token === "Backspace") return platform === "macos" ? "⌫" : "Backspace";
  if (token === "Escape") return "Esc";
  if (token === "Space") return "Space";
  if (token === "ArrowUp") return "↑";
  if (token === "ArrowDown") return "↓";
  if (token === "ArrowLeft") return "←";
  if (token === "ArrowRight") return "→";
  return token.length === 1 ? token.toUpperCase() : token;
}

export function chordToKeycapTokens(
  chord: ShortcutChord,
  platform: ShortcutPlatform,
): KeycapToken[] {
  return chord.map((raw) => ({
    raw,
    label: formatPlatformKeyToken(raw, platform),
    isModifier: MODIFIER_RAW_TOKENS.has(raw),
  }));
}

export function formatPlatformDisplayName(platform: ShortcutPlatform): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  return "Linux";
}

/**
 * Extracts currently held modifier tokens from a KeyboardEvent for live keycap feedback.
 */
export function extractLiveModifierTokens(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: ShortcutPlatform,
): string[] {
  const tokens: string[] = [];
  if (platform === "macos" ? event.metaKey : event.ctrlKey) tokens.push("Mod");
  if (event.altKey) tokens.push("Alt");
  if (event.shiftKey) tokens.push("Shift");
  return tokens;
}

/**
 * Normalizes a non-modifier KeyboardEvent key into a display token for live key echo.
 */
export function extractLivePrimaryToken(event: Pick<KeyboardEvent, "key">): string | null {
  if (["Control", "Meta", "Alt", "Shift", "Dead", "Process"].includes(event.key)) return null;
  if (event.key === " ") return "Space";
  if (event.key === "?") return "/";
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}
