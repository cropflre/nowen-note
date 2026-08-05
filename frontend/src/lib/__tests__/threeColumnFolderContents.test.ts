import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  buildThreeColumnFolderContents,
  normalizeThreeColumnFolderScopeMode,
} from "@/lib/threeColumnFolderContents";

const access = {
  nodeId: "",
  rolePreset: "admin" as const,
  source: "owner" as const,
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
};

function treeNode(input: Partial<KnowledgeTreeNode> & Pick<KnowledgeTreeNode, "id" | "parentId" | "nodeType" | "resourceType" | "resourceId" | "title">): KnowledgeTreeNode {
  return {
    userId: "user-1",
    workspaceId: null,
    scopeKey: "personal:user-1",
    icon: null,
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isPasswordProtected: 0,
    contentFormat: null,
    sortOrder: 0,
    isExpanded: 0,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-08-05 00:00:00",
    updatedAt: "2026-08-05 00:00:00",
    access: { ...access, nodeId: input.id },
    ...input,
  } as KnowledgeTreeNode;
}

describe("three-column folder contents", () => {
  it("returns direct child folders and separates direct from recursive note counts", () => {
    const nodes = [
      treeNode({ id: "root", parentId: null, nodeType: "folder", resourceType: "notebook", resourceId: "nb-root", title: "技术学习" }),
      treeNode({ id: "direct-note", parentId: "root", nodeType: "note", resourceType: "note", resourceId: "note-1", title: "RSC" }),
      treeNode({ id: "child", parentId: "root", nodeType: "folder", resourceType: "notebook", resourceId: "nb-child", title: "前端笔记" }),
      treeNode({ id: "child-note", parentId: "child", nodeType: "markdown", resourceType: "note", resourceId: "note-2", title: "Tiptap" }),
      treeNode({ id: "grandchild", parentId: "child", nodeType: "folder", resourceType: "notebook", resourceId: "nb-grandchild", title: "React" }),
      treeNode({ id: "grandchild-note", parentId: "grandchild", nodeType: "note", resourceType: "note", resourceId: "note-3", title: "React 19" }),
      treeNode({ id: "other", parentId: null, nodeType: "folder", resourceType: "notebook", resourceId: "nb-other", title: "无关目录" }),
    ];

    const contents = buildThreeColumnFolderContents(nodes, "nb-root");
    expect(contents.selectedFolder?.id).toBe("root");
    expect(contents.directNoteCount).toBe(1);
    expect(contents.totalNoteCount).toBe(3);
    expect(contents.childFolders).toHaveLength(1);
    expect(contents.childFolders[0]).toMatchObject({
      directNoteCount: 1,
      totalNoteCount: 2,
      node: { id: "child", resourceId: "nb-child" },
    });
  });

  it("defaults invalid persisted scope values to the current level", () => {
    expect(normalizeThreeColumnFolderScopeMode("recursive")).toBe("recursive");
    expect(normalizeThreeColumnFolderScopeMode("current")).toBe("current");
    expect(normalizeThreeColumnFolderScopeMode("legacy")).toBe("current");
    expect(normalizeThreeColumnFolderScopeMode(null)).toBe("current");
  });

  it("locks the middle-column and tree-panel integration contract", () => {
    const noteList = readFileSync(
      resolve(process.cwd(), "src/components/NoteList.tsx"),
      "utf8",
    );
    const treePanel = readFileSync(
      resolve(process.cwd(), "src/components/KnowledgeTreePanel.tsx"),
      "utf8",
    );

    expect(noteList).toContain("data-three-column-child-folders");
    expect(noteList).toContain('currentFolderOnly ? { includeDescendants: "0" } : {}');
    expect(noteList).toContain("requestKnowledgeTreeFolderOpen(folder.node)");
    expect(noteList).toContain("saveThreeColumnFolderScopeMode(nextMode)");
    expect(treePanel).toContain("KNOWLEDGE_TREE_OPEN_FOLDER_EVENT");
    expect(treePanel).toContain("void openDocument(requestedNode)");
  });
});
