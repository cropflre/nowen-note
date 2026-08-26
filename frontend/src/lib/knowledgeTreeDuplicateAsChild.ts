import { api } from "@/lib/api";
import {
  knowledgeTreeApi,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";

export type DuplicatedKnowledgeTreeNote = Awaited<ReturnType<typeof api.duplicateNote>>;

type DuplicateChildDependencies = {
  listNodes: () => Promise<KnowledgeTreeNode[]>;
  duplicateNote: (noteId: string) => Promise<DuplicatedKnowledgeTreeNote>;
  moveNode: (nodeId: string, parentId: string) => Promise<unknown>;
  rollbackNode: (nodeId: string) => Promise<unknown>;
};

async function listVisibleKnowledgeTreeNodes(): Promise<KnowledgeTreeNode[]> {
  const owned = await knowledgeTreeApi.list().then((result) => result.nodes);
  try {
    const shared = await knowledgeTreeApi.listShared().then((result) => result.nodes);
    const merged = new Map<string, KnowledgeTreeNode>();
    for (const node of [...owned, ...shared]) merged.set(node.id, node);
    return Array.from(merged.values());
  } catch {
    // 私有空间 / 离线本地后端可能不提供 shared-with-me；不影响自有节点复制。
    return owned;
  }
}

const defaultDependencies: DuplicateChildDependencies = {
  listNodes: listVisibleKnowledgeTreeNodes,
  duplicateNote: (noteId) => api.duplicateNote(noteId),
  moveNode: (nodeId, parentId) => knowledgeTreeApi.move(nodeId, { parentId }),
  rollbackNode: (nodeId) => knowledgeTreeApi.remove(nodeId, "subtree"),
};

export async function resolveDuplicableKnowledgeTreeNote(
  sourceNodeId: string,
  dependencies: Pick<DuplicateChildDependencies, "listNodes"> = defaultDependencies,
): Promise<KnowledgeTreeNode | null> {
  if (!sourceNodeId) return null;
  const nodes = await dependencies.listNodes();
  const source = nodes.find((node) => node.id === sourceNodeId) || null;
  if (!source || source.resourceType !== "note") return null;
  if (!source.access.capabilities.canCreate) return null;
  return source;
}

/**
 * 复用现有完整 duplicateNote 链路创建副本，再把新副本移入源文档节点。
 *
 * 这是知识树 `+ -> 创建副本` 的最小兼容实现：
 * - `... -> 创建副本` 仍调用原 API，因此继续创建同级副本；
 * - `+` 入口只改变新副本的树层级，不重新实现正文/标签/附件复制；
 * - 移动失败时 best-effort 回滚刚创建的副本，正常错误路径不留下可见半成品。
 */
export async function duplicateKnowledgeTreeNoteAsChild(
  sourceNodeId: string,
  dependencies: DuplicateChildDependencies = defaultDependencies,
): Promise<DuplicatedKnowledgeTreeNote> {
  const source = await resolveDuplicableKnowledgeTreeNote(sourceNodeId, dependencies);
  if (!source) {
    throw new Error("当前节点不是可创建子内容的文档");
  }

  const duplicated = await dependencies.duplicateNote(source.resourceId);
  try {
    await dependencies.moveNode(duplicated.treeNodeId, source.id);
  } catch (error) {
    try {
      await dependencies.rollbackNode(duplicated.treeNodeId);
    } catch {
      // 回滚失败不覆盖原始移动错误；回收站/孤儿清理由既有维护链处理。
    }
    throw error;
  }

  return {
    ...duplicated,
    treeParentId: source.id,
  };
}
