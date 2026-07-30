import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { compareKnowledgeTreePinnedPriority } from "@/lib/knowledgeTreeSort";

export type MobileKnowledgeTreeSortMode =
  | "updated-desc"
  | "title-asc"
  | "title-desc"
  | "created-desc"
  | "manual";

export interface MobileKnowledgeTreeRecentEntry {
  nodeId: string;
  openedAt: number;
}

export const MOBILE_KNOWLEDGE_TREE_SORT_STORAGE_KEY = "nowen.mobileKnowledgeTree.sort.v1";
export const MOBILE_KNOWLEDGE_TREE_RECENT_STORAGE_KEY = "nowen.mobileKnowledgeTree.recent.v1";
export const MOBILE_KNOWLEDGE_TREE_RECENT_LIMIT = 40;

const VALID_SORT_MODES = new Set<MobileKnowledgeTreeSortMode>([
  "updated-desc",
  "title-asc",
  "title-desc",
  "created-desc",
  "manual",
]);

function timestamp(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareTitle(a: KnowledgeTreeNode, b: KnowledgeTreeNode): number {
  return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
}

export function compareMobileKnowledgeTreeNodes(
  a: KnowledgeTreeNode,
  b: KnowledgeTreeNode,
  mode: MobileKnowledgeTreeSortMode,
): number {
  const pinnedPriority = compareKnowledgeTreePinnedPriority(a, b);
  if (pinnedPriority !== 0) return pinnedPriority;

  let result = 0;
  switch (mode) {
    case "title-asc":
      result = compareTitle(a, b);
      break;
    case "title-desc":
      result = compareTitle(b, a);
      break;
    case "created-desc":
      result = timestamp(b.createdAt) - timestamp(a.createdAt);
      break;
    case "manual":
      result = a.sortOrder - b.sortOrder;
      break;
    case "updated-desc":
    default:
      result = timestamp(b.updatedAt) - timestamp(a.updatedAt);
      break;
  }

  return result || a.sortOrder - b.sortOrder || compareTitle(a, b) || a.id.localeCompare(b.id);
}

export function sortMobileKnowledgeTreeNodes(
  nodes: KnowledgeTreeNode[],
  mode: MobileKnowledgeTreeSortMode = "updated-desc",
): KnowledgeTreeNode[] {
  return nodes.slice().sort((a, b) => compareMobileKnowledgeTreeNodes(a, b, mode));
}

export function getMobileKnowledgeTreeChildren(
  nodes: KnowledgeTreeNode[],
  parentId: string | null,
  mode: MobileKnowledgeTreeSortMode = "updated-desc",
): KnowledgeTreeNode[] {
  return sortMobileKnowledgeTreeNodes(
    nodes.filter((node) => (node.parentId ?? null) === parentId && node.isDeleted !== 1),
    mode,
  );
}

export function getMobileKnowledgeTreeAncestors(
  node: KnowledgeTreeNode | null | undefined,
  nodes: KnowledgeTreeNode[],
): KnowledgeTreeNode[] {
  if (!node) return [];
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const ancestors: KnowledgeTreeNode[] = [];
  const visited = new Set<string>();
  let parentId = node.parentId;

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.push(parent);
    parentId = parent.parentId;
  }

  return ancestors.reverse();
}

export function buildMobileKnowledgeTreePath(
  node: KnowledgeTreeNode,
  nodes: KnowledgeTreeNode[],
): string {
  const ancestors = getMobileKnowledgeTreeAncestors(node, nodes);
  if (ancestors.length > 0) return ancestors.map((ancestor) => ancestor.title).join(" / ");
  return node.sharedRootId ? "共享给我" : "当前空间";
}

export function filterMobileKnowledgeTreeNodes(
  nodes: KnowledgeTreeNode[],
  query: string,
  mode: MobileKnowledgeTreeSortMode = "updated-desc",
): KnowledgeTreeNode[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return sortMobileKnowledgeTreeNodes(
    nodes.filter((node) => node.isDeleted !== 1 && node.title.toLocaleLowerCase().includes(normalized)),
    mode,
  );
}

export function upsertMobileKnowledgeTreeRecentEntry(
  entries: MobileKnowledgeTreeRecentEntry[],
  nodeId: string,
  openedAt = Date.now(),
  limit = 100,
): MobileKnowledgeTreeRecentEntry[] {
  const normalizedId = nodeId.trim();
  if (!normalizedId) return entries;
  return [
    { nodeId: normalizedId, openedAt },
    ...entries.filter((entry) => entry.nodeId !== normalizedId),
  ]
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, limit);
}

export function buildMobileKnowledgeTreeRecentNodes(
  nodes: KnowledgeTreeNode[],
  entries: MobileKnowledgeTreeRecentEntry[],
  limit = MOBILE_KNOWLEDGE_TREE_RECENT_LIMIT,
): KnowledgeTreeNode[] {
  const openedAtByNode = new Map(entries.map((entry) => [entry.nodeId, entry.openedAt]));
  const documents = nodes.filter((node) => node.resourceType === "note" && node.isDeleted !== 1);
  const compareRecentDocuments = (a: KnowledgeTreeNode, b: KnowledgeTreeNode) => {
    const aOpenedAt = openedAtByNode.get(a.id);
    const bOpenedAt = openedAtByNode.get(b.id);
    if (aOpenedAt !== undefined && bOpenedAt === undefined) return -1;
    if (aOpenedAt === undefined && bOpenedAt !== undefined) return 1;
    return (bOpenedAt || 0) - (aOpenedAt || 0)
      || timestamp(b.updatedAt) - timestamp(a.updatedAt)
      || compareTitle(a, b)
      || a.id.localeCompare(b.id);
  };
  const pinnedDocuments = documents
    .filter((node) => node.isPinned === 1)
    .sort(compareRecentDocuments);
  const openedDocuments = documents
    .filter((node) => node.isPinned !== 1 && openedAtByNode.has(node.id))
    .sort((a, b) => (
      (openedAtByNode.get(b.id) || 0) - (openedAtByNode.get(a.id) || 0)
      || compareTitle(a, b)
      || a.id.localeCompare(b.id)
    ));
  const fallbackDocuments = documents
    .filter((node) => node.isPinned !== 1 && !openedAtByNode.has(node.id))
    .sort((a, b) => (
      timestamp(b.updatedAt) - timestamp(a.updatedAt)
      || compareTitle(a, b)
      || a.id.localeCompare(b.id)
    ));

  return [...pinnedDocuments, ...openedDocuments, ...fallbackDocuments].slice(0, limit);
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadMobileKnowledgeTreeSortMode(): MobileKnowledgeTreeSortMode {
  const storage = getLocalStorage();
  if (!storage) return "updated-desc";
  const value = storage.getItem(MOBILE_KNOWLEDGE_TREE_SORT_STORAGE_KEY) as MobileKnowledgeTreeSortMode | null;
  return value && VALID_SORT_MODES.has(value) ? value : "updated-desc";
}

export function saveMobileKnowledgeTreeSortMode(mode: MobileKnowledgeTreeSortMode): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(MOBILE_KNOWLEDGE_TREE_SORT_STORAGE_KEY, mode);
  } catch {
    // The current session can continue with in-memory state.
  }
}

export function loadMobileKnowledgeTreeRecentEntries(): MobileKnowledgeTreeRecentEntry[] {
  const storage = getLocalStorage();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(MOBILE_KNOWLEDGE_TREE_RECENT_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is MobileKnowledgeTreeRecentEntry => (
        Boolean(entry)
        && typeof entry.nodeId === "string"
        && typeof entry.openedAt === "number"
        && Number.isFinite(entry.openedAt)
      ))
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, 100);
  } catch {
    return [];
  }
}

export function saveMobileKnowledgeTreeRecentEntries(entries: MobileKnowledgeTreeRecentEntry[]): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(MOBILE_KNOWLEDGE_TREE_RECENT_STORAGE_KEY, JSON.stringify(entries.slice(0, 100)));
  } catch {
    // Recent items remain available for the current session.
  }
}
