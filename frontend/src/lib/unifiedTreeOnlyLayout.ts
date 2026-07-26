export const LEGACY_NOTE_LIST_COLLAPSED_KEY = "nowen-notelist-collapsed";
export const LEGACY_NOTEBOOK_TREE_SORT_KEY = "nowen.notebookTree.sort";

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
 * The unified content tree is the only everyday note-navigation hierarchy.
 * These exceptional views still need a dedicated list because they represent
 * cross-tree result sets or batch-management surfaces rather than a notebook
 * directory.
 */
export function usesFunctionalNoteList(viewMode: string): boolean {
  return FUNCTIONAL_NOTE_LIST_VIEWS.has(viewMode);
}

export function shouldCollapseLegacyNoteList(viewMode: string): boolean {
  return !usesFunctionalNoteList(viewMode);
}

/**
 * Runs before AppContext reads its legacy layout cache. Existing users who
 * saved the old three-column notebook-directory layout are migrated to the
 * unified-tree layout without a one-frame flash on startup.
 */
export function migrateUnifiedTreeOnlyLayout(
  storage: StorageLike | null | undefined = typeof window === "undefined" ? null : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(LEGACY_NOTE_LIST_COLLAPSED_KEY, "1");
    storage.removeItem(LEGACY_NOTEBOOK_TREE_SORT_KEY);
  } catch {
    // Privacy mode and restricted WebViews may reject storage writes. Runtime
    // enforcement still applies after AppContext mounts.
  }
}
