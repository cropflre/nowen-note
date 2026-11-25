import { describe, expect, it } from "vitest";

import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  canMoveWithinSharedRoot,
  filterKnowledgeTreeNodes,
  isSharedRoot,
} from "@/lib/sharedKnowledgeTree";

const access = {
  nodeId: "",
  rolePreset: "readonly" as const,
  source: "legacy" as const,
  sourceNodeId: null,
  capabilities: {
    canView: true,
    canComment: false,
    canCreate: false,
    canEdit: false,
    canDelete: false,
    canMove: false,
    canDownload: true,
    canReshare: false,
    canManageMembers: false,
  },
};

function node(
  id: string,
  parentId: string | null,
  title: string,
  sharedRootId?: string,
): KnowledgeTreeNode {
  return {
    id,
    userId: "owner",
    workspaceId: null,
    scopeKey: "personal:owner",
    parentId,
    nodeType: "folder",
    resourceType: "notebook",
    resourceId: id,
    title,
    sortOrder: 0,
    isExpanded: 1,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-07-25 00:00:00",
    updatedAt: "2026-07-25 00:00:00",
    access: { ...access, nodeId: id },
    sharedRootId,
    sharedDepth: sharedRootId ? 0 : undefined,
  };
}

describe("sharedKnowledgeTree", () => {
  it("keeps ancestors when filtering shared content", () => {
    const rows = [
      node("root", null, "产品资料", "root"),
      node("folder", "root", "订单", "root"),
      node("doc", "folder", "PO20260715 生产记录", "root"),
      node("other", null, "其他共享", "other"),
    ];

    expect(filterKnowledgeTreeNodes(rows, "生产记录").map((item) => item.id))
      .toEqual(["root", "folder", "doc"]);
  });

  it("keeps child documents and folders below a matching document without unrelated siblings", () => {
    const rows = [
      node("root", null, "产品资料", "root"),
      { ...node("doc", "root", "CM3342 产品说明", "root"), nodeType: "note" as const, resourceType: "note" as const },
      node("folder", "doc", "261020-001", "root"),
      { ...node("child", "folder", "测试记录", "root"), nodeType: "markdown" as const, resourceType: "note" as const },
      node("sibling", "root", "其他产品", "root"),
      node("other-child", "sibling", "其他记录", "root"),
    ];

    expect(filterKnowledgeTreeNodes(rows, "  cm3342 ").map((item) => item.id))
      .toEqual(["root", "doc", "folder", "child"]);
  });

  it("keeps all descendants of a matching folder", () => {
    const rows = [
      node("root", null, "产品资料"),
      node("folder", "root", "SMT 测试"),
      node("child-folder", "folder", "记录"),
      node("child", "child-folder", "261111-011"),
      node("sibling", "root", "无关资料"),
    ];

    expect(filterKnowledgeTreeNodes(rows, "SMT").map((item) => item.id))
      .toEqual(["root", "folder", "child-folder", "child"]);
    expect(filterKnowledgeTreeNodes(rows, " ")).toBe(rows);
  });

  it("allows moves only inside the same shared root and never moves the root itself", () => {
    const root = node("root", null, "共享根", "root");
    const source = node("source", "root", "源", "root");
    const target = node("target", "root", "目标", "root");
    const other = node("other-target", null, "其他根", "other-target");

    expect(isSharedRoot(root)).toBe(true);
    expect(canMoveWithinSharedRoot(root, target)).toBe(false);
    expect(canMoveWithinSharedRoot(source, target)).toBe(true);
    expect(canMoveWithinSharedRoot(source, other)).toBe(false);
  });
});
