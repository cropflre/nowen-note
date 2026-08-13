import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

export const KNOWLEDGE_TREE_SORT_STORAGE_KEY = "nowen.knowledgeTree.sort";
export const KNOWLEDGE_TREE_SORT_CHANGED_EVENT = "nowen:knowledge-tree-sort-changed";

export type KnowledgeTreeSortMode =
  | "manual"
  | "title-asc"
  | "title-desc"
  | "updated-desc"
  | "created-desc";

export interface KnowledgeTreeSortOption {
  value: KnowledgeTreeSortMode;
  label: string;
}

export const KNOWLEDGE_TREE_SORT_OPTIONS: KnowledgeTreeSortOption[] = [
  { value: "manual", label: "手动排序" },
  { value: "title-asc", label: "名称 A–Z" },
  { value: "title-desc", label: "名称 Z–A" },
  { value: "updated-desc", label: "最近更新" },
  { value: "created-desc", label: "最近创建" },
];

const VALID_SORT_MODES = new Set<KnowledgeTreeSortMode>(
  KNOWLEDGE_TREE_SORT_OPTIONS.map((option) => option.value),
);

export function loadKnowledgeTreeSortMode(): KnowledgeTreeSortMode {
  try {
    const stored = localStorage.getItem(KNOWLEDGE_TREE_SORT_STORAGE_KEY) as KnowledgeTreeSortMode | null;
    return stored && VALID_SORT_MODES.has(stored) ? stored : "manual";
  } catch {
    return "manual";
  }
}

export function saveKnowledgeTreeSortMode(mode: KnowledgeTreeSortMode): void {
  try {
    localStorage.setItem(KNOWLEDGE_TREE_SORT_STORAGE_KEY, mode);
  } catch {
    // Current-session sorting still works when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_SORT_CHANGED_EVENT, { detail: { mode } }));
  window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "sort-mode-changed" } }));
}

function compareText(a: KnowledgeTreeNode, b: KnowledgeTreeNode): number {
  return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareKnowledgeTreePinnedPriority(
  a: KnowledgeTreeNode,
  b: KnowledgeTreeNode,
): number {
  const aFolder = a.nodeType === "folder";
  const bFolder = b.nodeType === "folder";
  if (aFolder !== bFolder) return aFolder ? -1 : 1;

  const aPinned = a.resourceType === "note" && a.isPinned === 1;
  const bPinned = b.resourceType === "note" && b.isPinned === 1;
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  return 0;
}

export function compareKnowledgeTreeNodes(
  a: KnowledgeTreeNode,
  b: KnowledgeTreeNode,
  mode: KnowledgeTreeSortMode,
): number {
  const pinnedPriority = compareKnowledgeTreePinnedPriority(a, b);
  if (pinnedPriority !== 0) return pinnedPriority;

  let result = 0;
  switch (mode) {
    case "title-asc":
      result = compareText(a, b);
      break;
    case "title-desc":
      result = compareText(b, a);
      break;
    case "updated-desc":
      result = timestamp(b.updatedAt) - timestamp(a.updatedAt);
      break;
    case "created-desc":
      result = timestamp(b.createdAt) - timestamp(a.createdAt);
      break;
    case "manual":
    default:
      result = a.sortOrder - b.sortOrder;
      break;
  }
  return result || a.sortOrder - b.sortOrder || compareText(a, b) || a.id.localeCompare(b.id);
}

/**
 * KnowledgeTreePanel currently groups nodes by parent and sorts each sibling list
 * by sortOrder. Non-manual modes therefore project a display-only sortOrder for
 * each sibling group; no server hierarchy or manual order is mutated.
 */
export function applyKnowledgeTreeSort(
  nodes: KnowledgeTreeNode[],
  mode: KnowledgeTreeSortMode = loadKnowledgeTreeSortMode(),
): KnowledgeTreeNode[] {
  if (mode === "manual") return nodes;

  const siblings = new Map<string | null, KnowledgeTreeNode[]>();
  for (const node of nodes) {
    const group = siblings.get(node.parentId) || [];
    group.push(node);
    siblings.set(node.parentId, group);
  }

  const displayOrder = new Map<string, number>();
  for (const group of siblings.values()) {
    group
      .slice()
      .sort((a, b) => compareKnowledgeTreeNodes(a, b, mode))
      .forEach((node, index) => displayOrder.set(node.id, index));
  }

  return nodes.map((node) => ({
    ...node,
    sortOrder: displayOrder.get(node.id) ?? node.sortOrder,
  }));
}

export type KnowledgeTreeSiblingDropPlacement = "before" | "after";
export type KnowledgeTreeDropPlacement = KnowledgeTreeSiblingDropPlacement | "inside";

export function resolveKnowledgeTreeDropPlacement(
  pointerY: number,
  rowTop: number,
  rowHeight: number,
): KnowledgeTreeDropPlacement {
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return "inside";
  const ratio = (pointerY - rowTop) / rowHeight;
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "inside";
}

export interface KnowledgeTreeSiblingReorderPlan {
  nodes: KnowledgeTreeNode[];
  items: Array<{ id: string; sortOrder: number }>;
}

/**
 * Plan a manual drag reorder inside one sibling group.
 *
 * Returns null when the drag crosses hierarchy levels: reparenting must go
 * through the move flow instead of being silently mixed into a reorder.
 * The returned nodes keep every parentId untouched and only reassign
 * sortOrder inside the affected sibling group.
 */
export function planKnowledgeTreeSiblingReorder(
  nodes: KnowledgeTreeNode[],
  sourceId: string,
  targetId: string,
  placement: KnowledgeTreeSiblingDropPlacement,
): KnowledgeTreeSiblingReorderPlan | null {
  if (!sourceId || sourceId === targetId) return null;
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  if (!source || !target) return null;
  if ((source.parentId ?? null) !== (target.parentId ?? null)) return null;

  const siblings = nodes
    .filter((node) => (node.parentId ?? null) === (source.parentId ?? null))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const withoutSource = siblings.filter((node) => node.id !== sourceId);
  const targetIndex = withoutSource.findIndex((node) => node.id === targetId);
  if (targetIndex < 0) return null;

  const insertIndex = placement === "before" ? targetIndex : targetIndex + 1;
  const reordered = [
    ...withoutSource.slice(0, insertIndex),
    source,
    ...withoutSource.slice(insertIndex),
  ];

  const nextSortOrder = new Map<string, number>();
  reordered.forEach((node, index) => nextSortOrder.set(node.id, index));

  const items: Array<{ id: string; sortOrder: number }> = [];
  const nextNodes = nodes.map((node) => {
    const sortOrder = nextSortOrder.get(node.id);
    if (sortOrder === undefined || sortOrder === node.sortOrder) return node;
    items.push({ id: node.id, sortOrder });
    return { ...node, sortOrder };
  });

  if (items.length === 0) return null;
  return { nodes: nextNodes, items };
}
