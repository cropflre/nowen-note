import { api } from "@/lib/api";
import {
  knowledgeTreeApi,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";

export type DuplicatedKnowledgeTreeNote = Awaited<ReturnType<typeof api.duplicateNote>>;

type DuplicateChildDependencies = {
  listNodes: () => Promise<KnowledgeTreeNode[]>;
  duplicateNote: (noteId: string, options: { placement: "child" }) => Promise<DuplicatedKnowledgeTreeNote>;
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
  duplicateNote: (noteId, options) => api.duplicateNote(noteId, options),
};

export async function resolveDuplicableKnowledgeTreeNote(
  sourceNodeId: string,
  dependencies: Pick<DuplicateChildDependencies, "listNodes"> = defaultDependencies,
): Promise<KnowledgeTreeNode | null> {
  if (!sourceNodeId) return null;
  const nodes = await dependencies.listNodes();
  const source = nodes.find((node) => node.id === sourceNodeId) || null;
  if (!source || source.resourceType !== "note") return null;
  if (source.nodeType !== "note" && source.nodeType !== "markdown") return null;
  if (source.isLocked === 1) return null;
  if (!source.access.capabilities.canCreate) return null;
  return source;
}

/** 由服务端直接创建完整子目录副本，沿用目标节点的创建权限。 */
export async function duplicateKnowledgeTreeNoteAsChild(
  sourceNodeId: string,
  dependencies: DuplicateChildDependencies = defaultDependencies,
): Promise<DuplicatedKnowledgeTreeNote> {
  const source = await resolveDuplicableKnowledgeTreeNote(sourceNodeId, dependencies);
  if (!source) {
    throw new Error("当前节点不是可创建子内容的文档");
  }

  return dependencies.duplicateNote(source.resourceId, { placement: "child" });
}
