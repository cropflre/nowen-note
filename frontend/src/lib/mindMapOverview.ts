import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { buildMobileKnowledgeTreePath, type MobileKnowledgeTreeRecentEntry } from "@/lib/mobileKnowledgeTree";
import type { MindMapListItem } from "@/types";

export type MindMapOverviewFilter = "all" | "recent" | "starred";

export function buildMindMapOverviewItems(
  maps: MindMapListItem[],
  nodes: KnowledgeTreeNode[],
  recentEntries: MobileKnowledgeTreeRecentEntry[],
  query: string,
  filter: MindMapOverviewFilter,
): Array<{ map: MindMapListItem; path: string; openedAt: number }> {
  const nodeByResourceId = new Map(nodes.filter((node) => node.resourceType === "mindmap")
    .map((node) => [node.resourceId, node]));
  const openedAtByNodeId = new Map(recentEntries.map((entry) => [entry.nodeId, entry.openedAt]));
  const keyword = query.trim().toLocaleLowerCase();

  return maps.flatMap((map) => {
    const node = nodeByResourceId.get(map.id);
    const path = node ? buildMobileKnowledgeTreePath(node, nodes) : "当前空间";
    const openedAt = openedAtByNodeId.get(node?.id || `mindmap:${map.id}`) || 0;
    if (keyword && !`${map.title} ${path}`.toLocaleLowerCase().includes(keyword)) return [];
    if (filter === "recent" && !openedAt) return [];
    if (filter === "starred" && !map.starred) return [];
    return [{ map, path, openedAt }];
  }).sort((a, b) => (
    (filter === "recent" ? b.openedAt - a.openedAt : Date.parse(b.map.updatedAt) - Date.parse(a.map.updatedAt))
    || a.map.title.localeCompare(b.map.title)
  ));
}

export function getMindMapCreationLocations(nodes: KnowledgeTreeNode[]): Array<{ id: string; path: string }> {
  return nodes.filter((node) => node.nodeType === "folder" && node.access.capabilities.canCreate)
    .map((node) => {
      const parentPath = buildMobileKnowledgeTreePath(node, nodes);
      return { id: node.id, path: `当前空间 / ${parentPath === "当前空间" ? "" : `${parentPath} / `}${node.title}` };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
