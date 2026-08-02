import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

export function countOwnedNotebooks(nodes: KnowledgeTreeNode[]): number {
  return nodes.filter((node) => (
    node.resourceType === "notebook"
    && !node.sharedRootId
    && node.isDeleted !== 1
  )).length;
}

export function countOwnedNotes(nodes: KnowledgeTreeNode[]): number {
  return nodes.filter((node) => (
    node.resourceType === "note"
    && !node.sharedRootId
    && node.isDeleted !== 1
  )).length;
}

export function buildFirstLevelNoteCounts(
  nodes: KnowledgeTreeNode[],
): Map<string, number> {
  const children = new Map<string, KnowledgeTreeNode[]>();
  const roots: KnowledgeTreeNode[] = [];
  for (const node of nodes) {
    if (node.isDeleted === 1 || node.sharedRootId) continue;
    if (!node.parentId) {
      roots.push(node);
      continue;
    }
    const siblings = children.get(node.parentId) || [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }

  const counts = new Map<string, number>();
  const visited = new Set<string>();
  for (const root of roots) {
    if (root.nodeType !== "folder") continue;
    let count = 0;
    const pending = [...(children.get(root.id) || [])];
    while (pending.length > 0) {
      const child = pending.pop()!;
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      if (child.resourceType === "note") count += 1;
      pending.push(...(children.get(child.id) || []));
    }
    counts.set(root.id, count);
  }
  return counts;
}
