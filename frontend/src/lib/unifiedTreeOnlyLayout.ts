export const LEGACY_NOTE_LIST_COLLAPSED_KEY = "nowen-notelist-collapsed";
export const LEGACY_NOTEBOOK_TREE_SORT_KEY = "nowen.notebookTree.sort";
export const NOTE_WORKSPACE_LAYOUT_KEY = "nowen-note-workspace-layout";

const FUNCTIONAL_NOTE_LIST_VIEWS = new Set([
  "favorites",
  "trash",
  "tag",
  "search",
]);

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Cross-tree result sets and batch-management surfaces still require a
 * dedicated note list even when the ordinary notebook workspace uses the
 * unified knowledge tree directly.
 */
export function usesFunctionalNoteList(viewMode: string): boolean {
  return FUNCTIONAL_NOTE_LIST_VIEWS.has(viewMode);
}

/**
 * Compatibility helper retained for older callers and tests. New wide-screen
 * layout code must use the explicit workspace layout preference instead of
 * enforcing this result at runtime.
 */
export function shouldCollapseLegacyNoteList(viewMode: string): boolean {
  return !usesFunctionalNoteList(viewMode);
}

/**
 * Runs before AppContext reads the old note-list cache.
 *
 * The previous unified-tree migration always wrote `collapsed=1` on every
 * startup. That became incorrect once standard/three-column modes were added:
 * a saved three-column preference would start collapsed and then compete with
 * the layout controller. Keep the old cache aligned with the explicit layout
 * preference instead, while preserving standard mode for users who have never
 * chosen a workspace layout.
 */
export function migrateUnifiedTreeOnlyLayout(
  storage: StorageLike | null | undefined = typeof window === "undefined" ? null : window.localStorage,
): void {
  if (!storage) return;
  try {
    const explicitLayout = storage.getItem(NOTE_WORKSPACE_LAYOUT_KEY);
    storage.setItem(
      LEGACY_NOTE_LIST_COLLAPSED_KEY,
      explicitLayout === "three-column" ? "0" : "1",
    );
    storage.removeItem(LEGACY_NOTEBOOK_TREE_SORT_KEY);
  } catch {
    // Privacy mode and restricted WebViews may reject storage writes. Runtime
    // layout reconciliation still runs after AppContext mounts.
  }
}
