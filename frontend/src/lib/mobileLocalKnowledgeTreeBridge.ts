import type { MindMapListItem, NoteListItem, Notebook } from "@/types";
import { api, getCurrentWorkspace } from "./api";
import {
  knowledgeTreeApi,
  type EffectiveKnowledgeAccess,
  type KnowledgeTreeNode,
  type KnowledgeTreeResponse,
} from "./knowledgeTreeApi";
import { applyKnowledgeTreeSort } from "./knowledgeTreeSort";
import { newLocalId } from "./localRepository";
import { isMobileLocalMode } from "./mobileLocalMode";
import { ensureMobileLocalMindMapTree } from "./mobileLocalMindMapTree";
import type { NativeDatabase } from "./nativeDatabase";
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

function syncScopeKey(workspaceId?: string): string {
  return workspaceId && workspaceId !== "personal"
    ? `workspace:${workspaceId.replace(/^workspace:/, "")}` : "personal";
}

function snapshotKey(workspaceId: string | undefined, includeDeleted: boolean): string {
  return `knowledgeTreeSnapshot:v1:${syncScopeKey(workspaceId)}:${includeDeleted ? 1 : 0}`;
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

type LocalMindMapRow = MindMapListItem & {
  treeParentId: string | null;
  treeSortOrder: number;
  treeIsDeleted: number;
};

function mindMapNode(item: LocalMindMapRow, notebookIds: Set<string>, deviceOnly: boolean): KnowledgeTreeNode {
  const id = `mindmap:${item.id}`;
  return {
    id,
    userId: item.userId,
    workspaceId: item.workspaceId,
    scopeKey: scopeKey(item.userId, item.workspaceId),
    parentId: item.treeParentId && notebookIds.has(item.treeParentId) ? item.treeParentId : null,
    nodeType: "mindmap",
    resourceType: "mindmap",
    resourceId: item.id,
    title: item.title,
    isFavorite: item.starred ? 1 : 0,
    sortOrder: item.treeSortOrder,
    isExpanded: 0,
    isDeleted: item.treeIsDeleted,
    childCount: 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    access: ownerAccess(id, { canCreate: false, deviceOnly }),
  };
}

function projectNodes(
  notebooks: Notebook[],
  notes: NoteListItem[],
  mindMaps: LocalMindMapRow[],
  deviceOnly: boolean,
): KnowledgeTreeNode[] {
  const notebookIds = new Set(notebooks.map((item) => `notebook:${item.id}`));
  const nodes = [
    ...notebooks.map((item) => notebookNode(item, deviceOnly)),
    ...notes.map((item) => noteNode(item, deviceOnly)),
    ...mindMaps.map((item) => mindMapNode(item, notebookIds, deviceOnly)),
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
 * - 纯设备本地模式：列表从 Native Repository 投影，并接管 CRUD / batch / ACL。
 * - 已登录 Local-first：在线读取服务端统一树，断网回退服务端快照；mutation / 权限 /
 *   密码等高级能力仍由服务端处理，直到 Native DB 支持完整结构同步。
 */
export function installMobileLocalKnowledgeTreeBridge(
  repository: NativeLocalRepository,
  options: { deviceOnly?: boolean } = {},
  db?: NativeDatabase,
): () => void {
  const target = knowledgeTreeApi;
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
    let mindMaps: LocalMindMapRow[] = [];
    if (deviceOnly && db && (!workspaceId || workspaceId === "personal")) {
      await ensureMobileLocalMindMapTree(db);
      mindMaps = await db.query<LocalMindMapRow>(`
        SELECT m.id,m.userId,m.workspaceId,m.title,m.starred,m.folderId,m.createdAt,m.updatedAt,
          t.parentId AS treeParentId,COALESCE(t.sortOrder,0) AS treeSortOrder,
          COALESCE(t.isDeleted,0) AS treeIsDeleted
        FROM mindmaps m LEFT JOIN mobile_local_mindmap_tree t ON t.mindmapId=m.id
        WHERE m.scopeKey='personal' ${includeDeleted ? "" : "AND COALESCE(t.isDeleted,0)=0"}
      `);
    }
    return { nodes: projectNodes(notebooks, notes, mindMaps, deviceOnly) };
  };

  // 登录态以服务端统一树为准；断网时只使用保留密码信息的服务端快照。
  // 权限或服务端错误不能当作断网，否则可能显示已撤权的工作区内容。
  if (!deviceOnly) {
    const serverFirstList = async (
      workspaceId: string | undefined,
      includeDeleted: boolean,
      remote: () => Promise<KnowledgeTreeResponse>,
    ): Promise<KnowledgeTreeResponse> => {
      const key = snapshotKey(workspaceId, includeDeleted);
      const scope = syncScopeKey(workspaceId);
      const validNodes = (nodes: unknown): nodes is KnowledgeTreeNode[] => Array.isArray(nodes)
        && nodes.every((node) => node && typeof node.id === "string"
          && (scope === "personal" ? node.workspaceId == null : syncScopeKey(node.workspaceId || undefined) === scope));
      try {
        const result = await remote();
        if (!validNodes(result.nodes)) throw new Error("服务器知识树数据空间不匹配");
        if (db) {
          try {
            // 在线解锁确认不能进入离线快照；离线仍需逐篇服务端授权。
            await db.run(`INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`,
            [key, JSON.stringify(result.nodes), new Date().toISOString()]);
          } catch (error) {
            console.warn("[mobile knowledge tree] snapshot cache write failed", error);
          }
        }
        return result;
      } catch (error) {
        if (db && error && typeof error === "object" && "status" in error && error.status === 403) {
          if (scope !== "personal") {
            try {
              await db.run("UPDATE sync_workspace_scopes SET accessStatus='access_revoked' WHERE scopeKey=?", [scope]);
            } catch (accessError) {
              console.warn("[mobile knowledge tree] offline access freeze failed", accessError);
            }
          }
        }
        if (!(error instanceof TypeError) || !/failed to fetch|network request failed|load failed/i.test(error.message)) throw error;
        if (db) {
          if (scope !== "personal") {
            const access = (await db.query<{ accessStatus: string }>(
              "SELECT accessStatus FROM sync_workspace_scopes WHERE scopeKey=? LIMIT 1", [scope],
            ))[0];
            if (access?.accessStatus !== "active") throw new Error("当前工作区的离线访问权未确认");
          }
          const cached = (await db.query<{ value: string }>(
            "SELECT value FROM native_runtime_meta WHERE key=?", [key],
          ))[0];
          if (cached) {
            try {
              const nodes = JSON.parse(cached.value) as unknown;
              if (validNodes(nodes)) return { nodes };
            } catch { /* 损坏的快照不能证明目录没有密码。 */ }
          }
        }
        // Native 投影不含文件夹密码，缺失/损坏的服务端快照不能降级成无保护目录。
        throw new Error("目录权限和密码信息尚未缓存，请联网后重试");
      }
    };
    target.list = (includeDeleted = false) => serverFirstList(
      getCurrentWorkspace(), includeDeleted,
      () => originals.list(includeDeleted),
    );
    target.listForWorkspace = (workspaceId: string, includeDeleted = false) => serverFirstList(
      workspaceId, includeDeleted,
      () => originals.listForWorkspace(workspaceId, includeDeleted),
    );
    return () => { Object.assign(target, originals); };
  }

  target.list = (includeDeleted = false) => list(undefined, includeDeleted);
  target.listForWorkspace = (workspaceId: string, includeDeleted = false) => list(workspaceId, includeDeleted);
  target.listShared = async () => ({ nodes: [] });

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
    input: { parentId: string | null; nodeType: "folder" | "note" | "markdown" | "word" | "mindmap"; title: string },
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

    if (input.nodeType === "mindmap") {
      if (!db) throw localOnlyUnsupported("设备本地脑图目录尚未就绪");
      if (effectiveWorkspaceId) throw localOnlyUnsupported("设备本地脑图暂不支持工作区");
      await ensureMobileLocalMindMapTree(db);
      const map = await api.createMindMap({ title: input.title.trim() || "无标题导图" });
      await db.run("INSERT INTO mobile_local_mindmap_tree (mindmapId,parentId) VALUES (?,?)", [map.id, parent?.id ?? null]);
      return findNode(`mindmap:${map.id}`, workspaceId);
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
    } else if (node.resourceType === "mindmap" && db) {
      await ensureMobileLocalMindMapTree(db);
      await db.run(`INSERT INTO mobile_local_mindmap_tree (mindmapId,parentId,sortOrder) VALUES (?,?,?)
        ON CONFLICT(mindmapId) DO UPDATE SET parentId=excluded.parentId,sortOrder=excluded.sortOrder`,
        [node.resourceId, parent?.id ?? null, input.sortOrder ?? node.sortOrder]);
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
    const mindMaps = subtree.filter((item) => item.resourceType === "mindmap");
    const folders = subtree.filter((item) => item.resourceType === "notebook").reverse();
    const trashedAt = new Date().toISOString();
    for (const item of notes) {
      await repository.notes.update(item.resourceId, { isTrashed: 1, trashedAt });
      affected.push(item.id);
    }
    if (mindMaps.length) {
      if (!db) throw localOnlyUnsupported("设备本地脑图回收站尚未就绪");
      await ensureMobileLocalMindMapTree(db);
      for (const item of mindMaps) {
        await db.run(`INSERT INTO mobile_local_mindmap_tree (mindmapId,isDeleted) VALUES (?,1)
          ON CONFLICT(mindmapId) DO UPDATE SET isDeleted=1`, [item.resourceId]);
        affected.push(item.id);
      }
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
    } else if (node.resourceType === "mindmap" && input.title !== undefined) {
      await api.updateMindMap(node.resourceId, { title: input.title.trim() || "无标题导图" });
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
    const mindMapItems: Array<{ id: string; sortOrder: number }> = [];
    items.forEach((item, index) => {
      const node = nodes[index];
      if (node.resourceType === "note") noteItems.push({ id: node.resourceId, sortOrder: item.sortOrder });
      if (node.resourceType === "notebook") notebookItems.push({ id: node.resourceId, sortOrder: item.sortOrder });
      if (node.resourceType === "mindmap") mindMapItems.push({ id: node.resourceId, sortOrder: item.sortOrder });
    });
    if (noteItems.length) await repository.reorderNotes(noteItems);
    if (notebookItems.length) await repository.reorderNotebooks(notebookItems);
    if (mindMapItems.length) {
      if (!db) throw localOnlyUnsupported("设备本地脑图排序尚未就绪");
      await ensureMobileLocalMindMapTree(db);
      for (const item of mindMapItems) {
        await db.run(`INSERT INTO mobile_local_mindmap_tree (mindmapId,sortOrder) VALUES (?,?)
          ON CONFLICT(mindmapId) DO UPDATE SET sortOrder=excluded.sortOrder`, [item.id, item.sortOrder]);
      }
    }
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
    if (node.resourceType === "mindmap") {
      if (!db) throw localOnlyUnsupported("设备本地脑图回收站尚未就绪");
      await ensureMobileLocalMindMapTree(db);
      await db.run("UPDATE mobile_local_mindmap_tree SET isDeleted=0 WHERE mindmapId=?", [node.resourceId]);
      return { success: true, restoredNodeIds: [nodeId] };
    }
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
