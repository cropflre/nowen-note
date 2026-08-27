import type { NoteListItem, Notebook } from "@/types";
import {
  knowledgeTreeApi,
  type EffectiveKnowledgeAccess,
  type KnowledgeTreeNode,
} from "./knowledgeTreeApi";
import { applyKnowledgeTreeSort } from "./knowledgeTreeSort";
import { newLocalId } from "./localRepository";
import { isMobileLocalMode } from "./mobileLocalMode";
import type { NativeLocalRepository } from "./nativeLocalRepository";

function ownerAccess(
  nodeId: string,
  options: { canCreate?: boolean; deviceOnly?: boolean } = {},
): EffectiveKnowledgeAccess {
  const deviceOnly = options.deviceOnly === true;
  return {
    nodeId,
    rolePreset: "admin",
    capabilities: {
      canView: true,
      canComment: true,
      canCreate: options.canCreate !== false,
      canEdit: true,
      canDelete: true,
      canMove: true,
      canDownload: true,
      canReshare: !deviceOnly,
      canManageMembers: !deviceOnly,
    },
    source: "owner",
    sourceNodeId: null,
  };
}

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

function notebookNode(item: Notebook, deviceOnly: boolean): KnowledgeTreeNode {
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
    access: ownerAccess(id, { canCreate: true, deviceOnly }),
  };
}

function noteNode(item: NoteListItem, deviceOnly: boolean): KnowledgeTreeNode {
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
    // 纯设备本地模式只能持久化 notebook.parentId + note.notebookId，
    // 不能可靠表达“笔记作为父节点”。登录模式保留服务端原能力。
    access: ownerAccess(id, { canCreate: !deviceOnly, deviceOnly }),
  };
}

function projectNodes(
  notebooks: Notebook[],
  notes: NoteListItem[],
  deviceOnly: boolean,
): KnowledgeTreeNode[] {
  const nodes = [
    ...notebooks.map((item) => notebookNode(item, deviceOnly)),
    ...notes.map((item) => noteNode(item, deviceOnly)),
  ];
  const childCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) || 0) + 1);
  }
  return applyKnowledgeTreeSort(nodes.map((node) => ({
    ...node,
    childCount: childCounts.get(node.id) || 0,
  })));
}

function localOnlyUnsupported(message: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = "MOBILE_LOCAL_UNSUPPORTED";
  return error;
}

/**
 * Android Native 知识树 Bridge。
 *
 * - 所有 Native 模式：列表从 Native Repository 投影，保证断网可读。
 * - 纯设备本地模式：进一步接管 CRUD / batch / ACL 等入口，确保不会漏回服务器。
 * - 已登录 Local-first：保留服务端 mutation / 权限 / 密码等高级知识树能力，避免
 *   因 Native DB 暂无 knowledge_tree_nodes 表而破坏原有任意层级结构与权限语义。
 */
export function installMobileLocalKnowledgeTreeBridge(
  repository: NativeLocalRepository,
  options: { deviceOnly?: boolean } = {},
): () => void {
  const target = knowledgeTreeApi as any;
  const originals = { ...target };
  const deviceOnly = options.deviceOnly ?? isMobileLocalMode();

  const list = async (workspaceId?: string, includeDeleted = false) => {
    const [notebooks, notes] = await Promise.all([
      repository.listNotebooksForWorkspace(workspaceId),
      repository.listNotesForWorkspace(workspaceId, {
        includeTrashed: includeDeleted,
        includeArchived: includeDeleted,
        limit: 10_000,
      }),
    ]);
    return { nodes: projectNodes(notebooks, notes, deviceOnly) };
  };

  target.list = (includeDeleted = false) => list(undefined, includeDeleted);
  target.listForWorkspace = (workspaceId: string, includeDeleted = false) => list(workspaceId, includeDeleted);
  target.listShared = async () => ({ nodes: [] });

  // 登录后的 Android 维持此前行为：只投影本地列表，其余高级树能力继续访问服务器。
  if (!deviceOnly) {
    return () => {
      Object.assign(target, originals);
    };
  }

  const findNode = async (nodeId: string, workspaceId?: string): Promise<KnowledgeTreeNode> => {
    const result = await list(workspaceId, true);
    const node = result.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error("内容节点不存在");
    return node;
  };

  const requireFolderParent = async (
    parentId: string | null,
    workspaceId?: string,
  ): Promise<KnowledgeTreeNode | null> => {
    if (!parentId) return null;
    const parent = await findNode(parentId, workspaceId);
    if (parent.resourceType !== "notebook") {
      throw localOnlyUnsupported("Android 本地模式暂不支持把内容放到笔记节点下，请选择文件夹");
    }
    return parent;
  };

  const create = async (
    workspaceId: string | undefined,
    input: { parentId: string | null; nodeType: "folder" | "note" | "markdown" | "word"; title: string },
  ): Promise<KnowledgeTreeNode> => {
    const parent = await requireFolderParent(input.parentId, workspaceId);
    const effectiveWorkspaceId = parent?.workspaceId
      ?? (workspaceId && workspaceId !== "personal" ? workspaceId : null);
    const title = input.title.trim() || (input.nodeType === "folder" ? "新建文件夹" : "无标题笔记");
    const id = newLocalId();

    if (input.nodeType === "folder") {
      await repository.notebooks.create({
        id,
        workspaceId: effectiveWorkspaceId,
        parentId: parent?.resourceId ?? null,
        name: title,
        icon: "📁",
      });
      return findNode(`notebook:${id}`, workspaceId);
    }

    if (!parent) throw localOnlyUnsupported("根级文档需要先创建文件夹");
    const contentFormat = input.nodeType === "markdown" ? "markdown" : "tiptap-json";
    await repository.notes.create({
      id,
      workspaceId: effectiveWorkspaceId,
      notebookId: parent.resourceId,
      title,
      contentFormat,
      content: contentFormat === "markdown" ? `# ${title}\n\n` : "{}",
      contentText: "",
    });
    return findNode(`note:${id}`, workspaceId);
  };

  const move = async (
    nodeId: string,
    input: { parentId: string | null; sortOrder?: number },
  ): Promise<KnowledgeTreeNode> => {
    const node = await findNode(nodeId);
    const parent = await requireFolderParent(input.parentId);
    if (parent && parent.workspaceId !== node.workspaceId) {
      throw localOnlyUnsupported("Android 本地模式不支持跨空间移动内容");
    }

    if (node.resourceType === "note") {
      if (!parent) throw localOnlyUnsupported("文档必须位于文件夹中");
      await repository.notes.update(node.resourceId, {
        notebookId: parent.resourceId,
        ...(typeof input.sortOrder === "number" ? { sortOrder: input.sortOrder } : {}),
      });
    } else if (node.resourceType === "notebook") {
      if (parent?.resourceId === node.resourceId) throw new Error("不能移动到自身");
      await repository.notebooks.update(node.resourceId, {
        parentId: parent?.resourceId ?? null,
        ...(typeof input.sortOrder === "number" ? { sortOrder: input.sortOrder } : {}),
      });
    } else {
      throw localOnlyUnsupported("当前节点类型暂不支持本地移动");
    }
    return findNode(nodeId);
  };

  const descendantsOf = (nodeId: string, nodes: KnowledgeTreeNode[]): KnowledgeTreeNode[] => {
    const result: KnowledgeTreeNode[] = [];
    const queue = [nodeId];
    while (queue.length) {
      const parentId = queue.shift()!;
      const children = nodes.filter((node) => node.parentId === parentId);
      for (const child of children) {
        result.push(child);
        queue.push(child.id);
      }
    }
    return result;
  };

  const remove = async (nodeId: string, mode: "subtree" | "promote" = "subtree") => {
    const { nodes } = await list(undefined, true);
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error("内容节点不存在");

    const affected: string[] = [];
    const promoted: string[] = [];
    if (mode === "promote" && node.resourceType === "notebook") {
      const children = nodes.filter((candidate) => candidate.parentId === node.id && candidate.isDeleted !== 1);
      for (const child of children) {
        if (child.resourceType === "note" && node.parentId === null) {
          throw localOnlyUnsupported("根级文件夹包含文档时不能提升删除，请使用“删除子树”");
        }
        await move(child.id, { parentId: node.parentId });
        promoted.push(child.id);
      }
      await repository.notebooks.remove(node.resourceId);
      affected.push(node.id);
      return { success: true as const, affectedNodeIds: affected, promotedNodeIds: promoted };
    }

    const subtree = [node, ...descendantsOf(nodeId, nodes)];
    const notes = subtree.filter((item) => item.resourceType === "note");
    const folders = subtree.filter((item) => item.resourceType === "notebook").reverse();
    const trashedAt = new Date().toISOString();
    for (const item of notes) {
      await repository.notes.update(item.resourceId, { isTrashed: 1, trashedAt });
      affected.push(item.id);
    }
    for (const item of folders) {
      await repository.notebooks.remove(item.resourceId);
      affected.push(item.id);
    }
    return { success: true as const, affectedNodeIds: affected, promotedNodeIds: promoted };
  };

  target.create = (input: Parameters<typeof create>[1]) => create(undefined, input);
  target.createForWorkspace = (workspaceId: string, input: Parameters<typeof create>[1]) => create(workspaceId, input);

  target.update = async (nodeId: string, input: { title?: string; isExpanded?: boolean }) => {
    const node = await findNode(nodeId);
    if (node.resourceType === "notebook") {
      await repository.notebooks.update(node.resourceId, {
        ...(input.title !== undefined ? { name: input.title.trim() || "未命名文件夹" } : {}),
        ...(input.isExpanded !== undefined ? { isExpanded: input.isExpanded ? 1 : 0 } : {}),
      });
    } else if (node.resourceType === "note" && input.title !== undefined) {
      await repository.notes.update(node.resourceId, { title: input.title.trim() || "无标题笔记" });
    }
    return findNode(nodeId);
  };

  target.move = move;
  target.batchMove = async (nodeIds: string[], input: { parentId: string | null }) => {
    const nodes: KnowledgeTreeNode[] = [];
    for (const nodeId of nodeIds) nodes.push(await move(nodeId, input));
    return { success: true, nodeIds, nodes };
  };
  target.reorder = async (items: Array<{ id: string; sortOrder: number }>) => {
    const nodes = await Promise.all(items.map(({ id }) => findNode(id)));
    const noteItems: Array<{ id: string; sortOrder: number }> = [];
    const notebookItems: Array<{ id: string; sortOrder: number }> = [];
    items.forEach((item, index) => {
      const node = nodes[index];
      if (node.resourceType === "note") noteItems.push({ id: node.resourceId, sortOrder: item.sortOrder });
      if (node.resourceType === "notebook") notebookItems.push({ id: node.resourceId, sortOrder: item.sortOrder });
    });
    if (noteItems.length) await repository.reorderNotes(noteItems);
    if (notebookItems.length) await repository.reorderNotebooks(notebookItems);
    return { success: true, updated: items.length };
  };
  target.remove = remove;
  target.batchRemove = async (nodeIds: string[]) => {
    const affectedNodeIds: string[] = [];
    for (const nodeId of nodeIds) {
      const result = await remove(nodeId, "subtree");
      affectedNodeIds.push(...result.affectedNodeIds);
    }
    return { success: true, nodeIds, affectedNodeIds: Array.from(new Set(affectedNodeIds)) };
  };
  target.restore = async (nodeId: string) => {
    const node = await findNode(nodeId);
    if (node.resourceType !== "note") {
      throw localOnlyUnsupported("Android 本地模式暂不支持恢复已删除文件夹");
    }
    await repository.notes.update(node.resourceId, { isTrashed: 0, trashedAt: null });
    return { success: true, restoredNodeIds: [nodeId] };
  };

  // 设备本地空间没有服务端成员 ACL / 密码 / 审计历史。这些调用必须在 Bridge
  // 层终止，不能继续落回 knowledgeTreeApi.request()。
  target.getPermissions = async (nodeId: string) => ({
    direct: [],
    inheritsFromParent: null,
    accessMode: "inherit",
    isExplicit: false,
    currentUserAccess: ownerAccess(nodeId, { canCreate: false, deviceOnly: true }),
  });
  target.setAccessMode = async () => { throw localOnlyUnsupported("设备本地空间不支持成员权限设置"); };
  target.setPermission = async () => { throw localOnlyUnsupported("设备本地空间不支持成员权限设置"); };
  target.clearPermission = async () => { throw localOnlyUnsupported("设备本地空间不支持成员权限设置"); };
  target.history = async () => ({ history: [] });
  target.unlockFolder = async () => ({ success: true, isPasswordProtected: false, unlockToken: "mobile-local" });
  target.setFolderPassword = async () => { throw localOnlyUnsupported("Android 本地模式暂不支持文件夹密码"); };
  target.removeFolderPassword = async () => { throw localOnlyUnsupported("Android 本地模式暂不支持文件夹密码"); };

  return () => {
    Object.assign(target, originals);
  };
}
