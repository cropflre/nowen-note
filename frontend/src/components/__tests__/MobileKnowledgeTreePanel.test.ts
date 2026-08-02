import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mobileSource = readFileSync(path.resolve(__dirname, "../MobileKnowledgeTreePanel.tsx"), "utf8");
const sidebarSource = readFileSync(path.resolve(__dirname, "../Sidebar.tsx"), "utf8");
const helperSource = readFileSync(path.resolve(__dirname, "../../lib/mobileKnowledgeTree.ts"), "utf8");

describe("MobileKnowledgeTreePanel product contract", () => {
  it("uses the quick navigator on mobile while desktop chooses its saved mode", () => {
    expect(sidebarSource).toContain('import MobileKnowledgeTreePanel from "@/components/MobileKnowledgeTreePanel"');
    expect(sidebarSource).toContain('variant === "mobile" ? (');
    expect(sidebarSource).toContain('<MobileKnowledgeTreePanel />');
    expect(sidebarSource).toContain('desktopKnowledgeTreeMode === "quick"');
  });

  it("defaults to all directories and still offers the recent view", () => {
    expect(mobileSource).toContain('type MobileView = "recent" | "browse"');
    expect(mobileSource).toContain('useState<MobileView>("browse")');
    expect(mobileSource).toContain('getMobileKnowledgeTreeChildren(visibleNodes, parentId, sortMode)');
    expect(mobileSource).toContain('data-nowen-mobile-knowledge-tree={variant === "mobile" ? "flat-navigation" : undefined}');
    expect(mobileSource).toContain('data-mobile-knowledge-tree-breadcrumb');
    expect(mobileSource).not.toContain("setExpanded(");
  });

  it("keeps document children reachable without reopening a recursive tree", () => {
    expect(mobileSource).toContain("const hasChildren = node.childCount > 0");
    expect(mobileSource).toContain('node.nodeType !== "folder" && hasChildren');
    expect(mobileSource).toContain("查看“${node.title}”的子内容");
    expect(mobileSource).toContain("setParentId(node.id)");
  });

  it("keeps global search, mobile sorting, creation and the full node menu", () => {
    expect(mobileSource).toContain("filterMobileKnowledgeTreeNodes(visibleNodes, query, sortMode)");
    expect(mobileSource).toContain("saveMobileKnowledgeTreeSortMode(next)");
    expect(mobileSource).toContain("openCreateDropdown");
    expect(mobileSource).toContain("<KnowledgeTreeCreateDropdown");
    expect(mobileSource).toContain("<KnowledgeTreeNodeMenu");
    expect(mobileSource).toContain("onPermissions={setPermissionsNode}");
    expect(mobileSource).toContain("onMove={setMovingNode}");
  });

  it("keeps pinned documents first, then opened documents before updatedAt-only fallback documents", () => {
    expect(mobileSource).toContain("upsertMobileKnowledgeTreeRecentEntry");
    expect(helperSource).toContain("const pinnedDocuments = documents");
    expect(helperSource).toContain("const openedDocuments = documents");
    expect(helperSource).toContain("const fallbackDocuments = documents");
    expect(helperSource).toContain("return [...pinnedDocuments, ...openedDocuments, ...fallbackDocuments]");
    expect(helperSource).toContain('return "updated-desc"');
  });
});
