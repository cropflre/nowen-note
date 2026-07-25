import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

export type KnowledgeTreeSection = "owned" | "shared";

/** Keeps matching nodes and every visible ancestor required to render their path. */
export function filterKnowledgeTreeNodes(nodes: KnowledgeTreeNode[], query: string): KnowledgeTreeNode[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visible = new Set(
    nodes
      .filter((node) => node.title.toLocaleLowerCase().includes(normalized))
      .map((node) => node.id),
  );
  for (const id of Array.from(visible)) {
    let parentId = byId.get(id)?.parentId;
    while (parentId) {
      visible.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }
  return nodes.filter((node) => visible.has(node.id));
}

/** Shared content may only be moved inside the same explicitly shared root. */
export function canMoveWithinSharedRoot(
  source: KnowledgeTreeNode,
  target: KnowledgeTreeNode,
): boolean {
  if (!source.sharedRootId || !target.sharedRootId) return false;
  if (source.id === source.sharedRootId) return false;
  return source.sharedRootId === target.sharedRootId;
}

export function isSharedRoot(node: KnowledgeTreeNode): boolean {
  return Boolean(node.sharedRootId && node.id === node.sharedRootId);
}
