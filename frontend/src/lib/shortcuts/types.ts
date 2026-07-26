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
  secondaryCategories?: readonly ShortcutCategory[];
  scope: ShortcutScope;
  defaultKeys: Partial<Record<ShortcutPlatform, readonly ShortcutChord[]>>;
  surfaceKeys?: Partial<
    Record<ShortcutSurface, Partial<Record<ShortcutPlatform, readonly ShortcutChord[]>>>
  >;
  availableIn: readonly ShortcutSurface[];
  tooltipAliases?: readonly string[];
  /** Only commands whose complete runtime path is registry-backed may be edited. */
  customizable?: boolean;
}

export interface ShortcutConflict {
  surface: ShortcutSurface;
  platform: ShortcutPlatform;
  chord: string;
  commandIds: string[];
}
