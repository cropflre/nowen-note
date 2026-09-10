export type NoteListScrollScope = {
  viewMode: string;
  selectedNotebookId?: string | null;
  selectedKnowledgeTreeParentId?: string | null;
  selectedTagIds?: readonly string[];
  searchQuery?: string | null;
  dateFilter?: string | null;
  sortBy: string;
  sortDir: string;
  folderScope: "current" | "recursive";
  unlockedFolderIds?: readonly string[];
  folderPasswordSessionRevision?: number;
};

/**
 * A note-list refresh is not the same thing as a navigation change.
 *
 * Keep this key restricted to inputs that change which logical list the user is browsing.
 * Mutable note data (title/content/updatedAt/version) and refresh tokens deliberately do not
 * participate, otherwise autosave/realtime refreshes would reset the user's scroll position.
 */
export function buildNoteListScrollScopeKey(scope: NoteListScrollScope): string {
  return JSON.stringify({
    viewMode: scope.viewMode,
    selectedNotebookId: scope.selectedNotebookId ?? null,
    selectedKnowledgeTreeParentId: scope.selectedKnowledgeTreeParentId ?? null,
    selectedTagIds: [...(scope.selectedTagIds || [])].sort(),
    searchQuery: scope.searchQuery || "",
    dateFilter: scope.dateFilter || null,
    sortBy: scope.sortBy,
    sortDir: scope.sortDir,
    folderScope: scope.folderScope,
    unlockedFolderIds: [...(scope.unlockedFolderIds || [])].sort(),
    folderPasswordSessionRevision: scope.folderPasswordSessionRevision || 0,
  });
}

export type NoteListScrollAnchor = {
  noteId: string;
  offsetWithinItem: number;
};

/**
 * Re-resolve a virtual-list visual anchor after data changes within the same scope.
 * Returning null means the anchor note disappeared and the browser's current/clamped scrollTop
 * should be kept instead of unexpectedly jumping somewhere else.
 */
export function resolveAnchoredScrollTop(
  noteIds: readonly string[],
  anchor: NoteListScrollAnchor | null,
  itemHeight: number,
): number | null {
  if (!anchor || itemHeight <= 0) return null;
  const index = noteIds.indexOf(anchor.noteId);
  if (index < 0) return null;
  return index * itemHeight + Math.max(0, Math.min(anchor.offsetWithinItem, itemHeight - 1));
}
