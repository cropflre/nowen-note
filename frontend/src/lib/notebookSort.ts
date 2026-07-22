import type { Notebook } from "@/types";

export type NotebookSortBy = "manual" | "name" | "createdAt" | "updatedAt";
export type NotebookSortDir = "asc" | "desc";
export type NotebookSortPref = { by: NotebookSortBy; dir: NotebookSortDir };
export type NotebookSortPrefMap = Record<string, NotebookSortPref>;
export type NotebookSortResolver = NotebookSortPref | ((parentId: string | null) => NotebookSortPref);
export type NotebookDropZone = "before" | "inside" | "after";
export type NotebookReorderItem = { id: string; sortOrder: number };
export type NotebookMovePayload = { parentId: string | null; sortOrder: number };
export type NotebookDropResult = {
  nextNotebooks: Notebook[];
  movePayload: NotebookMovePayload;
  reorderItems: NotebookReorderItem[];
  expandedNotebookId: string | null;
};

export const DEFAULT_NOTEBOOK_SORT_PREF: NotebookSortPref = { by: "manual", dir: "desc" };
export const ROOT_NOTEBOOK_SORT_KEY = "__root__";

export function notebookSortKey(parentId: string | null): string {
  return parentId ?? ROOT_NOTEBOOK_SORT_KEY;
}

export function resolveNotebookSortPref(
  explicitPref: NotebookSortPref | undefined,
  rootPref: NotebookSortPref,
): NotebookSortPref {
  return explicitPref ?? rootPref;
}

export function getNotebookSortPrefForParent(
  prefMap: NotebookSortPrefMap,
  parentId: string | null,
): NotebookSortPref {
  const rootPref = prefMap[ROOT_NOTEBOOK_SORT_KEY] ?? DEFAULT_NOTEBOOK_SORT_PREF;
  if (parentId === null) return rootPref;
  return resolveNotebookSortPref(prefMap[notebookSortKey(parentId)], rootPref);
}

export function normalizeNotebookSortPref(raw: unknown): NotebookSortPref {
  if (!raw || typeof raw !== "object") return DEFAULT_NOTEBOOK_SORT_PREF;
  const input = raw as { by?: unknown; dir?: unknown };
  const by: NotebookSortBy =
    input.by === "name" || input.by === "createdAt" || input.by === "updatedAt" || input.by === "manual"
      ? input.by
      : "manual";
  const dir: NotebookSortDir = input.dir === "asc" ? "asc" : "desc";
  return { by, dir };
}

export function compareNotebooks(a: Notebook, b: Notebook, pref: NotebookSortPref): number {
  if (pref.by === "manual") {
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id);
  }

  const factor = pref.dir === "asc" ? 1 : -1;
  if (pref.by === "name") {
    return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }) * factor
      || a.id.localeCompare(b.id);
  }

  const av = a[pref.by] || "";
  const bv = b[pref.by] || "";
  return ((av < bv ? -1 : av > bv ? 1 : 0) * factor) || a.id.localeCompare(b.id);
}

export function buildNotebookTree(notebooks: Notebook[], pref: NotebookSortResolver = DEFAULT_NOTEBOOK_SORT_PREF): Notebook[] {
  const map = new Map<string, Notebook>();
  const roots: Notebook[] = [];
  notebooks.forEach((nb) => map.set(nb.id, { ...nb, children: [] }));
  notebooks.forEach((nb) => {
    const node = map.get(nb.id)!;
    if (nb.parentId && map.has(nb.parentId)) {
      map.get(nb.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  });

  const resolvePref: (parentId: string | null) => NotebookSortPref =
    typeof pref === "function" ? pref : () => pref;

  const sortRecursive = (list: Notebook[], parentId: string | null) => {
    const effectivePref = resolvePref(parentId);
    list.sort((a, b) => compareNotebooks(a, b, effectivePref));
    list.forEach((n) => {
      if (n.children && n.children.length > 0) sortRecursive(n.children, n.id);
    });
  };
  sortRecursive(roots, null);
  return roots;
}

function sameNotebookFields(a: Notebook, b: Notebook): boolean {
  return a.id === b.id
    && a.userId === b.userId
    && a.workspaceId === b.workspaceId
    && a.parentId === b.parentId
    && a.name === b.name
    && a.description === b.description
    && a.icon === b.icon
    && a.color === b.color
    && a.sortOrder === b.sortOrder
    && a.isExpanded === b.isExpanded
    && a.createdAt === b.createdAt
    && a.updatedAt === b.updatedAt
    && a.noteCount === b.noteCount
    && a.myRole === b.myRole
    && a.permission === b.permission;
}

/**
 * buildNotebookTree intentionally creates mutable children arrays while assembling the
 * tree. Reconcile the finished tree with the previous immutable result so unchanged
 * branches keep their object identity and memoized recursive rows can bail out.
 */
export function reuseNotebookTreeReferences(next: Notebook[], previous: Notebook[]): Notebook[] {
  if (previous.length === 0) return next;
  const previousById = new Map<string, Notebook>();
  const indexPrevious = (nodes: Notebook[]) => {
    for (const node of nodes) {
      previousById.set(node.id, node);
      if (node.children?.length) indexPrevious(node.children);
    }
  };
  indexPrevious(previous);

  const reconcile = (node: Notebook): Notebook => {
    const nextChildren = (node.children || []).map(reconcile);
    const previousNode = previousById.get(node.id);
    const previousChildren = previousNode?.children || [];
    const childrenUnchanged = previousChildren.length === nextChildren.length
      && previousChildren.every((child, index) => child === nextChildren[index]);
    if (previousNode && childrenUnchanged && sameNotebookFields(previousNode, node)) {
      return previousNode;
    }
    return { ...node, children: nextChildren };
  };

  return next.map(reconcile);
}

export function notebookTreeContainsId(
  notebook: Notebook,
  id: string | null | undefined,
): boolean {
  if (!id) return false;
  if (notebook.id === id) return true;
  return notebook.children?.some((child) => notebookTreeContainsId(child, id)) ?? false;
}

export function notebookTreeMapChanged<T>(
  notebook: Notebook,
  previous: ReadonlyMap<string, T> | undefined,
  next: ReadonlyMap<string, T> | undefined,
): boolean {
  if (previous?.get(notebook.id) !== next?.get(notebook.id)) return true;
  return notebook.children?.some(
    (child) => notebookTreeMapChanged(child, previous, next),
  ) ?? false;
}

export function notebookTreeSetChanged(
  notebook: Notebook,
  previous: ReadonlySet<string> | undefined,
  next: ReadonlySet<string> | undefined,
): boolean {
  if (previous?.has(notebook.id) !== next?.has(notebook.id)) return true;
  return notebook.children?.some(
    (child) => notebookTreeSetChanged(child, previous, next),
  ) ?? false;
}

export function getNotebookDragHint(canDragSort: boolean): string {
  return canDragSort ? "拖动调整笔记本顺序" : "切换到手动排序后可拖动调整顺序";
}

export function getNotebookDropZone(clientY: number, rect: Pick<DOMRect, "top" | "height">): NotebookDropZone {
  const offset = clientY - rect.top;
  if (offset < rect.height * 0.25) return "before";
  if (offset > rect.height * 0.75) return "after";
  return "inside";
}

function isNotebookDescendant(notebooks: Notebook[], sourceId: string, candidateId: string): boolean {
  if (sourceId === candidateId) return true;
  let cursor: string | null = candidateId;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) return false;
    visited.add(cursor);
    if (cursor === sourceId) return true;
    const parent = notebooks.find((n) => n.id === cursor)?.parentId ?? null;
    cursor = parent;
  }
  return false;
}

function manualSiblings(notebooks: Notebook[], parentId: string | null, excludeId?: string): Notebook[] {
  return notebooks
    .filter((n) => (n.parentId ?? null) === parentId && n.id !== excludeId)
    .sort((a, b) => compareNotebooks(a, b, DEFAULT_NOTEBOOK_SORT_PREF));
}

export function reorderNotebooksForDrop(
  notebooks: Notebook[],
  sourceId: string,
  targetId: string,
  zone: NotebookDropZone,
): NotebookDropResult | null {
  if (!sourceId || !targetId || sourceId === targetId) return null;
  if (isNotebookDescendant(notebooks, sourceId, targetId)) return null;

  const source = notebooks.find((n) => n.id === sourceId);
  const target = notebooks.find((n) => n.id === targetId);
  if (!source || !target) return null;

  const newParentId = zone === "inside" ? target.id : target.parentId ?? null;
  const siblings = manualSiblings(notebooks, newParentId, sourceId);
  const targetIndex = zone === "inside" ? siblings.length : siblings.findIndex((n) => n.id === targetId);
  if (targetIndex < 0) return null;

  const insertIndex = zone === "after" ? targetIndex + 1 : targetIndex;
  const movedSource: Notebook = { ...source, parentId: newParentId };
  const nextSiblings = [...siblings];
  nextSiblings.splice(insertIndex, 0, movedSource);

  const reorderItems = nextSiblings.map((n, index) => ({ id: n.id, sortOrder: index }));
  const orderMap = new Map(reorderItems.map((item) => [item.id, item.sortOrder]));
  const nextNotebooks = notebooks.map((n) => {
    if (n.id === sourceId) {
      return { ...n, parentId: newParentId, sortOrder: orderMap.get(n.id) ?? n.sortOrder };
    }
    if (n.id === targetId && zone === "inside") {
      return { ...n, isExpanded: 1 };
    }
    if (orderMap.has(n.id)) {
      return { ...n, sortOrder: orderMap.get(n.id)! };
    }
    return n;
  });

  return {
    nextNotebooks,
    movePayload: { parentId: newParentId, sortOrder: insertIndex },
    reorderItems,
    expandedNotebookId: zone === "inside" ? targetId : null,
  };
}
