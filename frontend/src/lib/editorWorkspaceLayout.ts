import {
  detectShortcutSurface,
  formatPortableShortcutForCommand,
  shortcutMatchesEvent,
  type ShortcutPlatform,
} from "@/lib/shortcutRegistry";

export type EditorWorkspaceMode = "manage" | "focus" | "split" | "fullscreen";
export type EditorSplitDirection = "right" | "down";

export const EDITOR_LAYOUT_TOGGLE_SHORTCUT_LABEL = formatPortableShortcutForCommand("toggle-note-list");
const SPLIT_RATIO_STORAGE_PREFIX = "nowen.editorSplit.ratio";
const SHORTCUT_PLATFORMS: readonly ShortcutPlatform[] = ["macos", "windows", "linux"];

export interface ShortcutLikeEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * This compatibility helper is intentionally host-platform agnostic.
 * Unit tests, Electron IPC shims, and synthetic events may represent either
 * Ctrl or Meta regardless of the machine running the code. The actual chord
 * still comes exclusively from the shared shortcut registry.
 */
export function isEditorLayoutToggleShortcut(event: ShortcutLikeEvent): boolean {
  const normalizedEvent = {
    key: event.key,
    metaKey: event.metaKey === true,
    ctrlKey: event.ctrlKey === true,
    shiftKey: event.shiftKey === true,
    altKey: event.altKey === true,
  };
  const surface = detectShortcutSurface();
  return SHORTCUT_PLATFORMS.some((platform) => (
    shortcutMatchesEvent("toggle-note-list", normalizedEvent, platform, surface)
  ));
}

export function resolveEditorWorkspaceMode(input: {
  editorFullscreen: boolean;
  noteListCollapsed: boolean;
  hasSplit: boolean;
}): EditorWorkspaceMode {
  if (input.editorFullscreen) return "fullscreen";
  if (input.hasSplit) return "split";
  if (input.noteListCollapsed) return "focus";
  return "manage";
}

export function clampEditorSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0.2, Math.min(0.8, value));
}

export function getEditorSplitRatioStorageKey(direction: EditorSplitDirection): string {
  return `${SPLIT_RATIO_STORAGE_PREFIX}.${direction}`;
}

export function loadEditorSplitRatio(
  direction: EditorSplitDirection,
  storage: StorageLike | null | undefined = typeof window === "undefined" ? null : window.localStorage,
): number {
  if (!storage) return 0.5;
  try {
    const value = storage.getItem(getEditorSplitRatioStorageKey(direction));
    if (value == null || value.trim() === "") return 0.5;
    return clampEditorSplitRatio(Number(value));
  } catch {
    return 0.5;
  }
}

export function saveEditorSplitRatio(
  direction: EditorSplitDirection,
  value: number,
  storage: StorageLike | null | undefined = typeof window === "undefined" ? null : window.localStorage,
): number {
  const normalized = clampEditorSplitRatio(value);
  if (!storage) return normalized;
  try {
    storage.setItem(getEditorSplitRatioStorageKey(direction), String(normalized));
  } catch {
    // Storage can be unavailable in privacy mode; the in-memory ratio still works.
  }
  return normalized;
}
