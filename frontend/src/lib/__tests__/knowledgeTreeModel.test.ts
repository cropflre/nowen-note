import { describe, expect, it } from "vitest";

import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  buildKnowledgeTreeForest,
  canMoveKnowledgeNode,
  collectKnowledgeDescendantIds,
} from "@/lib/knowledgeTreeModel";

function node(id: string, parentId: string | null, title: string, sortOrder = 0): KnowledgeTreeNode {
  return {
    id,
    userId: "owner",
    workspaceId: "ws",
    scopeKey: "workspace:ws",
    parentId,
    nodeType: id.startsWith("folder") ? "folder" : "note",
    resourceType: id.startsWith("folder") ? "notebook" : "note",
    resourceId: id,
    title,
    sortOrder,
    isExpanded: 1,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
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

describe("knowledgeTreeModel", () => {
  const nodes = [
    node("folder-root", null, "产品资料"),
    node("note-product", "folder-root", "13012230-V/R-TANK"),
    node("folder-order", "note-product", "PO20260715"),
    node("note-production", "folder-order", "生产记录"),
    node("note-check", "folder-order", "首件检测", 1),
  ];

  it("allows documents and folders to both own children", () => {
    const forest = buildKnowledgeTreeForest(nodes);
    expect(forest).toHaveLength(1);
    expect(forest[0].children[0].node.id).toBe("note-product");
    expect(forest[0].children[0].children[0].node.id).toBe("folder-order");
    expect(forest[0].children[0].children[0].children.map((entry) => entry.node.id)).toEqual([
      "note-production",
      "note-check",
    ]);
  });

  it("collects descendants and blocks self/descendant moves", () => {
    expect([...collectKnowledgeDescendantIds(nodes, "note-product")]).toEqual(expect.arrayContaining([
      "folder-order",
      "note-production",
      "note-check",
    ]));
    expect(canMoveKnowledgeNode(nodes, "note-product", "note-production")).toBe(false);
    expect(canMoveKnowledgeNode(nodes, "note-product", "note-product")).toBe(false);
    expect(canMoveKnowledgeNode(nodes, "note-production", "note-product")).toBe(true);
    expect(canMoveKnowledgeNode(nodes, "note-product", null)).toBe(true);
  });

  it("promotes orphaned nodes to roots instead of losing them", () => {
    const forest = buildKnowledgeTreeForest([
      node("folder-root", null, "Root"),
      node("note-orphan", "missing", "Orphan"),
    ]);
    expect(forest.map((entry) => entry.node.id)).toEqual(["note-orphan", "folder-root"]);
  });
});
