export type ShortcutPlatform = "macos" | "windows" | "linux";
export type ShortcutSurface = "web" | "desktop" | "android";
export type ShortcutScope = "global" | "noneditable" | "editor" | "input-safe";
export type ShortcutCategory = "global" | "navigation" | "rich-text" | "markdown" | "desktop";
export type ShortcutChord = readonly string[];

export interface ShortcutCommand {
  id: string;
  label: string;
  description: string;
  category: ShortcutCategory;
  scope: ShortcutScope;
  defaultKeys: Partial<Record<ShortcutPlatform, readonly ShortcutChord[]>>;
  availableIn: readonly ShortcutSurface[];
  tooltipAliases?: readonly string[];
}

export interface ShortcutConflict {
  platform: ShortcutPlatform;
  chord: string;
  commandIds: string[];
}
