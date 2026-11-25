import { describe, expect, it } from "vitest";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { hideLockedFolderDescendants } from "@/lib/knowledgeTreePassword";
import {
  buildNoteParentMetaMap,
  findNotesMatchingParentPath,
} from "../noteParentContext";
import type { Notebook } from "@/types";

function makeNode(partial: Partial<KnowledgeTreeNode> & Pick<KnowledgeTreeNode, "id" | "title" | "nodeType" | "resourceType" | "resourceId">): KnowledgeTreeNode {
  return {
    parentId: null,
    sortOrder: 0,
    icon: null,
    noteType: null,
    isDeleted: 0,
    isPasswordProtected: 0,
    updatedAt: "2026-11-24T07:00:00Z",
    scopeKey: "personal",
    sharedRootId: null,
    access: {
      role: "owner",
      inherited: false,
      capabilities: {
        canRead: true,
        canEdit: true,
        canCreate: true,
        canDelete: true,
        canMove: true,
        canManagePermissions: true,
      },
    },
    ...partial,
  };
}

const notebooks: Notebook[] = [
  {
    id: "nb-a02",
    userId: "u1",
    name: "A02-来料加工资料",
    icon: "📁",
    parentId: null,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "nb-spec-2510",
    userId: "u1",
    name: "驰铭-13012510_CM-2083W-MainDrv-V1.0",
    icon: "📁",
    parentId: "nb-a02",
    sortOrder: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

describe("buildNoteParentMetaMap", () => {
  it("resolves both parent document and parent folder labels accurately", () => {
    const treeNodes: KnowledgeTreeNode[] = [
      makeNode({ id: "t-a02", title: "A02-来料加工资料", nodeType: "folder", resourceType: "notebook", resourceId: "nb-a02" }),
      makeNode({ id: "t-doc-spec", parentId: "t-a02", title: "驰铭-13012160_PL-V1", nodeType: "note", resourceType: "note", resourceId: "note-spec" }),
      makeNode({ id: "t-doc-order", parentId: "t-doc-spec", title: "261124-001", nodeType: "note", resourceType: "note", resourceId: "note-order-1" }),
      makeNode({ id: "t-folder-2510", parentId: "t-a02", title: "驰铭-13012510_CM-2083W-MainDrv-V1.0", nodeType: "folder", resourceType: "notebook", resourceId: "nb-spec-2510" }),
      makeNode({ id: "t-folder-order", parentId: "t-folder-2510", title: "261030-007", nodeType: "note", resourceType: "note", resourceId: "note-order-2" }),
    ];

    const map = buildNoteParentMetaMap({
      notes: [
        { id: "note-order-1", notebookId: "nb-a02" },
        { id: "note-order-2", notebookId: "nb-spec-2510" },
        { id: "note-offline-only", notebookId: "nb-a02" },
      ],
      visibleTreeNodes: treeNodes,
      notebooks,
      unknownNotebookLabel: "未知笔记本",
    });

    // 文档套子文档：准确带出父文档名，而不是只显示顶层 A02
    expect(map.get("note-order-1")).toEqual({
      label: "驰铭-13012160_PL-V1",
      path: "A02-来料加工资料 / 驰铭-13012160_PL-V1",
      parentIsDocument: true,
      parentNodeId: "t-doc-spec",
    });

    // 文件夹套子文档：准确带出直接父文件夹名
    expect(map.get("note-order-2")).toEqual({
      label: "驰铭-13012510_CM-2083W-MainDrv-V1.0",
      path: "A02-来料加工资料 / 驰铭-13012510_CM-2083W-MainDrv-V1.0",
      parentIsDocument: false,
      parentNodeId: "t-folder-2510",
    });

    // 不在树中时平滑回退到 notebook 名称
    expect(map.get("note-offline-only")).toEqual({
      label: "A02-来料加工资料",
      path: "A02-来料加工资料",
      parentIsDocument: false,
      parentNodeId: null,
    });
  });
});

describe("findNotesMatchingParentPath", () => {
  it("returns descendant notes when parent folder or parent document matches the query", () => {
    const treeNodes: KnowledgeTreeNode[] = [
      makeNode({ id: "t-a02", title: "A02-来料加工资料", nodeType: "folder", resourceType: "notebook", resourceId: "nb-a02" }),
      makeNode({ id: "t-folder-2510", parentId: "t-a02", title: "驰铭-13012510_CM-2083W-MainDrv-V1.0", nodeType: "folder", resourceType: "notebook", resourceId: "nb-spec-2510" }),
      makeNode({ id: "t-folder-order", parentId: "t-folder-2510", title: "261030-007", nodeType: "note", resourceType: "note", resourceId: "note-order-2" }),
      makeNode({ id: "t-doc-2510", parentId: "t-a02", title: "驰铭-2510-文档模式", nodeType: "note", resourceType: "note", resourceId: "note-spec-doc" }),
      makeNode({ id: "t-doc-order", parentId: "t-doc-2510", title: "261124-002", nodeType: "note", resourceType: "note", resourceId: "note-order-3" }),
      // 已在全文结果中的不重复加入
      makeNode({ id: "t-already", parentId: "t-folder-2510", title: "261030-008", nodeType: "note", resourceType: "note", resourceId: "note-existing" }),
    ];

    const results = findNotesMatchingParentPath({
      visibleTreeNodes: treeNodes,
      query: "2510",
      existingNoteIds: new Set(["note-existing"]),
    });

    const ids = results.map((n) => n.id);
    expect(ids).toContain("note-order-2");
    expect(ids).toContain("note-order-3");
    expect(ids).not.toContain("note-existing");
    expect(ids).not.toContain("note-spec-doc"); // 仅匹配祖先，不重复冒充子文档
  });

  it("never leaks notes inside locked folders after hideLockedFolderDescendants", () => {
    const rawTreeNodes: KnowledgeTreeNode[] = [
      makeNode({ id: "t-locked", title: "加密-2510机密", nodeType: "folder", resourceType: "notebook", resourceId: "nb-locked", isPasswordProtected: 1 }),
      makeNode({ id: "t-secret-order", parentId: "t-locked", title: "261030-999", nodeType: "note", resourceType: "note", resourceId: "note-secret" }),
    ];

    const visibleNodes = hideLockedFolderDescendants(rawTreeNodes, new Set());
    const results = findNotesMatchingParentPath({
      visibleTreeNodes: visibleNodes,
      query: "2510",
      existingNoteIds: new Set(),
    });

    expect(results).toHaveLength(0);
  });
});
