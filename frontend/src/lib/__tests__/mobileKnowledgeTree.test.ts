import { describe, expect, it } from "vitest";

import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  buildMobileKnowledgeTreePath,
  buildMobileKnowledgeTreeRecentNodes,
  filterMobileKnowledgeTreeNodes,
  getMobileKnowledgeTreeChildren,
  sortMobileKnowledgeTreeNodes,
  upsertMobileKnowledgeTreeRecentEntry,
} from "@/lib/mobileKnowledgeTree";

function node(
  id: string,
  title: string,
  input: Partial<KnowledgeTreeNode> = {},
): KnowledgeTreeNode {
  return {
    id,
    userId: "user-1",
    workspaceId: null,
    scopeKey: "personal:user-1",
    parentId: null,
    nodeType: "folder",
    resourceType: "notebook",
    resourceId: id.replace(/^\w+:/, ""),
    title,
    sortOrder: 0,
    isExpanded: 0,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
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
    ...input,
  };
}

describe("mobile knowledge tree navigation", () => {
  it("shows only the current level, keeps folders first, and defaults to recent updates", () => {
    const rows = [
      node("notebook:root", "Root"),
      node("note:older", "Older", {
        parentId: "notebook:root",
        nodeType: "note",
        resourceType: "note",
        updatedAt: "2026-07-02T00:00:00.000Z",
      }),
      node("notebook:folder", "Folder", {
        parentId: "notebook:root",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      node("note:newer", "Newer", {
        parentId: "notebook:root",
        nodeType: "note",
        resourceType: "note",
        updatedAt: "2026-07-03T00:00:00.000Z",
      }),
      node("note:grandchild", "Grandchild", {
        parentId: "notebook:folder",
        nodeType: "note",
        resourceType: "note",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    ];

    expect(getMobileKnowledgeTreeChildren(rows, "notebook:root").map((row) => row.id)).toEqual([
      "notebook:folder",
      "note:newer",
      "note:older",
    ]);
  });

  it("keeps actual open history ahead of updatedAt-only fallback documents", () => {
    const rows = [
      node("note:a", "A", {
        nodeType: "note",
        resourceType: "note",
        updatedAt: "2026-07-10T00:00:00.000Z",
      }),
      node("note:b", "B", {
        nodeType: "note",
        resourceType: "note",
        updatedAt: "2026-07-07T00:00:00.000Z",
      }),
      node("note:c", "C", {
        nodeType: "note",
        resourceType: "note",
        updatedAt: "2026-07-09T00:00:00.000Z",
      }),
    ];
    let entries = upsertMobileKnowledgeTreeRecentEntry([], "note:b", Date.parse("2026-07-08T00:00:00.000Z"));
    entries = upsertMobileKnowledgeTreeRecentEntry(entries, "note:c", Date.parse("2026-07-06T00:00:00.000Z"));

    expect(buildMobileKnowledgeTreeRecentNodes(rows, entries).map((row) => row.id)).toEqual([
      "note:b",
      "note:c",
      "note:a",
    ]);
  });

  it("builds a readable parent path for recent and search results", () => {
    const root = node("notebook:root", "工作备忘录");
    const child = node("notebook:child", "日报", { parentId: root.id });
    const document = node("note:document", "工作备忘录-2026-07-28", {
      parentId: child.id,
      nodeType: "note",
      resourceType: "note",
    });

    expect(buildMobileKnowledgeTreePath(document, [root, child, document])).toBe("工作备忘录 / 日报");
  });

  it("searches globally while keeping folders before matching documents", () => {
    const rows = [
      node("note:doc", "项目记录", { nodeType: "note", resourceType: "note" }),
      node("notebook:folder", "项目目录"),
      node("note:other", "临时笔记", { nodeType: "note", resourceType: "note" }),
    ];

    expect(filterMobileKnowledgeTreeNodes(rows, "项目").map((row) => row.id)).toEqual([
      "notebook:folder",
      "note:doc",
    ]);
  });

  it("supports explicit name sorting without changing the hierarchy", () => {
    const rows = [
      node("note:b", "B", { nodeType: "note", resourceType: "note", parentId: "notebook:root" }),
      node("note:a", "A", { nodeType: "note", resourceType: "note", parentId: "notebook:root" }),
    ];

    expect(sortMobileKnowledgeTreeNodes(rows, "title-asc").map((row) => row.title)).toEqual(["A", "B"]);
    expect(rows.every((row) => row.parentId === "notebook:root")).toBe(true);
  });
});
