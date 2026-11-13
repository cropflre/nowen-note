import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

export type KnowledgeTreeSection = "owned" | "shared";

/** Keeps matching branches and every visible ancestor required to render their path. */
export function filterKnowledgeTreeNodes(nodes: KnowledgeTreeNode[], query: string): KnowledgeTreeNode[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId) || [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const matches = nodes
    .filter((node) => node.title.toLocaleLowerCase().includes(normalized))
    .map((node) => node.id);
  const visible = new Set(matches);
  const descendants = [...matches];
  for (let index = 0; index < descendants.length; index += 1) {
    for (const childId of children.get(descendants[index]) || []) {
      if (visible.has(childId)) continue;
      visible.add(childId);
      descendants.push(childId);
    }
  }
  const ancestors = new Set<string>();
  for (const id of matches) {
    let parentId = byId.get(id)?.parentId;
    while (parentId && !ancestors.has(parentId)) {
      ancestors.add(parentId);
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
