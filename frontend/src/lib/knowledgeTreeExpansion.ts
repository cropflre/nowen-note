import { getCurrentWorkspace, getServerUrl } from "@/lib/api";
import { decodeUserIdFromToken } from "@/lib/userPreferenceAccountCache";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

const STORAGE_KEY_PREFIX = "nowen.knowledgeTree.expandedNodeIds.v1:";

export interface KnowledgeTreeExpansionSnapshot {
  initialized: boolean;
  hasUserHistory: boolean;
  expandedNodeIds: readonly string[];
}

const snapshots = new Map<string, KnowledgeTreeExpansionSnapshot>();
const listeners = new Map<string, Set<() => void>>();
let storageListenerInstalled = false;

function serverIdentity(): string {
  const raw = getServerUrl() || (typeof window !== "undefined" ? window.location.origin : "local");
  try {
    const url = new URL(raw);
    if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return "local";
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase() || "local";
  }
}

function storageKey(scope: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(scope)}`;
}

function normalizeIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0)));
}

export type KnowledgeTreeVisibleDepth = 1 | 2 | 3 | "all";

export function normalizeKnowledgeTreeVisibleDepth(value: unknown): KnowledgeTreeVisibleDepth {
  if (value === "all" || value === 1 || value === 2 || value === 3) return value;
  if (value === "1") return 1;
  if (value === "2") return 2;
  if (value === "3") return 3;
  return "all";
}

/**
 * Returns folder ids that must be expanded so the tree is visible down to the requested level.
 * Root nodes are level 1. Therefore depth=1 means fully collapsed roots, depth=2 expands only
 * root folders, and "all" expands every folder that has at least one visible child.
 */
export function buildKnowledgeTreeExpandedIdsForDepth(
  nodes: readonly Pick<KnowledgeTreeNode, "id" | "parentId" | "nodeType" | "isDeleted">[],
  visibleDepth: KnowledgeTreeVisibleDepth,
): string[] {
  const active = nodes.filter((node) => node.isDeleted !== 1);
  const byId = new Map(active.map((node) => [node.id, node]));
  const children = new Map<string | null, typeof active>();
  for (const node of active) {
    const parentId = node.parentId && byId.has(node.parentId) ? node.parentId : null;
    const siblings = children.get(parentId) || [];
    siblings.push(node);
    children.set(parentId, siblings);
  }

  if (visibleDepth === 1) return [];

  const maxFolderLevel = visibleDepth === "all" ? Number.POSITIVE_INFINITY : visibleDepth - 1;
  const expanded: string[] = [];
  const visited = new Set<string>();
  const stack = (children.get(null) || []).map((node) => ({ node, level: 1 }));

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.node.id)) continue;
    visited.add(current.node.id);

    const childNodes = children.get(current.node.id) || [];
    if (
      current.node.nodeType === "folder"
      && childNodes.length > 0
      && current.level <= maxFolderLevel
    ) {
      expanded.push(current.node.id);
    }
    for (const child of childNodes) {
      stack.push({ node: child, level: current.level + 1 });
    }
  }

  return expanded;
}

function readStoredSnapshot(scope: string): KnowledgeTreeExpansionSnapshot {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    if (raw === null) return { initialized: false, hasUserHistory: false, expandedNodeIds: [] };
    const ids = normalizeIds(JSON.parse(raw));
    if (ids) return { initialized: true, hasUserHistory: true, expandedNodeIds: ids };
  } catch {
    // Invalid or unavailable storage falls back to the server-provided defaults.
  }
  return { initialized: false, hasUserHistory: false, expandedNodeIds: [] };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function publish(scope: string, snapshot: KnowledgeTreeExpansionSnapshot): void {
  const current = snapshots.get(scope);
  if (
    current
    && current.initialized === snapshot.initialized
    && current.hasUserHistory === snapshot.hasUserHistory
    && sameIds(current.expandedNodeIds, snapshot.expandedNodeIds)
  ) return;
  snapshots.set(scope, snapshot);
  listeners.get(scope)?.forEach((listener) => listener());
}

function installStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") return;
  storageListenerInstalled = true;
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(STORAGE_KEY_PREFIX)) return;
    for (const scope of snapshots.keys()) {
      if (storageKey(scope) === event.key) publish(scope, readStoredSnapshot(scope));
    }
  });
}

export function getKnowledgeTreeExpansionScope(workspaceId = getCurrentWorkspace()): string {
  let userId = "anonymous";
  try {
    userId = decodeUserIdFromToken(localStorage.getItem("nowen-token"))
      || localStorage.getItem("nowen-self-userid")
      || userId;
  } catch {
    // Keep a stable fallback scope when storage is unavailable.
  }
  return JSON.stringify([serverIdentity(), userId, workspaceId || "personal"]);
}

export function getKnowledgeTreeExpansionSnapshot(scope: string): KnowledgeTreeExpansionSnapshot {
  installStorageListener();
  const cached = snapshots.get(scope);
  if (cached) return cached;
  const snapshot = readStoredSnapshot(scope);
  snapshots.set(scope, snapshot);
  return snapshot;
}

export function subscribeKnowledgeTreeExpansion(scope: string, listener: () => void): () => void {
  installStorageListener();
  const scopedListeners = listeners.get(scope) || new Set<() => void>();
  scopedListeners.add(listener);
  listeners.set(scope, scopedListeners);
  return () => {
    scopedListeners.delete(listener);
    if (scopedListeners.size === 0) listeners.delete(scope);
  };
}

export function initializeKnowledgeTreeExpansion(
  scope: string,
  defaultExpandedNodeIds: Iterable<string>,
  validNodeIds: ReadonlySet<string>,
  canPruneMissingIds: boolean,
): void {
  const current = getKnowledgeTreeExpansionSnapshot(scope);
  if (current.hasUserHistory) {
    if (!canPruneMissingIds) return;
    const validExpandedIds = current.expandedNodeIds.filter((id) => validNodeIds.has(id));
    if (!sameIds(current.expandedNodeIds, validExpandedIds)) {
      saveKnowledgeTreeExpansion(scope, validExpandedIds);
    }
    return;
  }
  publish(scope, {
    initialized: true,
    hasUserHistory: false,
    expandedNodeIds: Array.from(new Set(defaultExpandedNodeIds)),
  });
}

export function saveKnowledgeTreeExpansion(scope: string, expandedNodeIds: Iterable<string>): void {
  const ids = Array.from(new Set(expandedNodeIds));
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify(ids));
  } catch {
    // The in-memory external store still keeps the current window usable.
  }
  publish(scope, { initialized: true, hasUserHistory: true, expandedNodeIds: ids });
}
