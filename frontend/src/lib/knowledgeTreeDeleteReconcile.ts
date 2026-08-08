import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

/**
 * Map the tree-node ids returned by DELETE /api/knowledge-tree/nodes/:id back to
 * business note ids that may still be present in NoteList/AppContext caches.
 *
 * A subtree delete can affect many note nodes at once, while promote mode may
 * affect only a folder. Keep this mapping pure so desktop/mobile callers apply
 * the exact same reconciliation without depending on a later network refresh.
 */
export function affectedKnowledgeNoteIds(
  nodes: readonly KnowledgeTreeNode[],
  affectedNodeIds: readonly string[],
): string[] {
  if (nodes.length === 0 || affectedNodeIds.length === 0) return [];
  const affected = new Set(affectedNodeIds);
  const result: string[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (!affected.has(node.id) || node.resourceType !== "note" || !node.resourceId) continue;
    if (seen.has(node.resourceId)) continue;
    seen.add(node.resourceId);
    result.push(node.resourceId);
  }

  return result;
}
