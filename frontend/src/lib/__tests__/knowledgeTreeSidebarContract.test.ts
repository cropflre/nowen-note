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

  it("applies an unmistakably compact mobile density with a safe fallback", () => {
    const main = source("../../main.tsx");
    const compactCss = source("../../mobile-knowledge-tree-compact.css");
    const bridge = source("../../components/SidebarSearchExperienceBridge.tsx");
    const panel = source("../../components/KnowledgeTreePanel.tsx");

    expect(main).toContain('import "./mobile-knowledge-tree-compact.css"');
    expect(main).not.toContain('import "./desktop-knowledge-tree-compact.css"');
    expect(bridge).toContain('<KnowledgeTreePanel variant="mobile" className="nowen-mobile-tree-density" />');
    expect(compactCss).toContain(".nowen-mobile-tree-density");

    // Root folders remain readable, nested folders are tighter, and documents are dense.
    expect(compactCss).toContain("--nowen-mobile-tree-root-folder-row-height: 22px");
    expect(compactCss).toContain("--nowen-mobile-tree-folder-row-height: 20px");
    expect(compactCss).toContain("--nowen-mobile-tree-note-row-height: 16px");
    expect(compactCss).toContain("font-size: 11px !important");
    expect(compactCss).toContain("line-height: 14px !important");
    expect(compactCss).toContain("padding: 0 !important");

    // Browsers without :has() still receive the 16px compact baseline.
    expect(compactCss).toMatch(/\[data-knowledge-tree-node-id\]\s*\{[\s\S]*min-height:\s*var\(--nowen-mobile-tree-note-row-height\)\s*!important/);
    expect(compactCss).toContain("svg.lucide-folder");
    expect(compactCss).toContain("[data-knowledge-tree-section] > div > [data-knowledge-tree-node-id]:has");
    expect(compactCss).toContain("touch-action: manipulation");
    expect(compactCss).not.toContain("data-mobile-knowledge-tree-classic-slot");
    expect(compactCss).not.toContain("data-sidebar-variant");
    expect(compactCss).not.toContain("@media (max-width: 767px)");

    // Existing interaction and title/status behavior must remain intact.
    expect(panel).toContain("onClick={() => hasChildren && void toggle(node)}");
    expect(panel).toContain('className="min-w-0 flex-1 truncate"');
    expect(panel).toContain('aria-label={`在“${node.title}”下新建文档`}');
    expect(panel).toContain('title="更多"');
    expect(panel).toContain('aria-label="已置顶"');
    expect(panel).toContain('aria-label="已收藏"');
  });
});
