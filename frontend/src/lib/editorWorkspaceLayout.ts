export type EditorWorkspaceMode = "manage" | "focus" | "split" | "fullscreen";
export type EditorSplitDirection = "right" | "down";

export const EDITOR_LAYOUT_TOGGLE_SHORTCUT_LABEL = "Ctrl/Cmd + Shift + B";
const SPLIT_RATIO_STORAGE_PREFIX = "nowen.editorSplit.ratio";

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

export function isEditorLayoutToggleShortcut(event: ShortcutLikeEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) === true &&
    event.shiftKey === true &&
    event.altKey !== true &&
    event.key.toLowerCase() === "b"
  );
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
