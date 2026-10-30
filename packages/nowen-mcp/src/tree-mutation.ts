import { createHash } from "node:crypto";

export interface TreeMutationNode {
  id: string;
  parentId: string | null;
  resourceId: string;
  resourceType: string;
  title: string;
  updatedAt: string;
  childCount: number;
  isDeleted: number;
  workspaceId?: string | null;
}

/** Stable optimistic snapshot for individual nodes and full affected subtrees. */
export function treeMutationRevision(nodes: TreeMutationNode[], nodeId: string, subtree = false): string {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(nodeId)) throw new Error("节点不存在或无权查看，请刷新目录");
  const visited = new Set<string>([nodeId]);
  if (subtree) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (node.parentId && visited.has(node.parentId) && !visited.has(node.id)) {
          visited.add(node.id);
          changed = true;
        }
      }
    }
  }
  return createHash("sha256").update(JSON.stringify(
    Array.from(visited).sort().map((id) => {
      const node = byId.get(id)!;
      return [node.id, node.parentId, node.resourceType, node.resourceId,
        node.title, node.updatedAt, node.isDeleted, node.childCount];
    }),
  )).digest("hex");
}

export function treeMutationPreconditions(node: TreeMutationNode, subtreeRevision?: string) {
  return {
    expectedUpdatedAt: node.updatedAt,
    expectedTitle: node.title,
    expectedParentId: node.parentId,
    expectedChildCount: node.childCount,
    ...(subtreeRevision ? { expectedSubtreeRevision: subtreeRevision } : {}),
  };
}
