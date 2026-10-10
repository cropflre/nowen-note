import { describe, expect, it } from "vitest";
import { buildMindMapOverviewItems, getMindMapCreationLocations } from "@/lib/mindMapOverview";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import type { MindMapListItem } from "@/types";

const access = { capabilities: { canCreate: true } } as KnowledgeTreeNode["access"];
const folder = { id: "notebook:project", parentId: null, nodeType: "folder", resourceType: "notebook", title: "项目", access } as KnowledgeTreeNode;
const nested = { ...folder, id: "notebook:design", parentId: folder.id, title: "设计" } as KnowledgeTreeNode;
const mapNode = { id: "mindmap:map-a", parentId: nested.id, resourceType: "mindmap", resourceId: "map-a" } as KnowledgeTreeNode;
const maps = [
  { id: "map-a", title: "结构图", updatedAt: "2026-09-27T10:00:00Z", starred: 1 },
  { id: "map-b", title: "草稿", updatedAt: "2026-09-26T10:00:00Z", starred: 0, folderId: "legacy-folder" },
] as MindMapListItem[];

describe("mind map overview", () => {
  it("uses the unified tree for paths, never the legacy folderId", () => {
    const rows = buildMindMapOverviewItems(maps, [folder, nested, mapNode], [], "", "all");
    expect(rows.map((row) => row.path)).toEqual(["项目 / 设计", "当前空间"]);
    expect(buildMindMapOverviewItems(maps, [folder, nested, mapNode], [], "设计", "all")
      .map((row) => row.map.id)).toEqual(["map-a"]);
  });

  it("filters favorites and sorts recently opened maps from shared tree history", () => {
    const recent = [{ nodeId: "mindmap:map-b", openedAt: 20 }, { nodeId: mapNode.id, openedAt: 10 }];
    expect(buildMindMapOverviewItems(maps, [folder, nested, mapNode], recent, "", "recent")
      .map((row) => row.map.id)).toEqual(["map-b", "map-a"]);
    expect(buildMindMapOverviewItems(maps, [folder, nested, mapNode], recent, "", "starred")
      .map((row) => row.map.id)).toEqual(["map-a"]);
  });

  it("offers only writable unified-tree directories as creation locations", () => {
    const readonly = { ...nested, id: "notebook:readonly", access: { capabilities: { canCreate: false } } } as KnowledgeTreeNode;
    expect(getMindMapCreationLocations([folder, nested, readonly])).toEqual([
      { id: folder.id, path: "当前空间 / 项目" },
      { id: nested.id, path: "当前空间 / 项目 / 设计" },
    ]);
  });
});
