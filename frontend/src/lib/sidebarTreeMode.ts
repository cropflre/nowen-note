export const SIDEBAR_TREE_MODE_STORAGE_KEY = "nowen.sidebar.tree-mode.v1";

export type SidebarTreeMode = "knowledge" | "legacy";

export interface SidebarTreeModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseSidebarTreeMode(value: unknown): SidebarTreeMode {
  return value === "legacy" ? "legacy" : "knowledge";
}

export function loadSidebarTreeMode(storage?: SidebarTreeModeStorage | null): SidebarTreeMode {
  if (!storage) return "knowledge";
  try {
    return parseSidebarTreeMode(storage.getItem(SIDEBAR_TREE_MODE_STORAGE_KEY));
  } catch {
    return "knowledge";
  }
}

export function saveSidebarTreeMode(
  mode: SidebarTreeMode,
  storage?: SidebarTreeModeStorage | null,
): SidebarTreeMode {
  if (!storage) return mode;
  try {
    storage.setItem(SIDEBAR_TREE_MODE_STORAGE_KEY, mode);
  } catch {
    // Navigation must remain usable when storage is unavailable.
  }
  return mode;
}

export function nextSidebarTreeMode(mode: SidebarTreeMode): SidebarTreeMode {
  return mode === "knowledge" ? "legacy" : "knowledge";
}
