/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  KNOWLEDGE_TREE_SORT_CHANGED_EVENT,
  applyKnowledgeTreeSort,
  compareKnowledgeTreePinnedPriority,
  loadKnowledgeTreeSortMode,
  planKnowledgeTreeSiblingReorder,
  resolveKnowledgeTreeDropPlacement,
  saveKnowledgeTreeSortMode,
} from "@/lib/knowledgeTreeSort";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

function node(
  id: string,
  title: string,
  sortOrder: number,
  options: Partial<KnowledgeTreeNode> = {},
): KnowledgeTreeNode {
  return {
    id,
    userId: "u1",
    workspaceId: null,
    scopeKey: "personal:u1",
    parentId: null,
    nodeType: "folder",
    resourceType: "notebook",
    resourceId: id,
    title,
    sortOrder,
    isExpanded: 0,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
    ...options,
  };
}

function orderedTitles(nodes: KnowledgeTreeNode[], parentId: string | null): string[] {
  return nodes
    .filter((item) => item.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => item.title);
}

describe("knowledgeTreeSort", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps persisted manual order as the default", () => {
    const nodes = [node("b", "Beta", 0), node("a", "Alpha", 1)];
    expect(applyKnowledgeTreeSort(nodes)).toBe(nodes);
    expect(orderedTitles(nodes, null)).toEqual(["Beta", "Alpha"]);
  });

  it("reorders manual-sort siblings without changing their parent", () => {
    const nodes = [node("a", "A", 0), node("b", "B", 1), node("c", "C", 2)];
    const plan = planKnowledgeTreeSiblingReorder(nodes, "c", "a", "before");

    expect(plan).not.toBeNull();
    expect(orderedTitles(plan!.nodes, null)).toEqual(["C", "A", "B"]);
    expect(plan!.nodes.every((item) => item.parentId === null)).toBe(true);
  });

  it("rejects drag reorder across hierarchy levels", () => {
    const nodes = [
      node("root", "Root", 0),
      node("child", "Child", 0, { parentId: "root" }),
    ];

    expect(planKnowledgeTreeSiblingReorder(nodes, "child", "root", "before")).toBeNull();
  });

  it("splits a tree row into before, inside, and after drop zones", () => {
    expect(resolveKnowledgeTreeDropPlacement(104, 100, 40)).toBe("before");
    expect(resolveKnowledgeTreeDropPlacement(120, 100, 40)).toBe("inside");
    expect(resolveKnowledgeTreeDropPlacement(136, 100, 40)).toBe("after");
  });

  it("sorts every sibling group by title without flattening hierarchy", () => {
    const nodes = [
      node("root-b", "Beta", 0),
      node("root-a", "Alpha", 1),
      node("child-z", "Zulu", 0, { parentId: "root-a" }),
      node("child-a", "Able", 1, { parentId: "root-a" }),
    ];
    const sorted = applyKnowledgeTreeSort(nodes, "title-asc");

    expect(orderedTitles(sorted, null)).toEqual(["Alpha", "Beta"]);
    expect(orderedTitles(sorted, "root-a")).toEqual(["Able", "Zulu"]);
    expect(sorted.find((item) => item.id === "child-a")?.parentId).toBe("root-a");
  });

  it("supports recent update and recent creation ordering", () => {
    const older = node("older", "Older", 0, {
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    const newer = node("newer", "Newer", 1, {
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    expect(orderedTitles(applyKnowledgeTreeSort([older, newer], "updated-desc"), null))
      .toEqual(["Older", "Newer"]);
    expect(orderedTitles(applyKnowledgeTreeSort([older, newer], "created-desc"), null))
      .toEqual(["Newer", "Older"]);
  });

  it("keeps folders first and pinned documents ahead of regular documents", () => {
    const folder = node("folder", "Folder", 2);
    const pinned = node("pinned", "Pinned", 3, { nodeType: "note", resourceType: "note", isPinned: 1 });
    const regular = node("regular", "Regular", 0, { nodeType: "note", resourceType: "note" });

    expect([regular, pinned, folder].sort(compareKnowledgeTreePinnedPriority).map((item) => item.id))
      .toEqual(["folder", "pinned", "regular"]);
  });

  it("persists the selected mode and broadcasts both UI and tree refresh events", () => {
    const sortListener = vi.fn();
    const treeListener = vi.fn();
    window.addEventListener(KNOWLEDGE_TREE_SORT_CHANGED_EVENT, sortListener);
    window.addEventListener("nowen:knowledge-tree-changed", treeListener);

    saveKnowledgeTreeSortMode("title-desc");

    expect(loadKnowledgeTreeSortMode()).toBe("title-desc");
    expect(sortListener).toHaveBeenCalledTimes(1);
    expect(treeListener).toHaveBeenCalledTimes(1);

    window.removeEventListener(KNOWLEDGE_TREE_SORT_CHANGED_EVENT, sortListener);
    window.removeEventListener("nowen:knowledge-tree-changed", treeListener);
  });
});
