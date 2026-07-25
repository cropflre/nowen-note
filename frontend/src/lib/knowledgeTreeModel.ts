import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

export interface KnowledgeTreeBranch {
  node: KnowledgeTreeNode;
  children: KnowledgeTreeBranch[];
}

export function buildKnowledgeTreeForest(nodes: KnowledgeTreeNode[]): KnowledgeTreeBranch[] {
  const byParent = new Map<string | null, KnowledgeTreeNode[]>();
  const knownIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const parentId = node.parentId && knownIds.has(node.parentId) ? node.parentId : null;
    const siblings = byParent.get(parentId) || [];
    siblings.push(node);
    byParent.set(parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }

  const visit = (node: KnowledgeTreeNode, ancestors: Set<string>): KnowledgeTreeBranch => {
    if (ancestors.has(node.id)) return { node, children: [] };
    const nextAncestors = new Set(ancestors).add(node.id);
    return {
      node,
      children: (byParent.get(node.id) || []).map((child) => visit(child, nextAncestors)),
    };
  };
  return (byParent.get(null) || []).map((node) => visit(node, new Set()));
}

export function collectKnowledgeDescendantIds(nodes: KnowledgeTreeNode[], nodeId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const ids = children.get(node.parentId) || [];
    ids.push(node.id);
    children.set(node.parentId, ids);
  }
  const result = new Set<string>();
  const stack = [...(children.get(nodeId) || [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(children.get(id) || []));
  }
  return result;
}

export function canMoveKnowledgeNode(nodes: KnowledgeTreeNode[], nodeId: string, targetParentId: string | null): boolean {
  if (!targetParentId) return true;
  if (nodeId === targetParentId) return false;
  return !collectKnowledgeDescendantIds(nodes, nodeId).has(targetParentId);
}
