import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("knowledge tree sidebar contract", () => {
  it("uses the unified tree as the only Sidebar hierarchy", () => {
    const sidebar = source("../../components/Sidebar.tsx");
    expect(sidebar).toContain("import KnowledgeTreePanel");
    expect(sidebar).toContain("<KnowledgeTreePanel");
    expect(sidebar).not.toContain("sidebarTreeMode");
    expect(sidebar).not.toContain("SharedNotebookTree");
    expect(sidebar).not.toContain("getSharedNotebooks");
    expect(sidebar).not.toContain("兼容模式");
    expect(sidebar).not.toContain("buildNotebookTree");
    expect(sidebar).not.toContain("NotebookTreeItem");
  });

  it("does not render the former floating drawer launcher", () => {
    const drawer = source("../../components/KnowledgeTreeDrawer.tsx");
    expect(drawer).not.toContain("createPortal");
    expect(drawer).not.toContain("fixed bottom-4");
    expect(drawer).toContain("must not render a second drawer");
  });

  it("keeps loading recovery inside one embedded panel without a legacy fallback", () => {
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    expect(panel).toContain('data-nowen-knowledge-tree="embedded"');
    expect(panel).toContain("内容树加载失败");
    expect(panel).toContain("不能移动到自己的子节点中");
    expect(panel).not.toContain("onRequestLegacy");
    expect(panel).not.toContain("使用旧树");
    expect(panel).toContain("KnowledgeTreeNodeMenu");
    expect(panel).toContain("onContextMenu");
    expect(panel).toContain("onTouchStart");
  });

  it("loads and focuses only the currently visible desktop or mobile tree", () => {
    const sidebar = source("../../components/Sidebar.tsx");
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    expect(sidebar).toMatch(/(?:sidebarRootRef|rootRef)\.current/);
    expect(sidebar).toContain("root.getClientRects().length === 0");
    expect(panel).toContain("useActiveSidebarSurface");
    expect(panel).toContain('data-sidebar-surface-active={surfaceActive ? "true" : "false"}');
    expect(panel).toContain("if (!surfaceActive) return");
  });

  it("keeps pinned and favorite note states visible beside the tree title", () => {
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    expect(panel).toContain('aria-label="已置顶"');
    expect(panel).toContain('aria-label="已收藏"');
    expect(panel).toContain("node.isPinned === 1");
    expect(panel).toContain("node.isFavorite === 1");
  });

  it("updates tree note status immediately after a successful menu action", () => {
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    const menu = source("../../components/KnowledgeTreeNodeMenu.tsx");
    expect(panel).toContain("onNotePatched={patchNoteStatus}");
    expect(menu).toContain("onNotePatched(node.id, patch)");
  });

  it("scopes compact density to the dedicated mobile tree portal slot", () => {
    const main = source("../../main.tsx");
    const compactCss = source("../../mobile-knowledge-tree-compact.css");
    const bridge = source("../../components/SidebarSearchExperienceBridge.tsx");
    const menu = source("../../components/KnowledgeTreeNodeMenu.tsx");

    expect(main).toContain('import "./mobile-knowledge-tree-compact.css"');
    expect(main).not.toContain('import "./desktop-knowledge-tree-compact.css"');
    expect(bridge).toContain('const MOBILE_TREE_SLOT_ATTRIBUTE = "data-mobile-knowledge-tree-classic-slot"');
    expect(compactCss).toContain('[data-mobile-knowledge-tree-classic-slot] [data-nowen-knowledge-tree="embedded"]');
    expect(compactCss).not.toContain('@media (max-width: 767px)');
    expect(compactCss).not.toContain('[data-sidebar-variant="mobile"]');
    expect(compactCss).toContain("--nowen-mobile-tree-row-height: 26px");
    expect(compactCss).toContain("--nowen-mobile-tree-descendant-row-height: 22px");
    expect(compactCss).toContain("--nowen-mobile-tree-indent: 10px");
    expect(compactCss).toContain("--nowen-mobile-tree-expander-width: 8px");
    expect(compactCss).toContain("--nowen-mobile-tree-content-gap: 3px");
    expect(compactCss).toContain("min-width: var(--nowen-mobile-tree-expander-width) !important");
    expect(compactCss).toContain("max-width: var(--nowen-mobile-tree-expander-width) !important");
    expect(compactCss).toContain("flex: 0 0 var(--nowen-mobile-tree-expander-width) !important");
    expect(compactCss).toContain("[data-knowledge-tree-section] > div > div > [data-knowledge-tree-node-id]");
    expect(compactCss).not.toContain("[data-knowledge-tree-section] > div > div [data-knowledge-tree-node-id]");
    expect(compactCss).toContain("height: var(--nowen-mobile-tree-descendant-row-height) !important");
    expect(compactCss).toContain("padding-top: 1px !important");
    expect(compactCss).toContain("padding-bottom: 1px !important");
    expect(compactCss).toContain("padding-left: 0 !important");
    expect(compactCss).toContain('button[aria-label$="下新建文档"]');
    expect(compactCss).toMatch(/button\[aria-label\$="下新建文档"\][\s\S]*display:\s*none\s*!important/);
    expect(compactCss).toContain('button[title="更多"]');
    expect(compactCss).toContain("width: 22px !important");
    expect(compactCss).not.toContain('[data-sidebar-variant="desktop"]');

    // Hiding the duplicated inline plus must not remove mobile creation access.
    expect(menu).toContain("mobile long-press");
    expect(menu).toContain('{ id: "create", label: "新建"');
  });
});
