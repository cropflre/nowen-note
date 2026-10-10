import { describe, expect, it } from "vitest";

import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  buildKnowledgeTreeForest,
  collectKnowledgeDescendantIds,
} from "@/lib/knowledgeTreeModel";
import { applyKnowledgeTreeSort } from "@/lib/knowledgeTreeSort";
import { filterKnowledgeTreeNodes } from "@/lib/sharedKnowledgeTree";

function node(
  id: string,
  parentId: string | null,
  title: string,
  sortOrder: number,
): KnowledgeTreeNode {
  return {
    id,
    userId: "perf-user",
    workspaceId: null,
    scopeKey: "personal:perf-user",
    parentId,
    nodeType: parentId === null ? "folder" : "note",
    resourceType: parentId === null ? "notebook" : "note",
    resourceId: id,
    title,
    sortOrder,
    isExpanded: parentId === null ? 1 : 0,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    access: {
      nodeId: id,
      rolePreset: "admin",
      source: "owner",
      sourceNodeId: id,
      capabilities: {
        canView: true,
        canComment: true,
        canCreate: true,
        canEdit: true,
        canDelete: true,
        canMove: true,
        canDownload: true,
        canReshare: true,
        canManageMembers: true,
      },
    },
  };
}

function makeLargeTree(total = 10_000): KnowledgeTreeNode[] {
  const roots = 100;
  const nodes: KnowledgeTreeNode[] = [];
  for (let rootIndex = 0; rootIndex < roots; rootIndex += 1) {
    const rootId = `folder-${rootIndex}`;
    nodes.push(node(rootId, null, `Folder ${rootIndex}`, rootIndex));
  }
  for (let index = roots; index < total; index += 1) {
    const rootIndex = index % roots;
    nodes.push(node(
      `note-${index}`,
      `folder-${rootIndex}`,
      index % 997 === 0 ? `Needle ${index}` : `Document ${index}`,
      index,
    ));
  }
  return nodes;
}

describe("knowledge tree large-directory performance", () => {
  it("keeps 10k-node build, filter, sort and descendant operations within a practical budget", () => {
    const nodes = makeLargeTree();
    const started = performance.now();

    const forest = buildKnowledgeTreeForest(nodes);
    const filtered = filterKnowledgeTreeNodes(nodes, "Needle");
    const sorted = applyKnowledgeTreeSort(nodes, "title-asc");
    const descendants = collectKnowledgeDescendantIds(nodes, "folder-0");

    const elapsed = performance.now() - started;
    expect(forest).toHaveLength(100);
    expect(filtered.length).toBeGreaterThan(10);
    expect(sorted).toHaveLength(nodes.length);
    expect(descendants.size).toBeGreaterThan(50);

    // Wide enough to catch accidental O(n²) regressions while leaving generous CI headroom.
    expect(elapsed).toBeLessThan(2_500);
  });

  it("does not hang when malformed historical parent links contain a cycle", () => {
    const nodes = [
      node("a", "b", "Needle A", 0),
      node("b", "a", "B", 1),
      node("root", null, "Root", 2),
    ];

    const started = performance.now();
    const filtered = filterKnowledgeTreeNodes(nodes, "Needle");

    expect(performance.now() - started).toBeLessThan(100);
    expect(new Set(filtered.map((item) => item.id))).toEqual(new Set(["a", "b"]));
  });
});
