import { describe, expect, it, vi } from "vitest";

import {
  duplicateKnowledgeTreeNoteAsChild,
  resolveDuplicableKnowledgeTreeNote,
} from "@/lib/knowledgeTreeDuplicateAsChild";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

function sourceNode(overrides: Partial<KnowledgeTreeNode> = {}): KnowledgeTreeNode {
  return {
    id: "tree-note-1",
    userId: "owner",
    workspaceId: null,
    scopeKey: "personal:owner",
    parentId: "folder-1",
    nodeType: "note",
    resourceType: "note",
    resourceId: "note-1",
    title: "原文档",
    sortOrder: 0,
    isExpanded: 0,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    access: {
      nodeId: "tree-note-1",
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

function duplicatedNote() {
  return {
    id: "note-copy",
    title: "原文档（副本）",
    treeNodeId: "tree-copy",
    treeParentId: "tree-note-1",
    tags: [],
  } as any;
}

describe("knowledge tree duplicate as child", () => {
  it("only exposes child duplication for writable, unlocked rich-text/Markdown note nodes", async () => {
    const note = sourceNode();
    await expect(resolveDuplicableKnowledgeTreeNote(note.id, {
      listNodes: async () => [note],
    })).resolves.toEqual(note);

    const markdown = sourceNode({ nodeType: "markdown" });
    await expect(resolveDuplicableKnowledgeTreeNote(markdown.id, {
      listNodes: async () => [markdown],
    })).resolves.toEqual(markdown);

    const folder = sourceNode({ resourceType: "notebook", nodeType: "folder" });
    await expect(resolveDuplicableKnowledgeTreeNote(folder.id, {
      listNodes: async () => [folder],
    })).resolves.toBeNull();

    const locked = sourceNode({ isLocked: 1 });
    await expect(resolveDuplicableKnowledgeTreeNote(locked.id, {
      listNodes: async () => [locked],
    })).resolves.toBeNull();

    const unsupported = sourceNode({ nodeType: "word" });
    await expect(resolveDuplicableKnowledgeTreeNote(unsupported.id, {
      listNodes: async () => [unsupported],
    })).resolves.toBeNull();

    const readonly = sourceNode({
      access: {
        ...note.access,
        capabilities: { ...note.access.capabilities, canCreate: false },
      },
    });
    await expect(resolveDuplicableKnowledgeTreeNote(readonly.id, {
      listNodes: async () => [readonly],
    })).resolves.toBeNull();
  });

  it("allows an editor to duplicate directly under the source without move or delete permissions", async () => {
    const owner = sourceNode();
    const source = sourceNode({ access: {
      ...owner.access,
      rolePreset: "editor",
      capabilities: { ...owner.access.capabilities, canMove: false, canDelete: false },
    } });
    const duplicateNote = vi.fn(async () => duplicatedNote());

    const result = await duplicateKnowledgeTreeNoteAsChild(source.id, {
      listNodes: async () => [source],
      duplicateNote,
    });

    expect(duplicateNote).toHaveBeenCalledTimes(1);
    expect(duplicateNote).toHaveBeenCalledWith(source.resourceId, { placement: "child" });
    expect(result.treeParentId).toBe(source.id);
  });

  it("propagates server failure without attempting a separate move or rollback", async () => {
    const source = sourceNode();
    const failure = new Error("duplicate failed");
    const duplicateNote = vi.fn(async () => { throw failure; });

    await expect(duplicateKnowledgeTreeNoteAsChild(source.id, {
      listNodes: async () => [source],
      duplicateNote,
    })).rejects.toBe(failure);

    expect(duplicateNote).toHaveBeenCalledTimes(1);
  });

  it("does not call duplicate for a readonly source", async () => {
    const owner = sourceNode();
    const source = sourceNode({ access: {
      ...owner.access,
      capabilities: { ...owner.access.capabilities, canCreate: false },
    } });
    const duplicateNote = vi.fn();
    await expect(duplicateKnowledgeTreeNoteAsChild(source.id, {
      listNodes: async () => [source], duplicateNote,
    })).rejects.toThrow("当前节点不是可创建子内容的文档");
    expect(duplicateNote).not.toHaveBeenCalled();
  });
});
