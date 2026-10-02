import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildKnowledgeTreeNodeMenuItems } from "@/components/KnowledgeTreeNodeMenu";
import i18n from "@/i18n";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

const menuSource = readFileSync(path.resolve(__dirname, "../../components/KnowledgeTreeNodeMenu.tsx"), "utf8");

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
  return items.flatMap((item) => [item.id, ...ids(item.children || [])]);
}

describe("knowledge tree node menu", () => {
  it.each([
    { language: "zh-CN", labels: ["打开", "分屏打开", "创建副本", "新建", "取消置顶", "取消收藏", "重命名", "移动", "分享", "更多", "移入回收站"] },
    { language: "en", labels: ["Open", "Open in split view", "Create a copy", "New", "Unpin", "Unfavorite", "Rename", "Move", "Share", "More", "Move to Trash"] },
  ])("translates document actions and their submenus in $language", ({ language, labels }) => {
    const items = buildKnowledgeTreeNodeMenuItems(node({
      id: "note:n1",
      nodeType: "note",
      resourceType: "note",
      resourceId: "n1",
    }), {
      id: "n1", isPinned: 1, isFavorite: 1, isLocked: 1, contentFormat: "markdown",
    } as any, null, i18n.getFixedT(language));
    expect(items.filter((item) => !item.separator).map((item) => item.label)).toEqual(labels);

    const flatten = (entries: typeof items): typeof items => entries.flatMap((item) => [item, ...flatten(item.children || [])]);
    const allItems = flatten(items);
    expect(allItems.find((item) => item.id === "split_right")?.label).toBe(language === "en" ? "Open in right split" : "在右侧分屏打开");
    expect(allItems.find((item) => item.id === "new_note")?.label).toBe(language === "en" ? "Document" : "文档");
    expect(allItems.find((item) => item.id === "convert_format")?.label).toBe(language === "en" ? "Convert to rich text" : "转换为富文本");
    expect(allItems.find((item) => item.id === "toggle_lock")?.label).toBe(language === "en" ? "Unlock Note" : "解锁笔记");
    expect(allItems.some((item) => item.label.startsWith("note."))).toBe(false);
    if (language === "en") expect(allItems.some((item) => /[\u3400-\u9fff]/u.test(item.label))).toBe(false);
  });

  it("restores the former folder actions", () => {
    const actions = ids(buildKnowledgeTreeNodeMenuItems(node(), null));
    expect(actions).toEqual(expect.arrayContaining([
      "new_note",
      "new_markdown",
      "new_mindmap",
      "import_markdown",
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

  it("uses the unified open, rename, move and delete lifecycle for mindmaps", () => {
    const actions = ids(buildKnowledgeTreeNodeMenuItems(node({
      id: "mindmap:m1",
      nodeType: "mindmap",
      resourceType: "mindmap",
      resourceId: "m1",
    }), null));
    expect(actions).toEqual(["open", "rename", "move", "delete"]);
  });

  it("restores personal document flags and export formats", () => {
    const items = buildKnowledgeTreeNodeMenuItems(node({
      id: "note:n1",
      nodeType: "note",
      resourceType: "note",
      resourceId: "n1",
    }), {
      id: "n1",
      isPinned: 1,
      isFavorite: 0,
      isLocked: 0,
    } as any);
    const actions = ids(items);
    expect(items.map((item) => item.id)).toEqual([
      "open",
      "note_split_menu",
      "duplicate",
      "note_create_menu",
      "sep-note-primary",
      "toggle_pin",
      "toggle_favorite",
      "rename",
      "move",
      "share_note",
      "note_more_menu",
      "sep-note-danger",
      "delete",
    ]);
    expect(actions).toEqual(expect.arrayContaining([
      "open",
      "split_right",
      "split_down",
      "toggle_pin",
      "toggle_favorite",
      "toggle_lock",
      "share_note",
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
    expect(actions).not.toContain("share_note");
  });

  it("allows sharing a shared document only with reshare permission", () => {
    const shared = node({
      id: "note:shared",
      nodeType: "note",
      resourceType: "note",
      resourceId: "shared",
      sharedRootId: "notebook:shared-root",
    });
    expect(ids(buildKnowledgeTreeNodeMenuItems(shared, null))).toContain("share_note");
  });

  it("opens the existing note share modal from the context-menu action", () => {
    expect(menuSource).toContain('case "share_note":');
    expect(menuSource).toContain("<ShareModal");
    expect(menuSource).toContain("noteId={shareNote.id}");
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
