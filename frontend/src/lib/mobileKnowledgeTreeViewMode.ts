export type MobileKnowledgeTreeViewMode = "navigator" | "tree";

export const MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY = "nowen.mobileKnowledgeTree.viewMode.v1";
export const MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT = "nowen:mobile-knowledge-tree-view-mode-changed";

const VALID_MODES = new Set<MobileKnowledgeTreeViewMode>(["navigator", "tree"]);

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
