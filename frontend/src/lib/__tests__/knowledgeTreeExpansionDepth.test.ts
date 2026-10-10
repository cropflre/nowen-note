import { describe, expect, it } from "vitest";

import {
  buildKnowledgeTreeExpandedIdsForDepth,
  normalizeKnowledgeTreeVisibleDepth,
} from "@/lib/knowledgeTreeExpansion";

type Row = {
  id: string;
  parentId: string | null;
  nodeType: "folder" | "note";
  isDeleted: number;
};

const rows: Row[] = [
  { id: "root-a", parentId: null, nodeType: "folder", isDeleted: 0 },
  { id: "root-note", parentId: null, nodeType: "note", isDeleted: 0 },
  { id: "child-a", parentId: "root-a", nodeType: "folder", isDeleted: 0 },
  { id: "child-note", parentId: "root-a", nodeType: "note", isDeleted: 0 },
  { id: "grandchild-a", parentId: "child-a", nodeType: "folder", isDeleted: 0 },
  { id: "grandchild-note", parentId: "grandchild-a", nodeType: "note", isDeleted: 0 },
  { id: "deleted-folder", parentId: "root-a", nodeType: "folder", isDeleted: 1 },
];

describe("knowledge tree visible depth (#762)", () => {
  it("treats roots as level 1 and expands only ancestors needed for the requested level", () => {
    expect(buildKnowledgeTreeExpandedIdsForDepth(rows as unknown as readonly Pick<import("@/lib/knowledgeTreeApi").KnowledgeTreeNode, "id" | "parentId" | "nodeType" | "isDeleted">[], 1)).toEqual([]);
    expect(buildKnowledgeTreeExpandedIdsForDepth(rows as unknown as readonly Pick<import("@/lib/knowledgeTreeApi").KnowledgeTreeNode, "id" | "parentId" | "nodeType" | "isDeleted">[], 2)).toEqual(["root-a"]);
    expect(new Set(buildKnowledgeTreeExpandedIdsForDepth(rows as unknown as readonly Pick<import("@/lib/knowledgeTreeApi").KnowledgeTreeNode, "id" | "parentId" | "nodeType" | "isDeleted">[], 3))).toEqual(
      new Set(["root-a", "child-a"]),
    );
    expect(new Set(buildKnowledgeTreeExpandedIdsForDepth(rows as unknown as readonly Pick<import("@/lib/knowledgeTreeApi").KnowledgeTreeNode, "id" | "parentId" | "nodeType" | "isDeleted">[], "all"))).toEqual(
      new Set(["root-a", "child-a", "grandchild-a"]),
    );
  });

  it("normalizes persisted or menu depth values safely", () => {
    expect(normalizeKnowledgeTreeVisibleDepth("1")).toBe(1);
    expect(normalizeKnowledgeTreeVisibleDepth("2")).toBe(2);
    expect(normalizeKnowledgeTreeVisibleDepth(3)).toBe(3);
    expect(normalizeKnowledgeTreeVisibleDepth("all")).toBe("all");
    expect(normalizeKnowledgeTreeVisibleDepth("99")).toBe("all");
  });
});
