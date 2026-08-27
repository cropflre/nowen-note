import type { NoteListItem, Notebook } from "@/types";
import {
  knowledgeTreeApi,
  type EffectiveKnowledgeAccess,
  type KnowledgeTreeNode,
} from "./knowledgeTreeApi";
import { applyKnowledgeTreeSort } from "./knowledgeTreeSort";
import type { NativeLocalRepository } from "./nativeLocalRepository";

function ownerAccess(nodeId: string): EffectiveKnowledgeAccess {
  return {
    nodeId,
    rolePreset: "admin",
    capabilities: {
      canView: true,
      canComment: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
      canMove: true,
      canDownload: true,
      canReshare: true,
      canManageMembers: true,
    },
    source: "owner",
    sourceNodeId: null,
  };
}
function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

function notebookNode(item: Notebook): KnowledgeTreeNode {
  const id = `notebook:${item.id}`;
  return {
    id,
    userId: item.userId,
    workspaceId: item.workspaceId,
    scopeKey: scopeKey(item.userId, item.workspaceId),
    parentId: item.parentId ? `notebook:${item.parentId}` : null,
    nodeType: "folder",
    resourceType: "notebook",
    resourceId: item.id,
    title: item.name,
    icon: item.icon,
    sortOrder: item.sortOrder,
    isExpanded: item.isExpanded,
    isDeleted: 0,
    childCount: 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    access: ownerAccess(id),
  };
}

function noteNode(item: NoteListItem): KnowledgeTreeNode {
  const id = `note:${item.id}`;
  return {
    id,
    userId: item.userId,
    workspaceId: item.workspaceId,
    scopeKey: scopeKey(item.userId, item.workspaceId),
    parentId: `notebook:${item.notebookId}`,
    nodeType: item.contentFormat === "markdown" ? "markdown" : "note",
    resourceType: "note",
    resourceId: item.id,
    title: item.title,
    isPinned: item.isPinned,
    isFavorite: item.isFavorite,
    isLocked: item.isLocked,
    contentFormat: item.contentFormat || "tiptap-json",
    sortOrder: item.sortOrder || 0,
    isExpanded: 0,
    isDeleted: item.isTrashed,
    childCount: 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    access: ownerAccess(id),
  };
}

function projectNodes(notebooks: Notebook[], notes: NoteListItem[]): KnowledgeTreeNode[] {
  const nodes = [...notebooks.map(notebookNode), ...notes.map(noteNode)];
  const childCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) || 0) + 1);
  }
  return applyKnowledgeTreeSort(nodes.map((node) => ({
    ...node,
    childCount: childCounts.get(node.id) || 0,
  })));
}

/** 把安卓本地仓库投影到统一知识树，避免离线模式继续请求服务端接口。 */
export function installMobileLocalKnowledgeTreeBridge(repository: NativeLocalRepository): () => void {
  const target = knowledgeTreeApi as any;
  const originals = {
    list: target.list,
    listForWorkspace: target.listForWorkspace,
    listShared: target.listShared,
  };

  const list = async (workspaceId?: string, includeDeleted = false) => {
    const [notebooks, notes] = await Promise.all([
      repository.listNotebooksForWorkspace(workspaceId),
      repository.listNotesForWorkspace(workspaceId, {
        includeTrashed: includeDeleted,
        includeArchived: includeDeleted,
        limit: 10_000,
      }),
    ]);
    return { nodes: projectNodes(notebooks, notes) };
  };

  target.list = (includeDeleted = false) => list(undefined, includeDeleted);
  target.listForWorkspace = (workspaceId: string, includeDeleted = false) => list(workspaceId, includeDeleted);
  target.listShared = async () => ({ nodes: [] });

  return () => {
    Object.assign(target, originals);
  };
}
