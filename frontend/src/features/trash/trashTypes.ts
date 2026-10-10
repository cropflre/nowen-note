export type TrashResourceType = "note" | "notebook" | "mindmap" | "sheet";
export interface TrashItem {
  id: string;
  resourceId: string;
  resourceType: TrashResourceType;
  title: string;
  contentFormat: string | null;
  deletedAt: string | null;
  originalParentId: string | null;
  originalPath: string[];
  originalPathHidden: boolean;
  canRestore: boolean;
  canDeletePermanently: boolean;
  isLocked: boolean;
  restoreIncludesAncestors: boolean;
}
export interface TrashBatchResult {
  succeededIds: string[];
  noteIds: string[];
  failures: Array<{ id: string; code: string; error: string }>;
}

export function permanentSelection(items: TrashItem[], ids: string[]): TrashItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const selected = new Set(ids);
  return items.filter((item) => {
    const seen = new Set<string>();
    for (let current: TrashItem | undefined = item; current && !seen.has(current.id); current = byId.get(current.originalParentId || "")) {
      if (selected.has(current.id)) return true;
      seen.add(current.id);
    }
    return false;
  });
}
