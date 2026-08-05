import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

export type ThreeColumnFolderScopeMode = "current" | "recursive";

export const THREE_COLUMN_FOLDER_SCOPE_STORAGE_KEY = "nowen.noteList.threeColumnFolderScope";
export const KNOWLEDGE_TREE_OPEN_FOLDER_EVENT = "nowen:knowledge-tree-open-folder";

export interface KnowledgeTreeOpenFolderDetail {
  node: KnowledgeTreeNode;
}

export interface ThreeColumnChildFolder {
  node: KnowledgeTreeNode;
  directNoteCount: number;
  totalNoteCount: number;
}

export interface ThreeColumnFolderContents {
  selectedFolder: KnowledgeTreeNode | null;
  childFolders: ThreeColumnChildFolder[];
  directNoteCount: number;
  totalNoteCount: number;
}

export function normalizeThreeColumnFolderScopeMode(value: unknown): ThreeColumnFolderScopeMode {
  return value === "recursive" ? "recursive" : "current";
}

export function loadThreeColumnFolderScopeMode(): ThreeColumnFolderScopeMode {
  try {
    return normalizeThreeColumnFolderScopeMode(
      window.localStorage.getItem(THREE_COLUMN_FOLDER_SCOPE_STORAGE_KEY),
    );
  } catch {
    return "current";
  }
}

export function saveThreeColumnFolderScopeMode(mode: ThreeColumnFolderScopeMode): void {
  try {
    window.localStorage.setItem(THREE_COLUMN_FOLDER_SCOPE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in hardened WebViews; keep the in-memory choice usable.
  }
}

export function requestKnowledgeTreeFolderOpen(node: KnowledgeTreeNode): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<KnowledgeTreeOpenFolderDetail>(
    KNOWLEDGE_TREE_OPEN_FOLDER_EVENT,
    { detail: { node } },
  ));
}

export function buildThreeColumnFolderContents(
  nodes: KnowledgeTreeNode[],
  selectedNotebookId: string | null | undefined,
): ThreeColumnFolderContents {
  const empty: ThreeColumnFolderContents = {
    selectedFolder: null,
    childFolders: [],
    directNoteCount: 0,
    totalNoteCount: 0,
  };
  if (!selectedNotebookId) return empty;

  const activeNodes = nodes.filter((node) => !node.isDeleted);
  const selectedFolder = activeNodes.find((node) => (
    node.nodeType === "folder"
    && node.resourceType === "notebook"
    && node.resourceId === selectedNotebookId
  ));
  if (!selectedFolder) return empty;

  const childrenByParent = new Map<string | null, KnowledgeTreeNode[]>();
  for (const node of activeNodes) {
    const siblings = childrenByParent.get(node.parentId) || [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => (
      (a.sortOrder || 0) - (b.sortOrder || 0)
      || a.title.localeCompare(b.title)
      || a.id.localeCompare(b.id)
    ));
  }

  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const countDescendantNotes = (folderNodeId: string): number => {
    const cached = memo.get(folderNodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(folderNodeId)) return 0;
    visiting.add(folderNodeId);
    let total = 0;
    for (const child of childrenByParent.get(folderNodeId) || []) {
      if (child.nodeType === "folder") {
        total += countDescendantNotes(child.id);
      } else if (child.resourceType === "note") {
        total += 1;
      }
    }
    visiting.delete(folderNodeId);
    memo.set(folderNodeId, total);
    return total;
  };

  const directChildren = childrenByParent.get(selectedFolder.id) || [];
  const directNoteCount = directChildren.filter((node) => (
    node.nodeType !== "folder" && node.resourceType === "note"
  )).length;
  const childFolders = directChildren
    .filter((node) => node.nodeType === "folder" && node.resourceType === "notebook")
    .map((node) => ({
      node,
      directNoteCount: (childrenByParent.get(node.id) || []).filter((child) => (
        child.nodeType !== "folder" && child.resourceType === "note"
      )).length,
      totalNoteCount: countDescendantNotes(node.id),
    }));

  return {
    selectedFolder,
    childFolders,
    directNoteCount,
    totalNoteCount: countDescendantNotes(selectedFolder.id),
  };
}
