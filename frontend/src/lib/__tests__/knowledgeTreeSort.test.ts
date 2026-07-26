/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  KNOWLEDGE_TREE_SORT_CHANGED_EVENT,
  applyKnowledgeTreeSort,
  loadKnowledgeTreeSortMode,
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
