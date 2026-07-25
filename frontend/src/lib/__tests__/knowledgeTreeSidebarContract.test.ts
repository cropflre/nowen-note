import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("knowledge tree sidebar contract", () => {
  it("uses the unified tree as the primary Sidebar hierarchy", () => {
    const sidebar = source("../../components/Sidebar.tsx");
    expect(sidebar).toContain('import KnowledgeTreePanel');
    expect(sidebar).toContain('sidebarTreeMode === "knowledge"');
    expect(sidebar).toContain('<KnowledgeTreePanel');
    expect(sidebar).toContain('data-sidebar-tree-mode={sidebarTreeMode}');
    expect(sidebar).toContain('sidebarTreeMode === "legacy" && sharedNotebooks.length > 0');
  });

  it("does not render the former floating drawer launcher", () => {
    const drawer = source("../../components/KnowledgeTreeDrawer.tsx");
    expect(drawer).not.toContain("createPortal");
    expect(drawer).not.toContain("fixed bottom-4");
    expect(drawer).toContain("must not render a second drawer");
  });

  it("keeps loading recovery and legacy fallback inside one embedded panel", () => {
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    expect(panel).toContain('data-nowen-knowledge-tree="embedded"');
    expect(panel).toContain("内容树加载失败");
    expect(panel).toContain("onRequestLegacy");
    expect(panel).toContain("不能移动到自己的子节点中");
  });
});
