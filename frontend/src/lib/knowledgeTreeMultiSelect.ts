import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

export function topLevelSelectedKnowledgeNodes(
  nodes: KnowledgeTreeNode[],
  selectedNodeIds: Iterable<string>,
): KnowledgeTreeNode[] {
  const selected = new Set(selectedNodeIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    if (!selected.has(node.id)) return false;
    const visited = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId) {
      if (selected.has(parentId)) return false;
      if (visited.has(parentId)) break;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId || null;
    }
    return true;
  });
}

export function knowledgeTreeRangeSelection(
  renderedNodeIds: string[],
  anchorNodeId: string | null,
  targetNodeId: string,
): Set<string> {
  const anchorIndex = anchorNodeId ? renderedNodeIds.indexOf(anchorNodeId) : -1;
  const targetIndex = renderedNodeIds.indexOf(targetNodeId);
  if (anchorIndex < 0 || targetIndex < 0) return new Set([targetNodeId]);
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return new Set(renderedNodeIds.slice(start, end + 1));
}

export function knowledgeTreeDescendantIds(
  nodeIds: Iterable<string>,
  nodes: KnowledgeTreeNode[],
): Set<string> {
  const children = new Map<string, KnowledgeTreeNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId) || [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const result = new Set<string>();
  const stack = [...nodeIds];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    for (const child of children.get(current) || []) stack.push(child.id);
  }
  return result;
}
