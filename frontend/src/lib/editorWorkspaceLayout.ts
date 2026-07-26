export type EditorWorkspaceMode = "focus" | "split" | "fullscreen";
export type EditorSplitDirection = "right" | "down";

/** The legacy middle note-list column no longer has a keyboard toggle. */
export const EDITOR_LAYOUT_TOGGLE_SHORTCUT_LABEL = "";
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

/** Kept as a compatibility export for large editor components; always retired. */
export function isEditorLayoutToggleShortcut(_event: ShortcutLikeEvent): boolean {
  return false;
}

export function resolveEditorWorkspaceMode(input: {
  editorFullscreen: boolean;
  noteListCollapsed: boolean;
  hasSplit: boolean;
}): EditorWorkspaceMode {
  if (input.editorFullscreen) return "fullscreen";
  if (input.hasSplit) return "split";
  return "focus";
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
