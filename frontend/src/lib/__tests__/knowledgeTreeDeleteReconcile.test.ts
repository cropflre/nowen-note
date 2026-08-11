import { describe, expect, it } from "vitest";

import { affectedKnowledgeNoteIds } from "@/lib/knowledgeTreeDeleteReconcile";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

function node(
  input: Partial<KnowledgeTreeNode> & Pick<KnowledgeTreeNode, "id" | "resourceType" | "resourceId">,
): KnowledgeTreeNode {
  const { id, resourceType, resourceId, ...overrides } = input;
  return {
    id,
    userId: "user-1",
    workspaceId: null,
    scopeKey: "personal:user-1",
    parentId: null,
    nodeType: resourceType === "notebook" ? "folder" : "note",
    resourceType,
    resourceId,
    title: resourceId,
    sortOrder: 0,
    isExpanded: 1,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    access: {
      nodeId: id,
      rolePreset: "admin",
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
      source: "owner",
      sourceNodeId: id,
    },
    ...overrides,
  } as KnowledgeTreeNode;
}

describe("affectedKnowledgeNoteIds", () => {
  it("returns the business note id for a deleted note node", () => {
    const nodes = [node({ id: "note:1", resourceType: "note", resourceId: "note-1" })];
    expect(affectedKnowledgeNoteIds(nodes, ["note:1"])).toEqual(["note-1"]);
  });

  it("returns every descendant note for a subtree delete but ignores folders", () => {
    const nodes = [
      node({ id: "folder:1", resourceType: "notebook", resourceId: "folder-1" }),
      node({ id: "note:1", resourceType: "note", resourceId: "note-1", parentId: "folder:1" }),
      node({ id: "note:2", resourceType: "note", resourceId: "note-2", parentId: "folder:1" }),
      node({ id: "note:3", resourceType: "note", resourceId: "note-3" }),
    ];

    expect(affectedKnowledgeNoteIds(nodes, ["folder:1", "note:1", "note:2"]))
      .toEqual(["note-1", "note-2"]);
  });

  it("returns no notes when promote mode only deletes a folder", () => {
    const nodes = [
      node({ id: "folder:1", resourceType: "notebook", resourceId: "folder-1" }),
      node({ id: "note:1", resourceType: "note", resourceId: "note-1", parentId: "folder:1" }),
    ];

    expect(affectedKnowledgeNoteIds(nodes, ["folder:1"])).toEqual([]);
  });

  it("deduplicates business note ids defensively", () => {
    const nodes = [
      node({ id: "note:legacy", resourceType: "note", resourceId: "same-note" }),
      node({ id: "note:current", resourceType: "note", resourceId: "same-note" }),
    ];

    expect(affectedKnowledgeNoteIds(nodes, ["note:legacy", "note:current"]))
      .toEqual(["same-note"]);
  });
});
