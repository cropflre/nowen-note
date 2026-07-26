import { describe, expect, it } from "vitest";

import { buildKnowledgeTreeNodeMenuItems } from "@/components/KnowledgeTreeNodeMenu";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

function node(overrides: Partial<KnowledgeTreeNode> = {}): KnowledgeTreeNode {
  return {
    id: "notebook:root",
    userId: "owner",
    workspaceId: null,
    scopeKey: "personal:owner",
    parentId: null,
    nodeType: "folder",
    resourceType: "notebook",
    resourceId: "root",
    title: "Root",
    sortOrder: 0,
    isExpanded: 1,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    access: {
      nodeId: "notebook:root",
      rolePreset: "admin",
      source: "owner",
      sourceNodeId: null,
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
    ...overrides,
  };
}

function ids(items: ReturnType<typeof buildKnowledgeTreeNodeMenuItems>): string[] {
  return items.flatMap((item) => [item.id, ...(item.children || []).map((child) => child.id)]);
}

describe("knowledge tree node menu", () => {
  it("restores the former folder actions", () => {
    const actions = ids(buildKnowledgeTreeNodeMenuItems(node(), null));
    expect(actions).toEqual(expect.arrayContaining([
      "new_note",
      "new_markdown",
      "import_word",
      "import_url",
      "new_folder",
      "change_icon",
      "rename",
      "share",
      "move",
      "permissions",
      "export_folder",
      "delete",
    ]));
  });

  it("restores personal document flags and export formats", () => {
    const actions = ids(buildKnowledgeTreeNodeMenuItems(node({
      id: "note:n1",
      nodeType: "note",
      resourceType: "note",
      resourceId: "n1",
    }), {
      id: "n1",
      isPinned: 1,
      isFavorite: 0,
      isLocked: 0,
    } as any));
    expect(actions).toEqual(expect.arrayContaining([
      "open",
      "split_right",
      "split_down",
      "toggle_pin",
      "toggle_favorite",
      "toggle_lock",
      "export_note_md",
      "export_note_pdf",
      "export_note_png",
      "export_note_jpg",
      "export_note_word",
    ]));
  });

  it("does not expose owner-only flags on a shared readonly node", () => {
    const readonly = node({
      id: "note:shared",
      nodeType: "note",
      resourceType: "note",
      resourceId: "shared",
      sharedRootId: "notebook:shared-root",
      access: {
        nodeId: "note:shared",
        rolePreset: "readonly",
        source: "inherited",
        sourceNodeId: "notebook:shared-root",
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
      },
    });
    const actions = ids(buildKnowledgeTreeNodeMenuItems(readonly, null));
    expect(actions).toEqual(expect.arrayContaining(["open", "split_right", "export_note_md"]));
    expect(actions).not.toEqual(expect.arrayContaining(["toggle_pin", "toggle_favorite", "toggle_lock", "move", "delete"]));
  });

  it("disables deleting a locked document", () => {
    const items = buildKnowledgeTreeNodeMenuItems(node({
      id: "note:locked",
      nodeType: "note",
      resourceType: "note",
      resourceId: "locked",
    }), { id: "locked", isLocked: 1 } as any);
    expect(items.find((item) => item.id === "delete")?.disabled).toBe(true);
  });
});
