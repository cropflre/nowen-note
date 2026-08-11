export type MobileKnowledgeTreeViewMode = "navigator" | "tree";
export type DesktopKnowledgeTreeViewMode = "quick" | "tree";

export const MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY = "nowen.mobileKnowledgeTree.viewMode.v1";
export const MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT = "nowen:mobile-knowledge-tree-view-mode-changed";
export const MOBILE_KNOWLEDGE_TREE_COMPACT_STORAGE_KEY = "nowen.mobileKnowledgeTree.compact.v1";
export const MOBILE_KNOWLEDGE_TREE_COMPACT_CHANGED_EVENT = "nowen:mobile-knowledge-tree-compact-changed";
export const DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY = "nowen.desktopKnowledgeTree.viewMode.v1";
export const DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT = "nowen:desktop-knowledge-tree-view-mode-changed";

const VALID_MODES = new Set<MobileKnowledgeTreeViewMode>(["navigator", "tree"]);
const DESKTOP_VALID_MODES = new Set<DesktopKnowledgeTreeViewMode>(["quick", "tree"]);

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadMobileKnowledgeTreeViewMode(): MobileKnowledgeTreeViewMode {
  const value = storage()?.getItem(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY) as MobileKnowledgeTreeViewMode | null;
  return value && VALID_MODES.has(value) ? value : "navigator";
}

export function saveMobileKnowledgeTreeViewMode(mode: MobileKnowledgeTreeViewMode): void {
  try {
    storage()?.setItem(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // The current React state still switches immediately when storage is unavailable.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, { detail: { mode } }));
  }
}

export function loadMobileKnowledgeTreeCompact(): boolean {
  return storage()?.getItem(MOBILE_KNOWLEDGE_TREE_COMPACT_STORAGE_KEY) === "true";
}

export function saveMobileKnowledgeTreeCompact(compact: boolean): void {
  try {
    storage()?.setItem(MOBILE_KNOWLEDGE_TREE_COMPACT_STORAGE_KEY, String(compact));
  } catch {
    // 存储不可用时，当前 React 状态仍会立即完成切换。
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MOBILE_KNOWLEDGE_TREE_COMPACT_CHANGED_EVENT, {
      detail: { compact },
    }));
  }
}

export function loadDesktopKnowledgeTreeViewMode(): DesktopKnowledgeTreeViewMode {
  const value = storage()?.getItem(DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY) as DesktopKnowledgeTreeViewMode | null;
  return value && DESKTOP_VALID_MODES.has(value) ? value : "tree";
}

export function saveDesktopKnowledgeTreeViewMode(mode: DesktopKnowledgeTreeViewMode): void {
  try {
    storage()?.setItem(DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // 存储不可用时，当前 React 状态仍会立即完成切换。
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, { detail: { mode } }));
  }
}
