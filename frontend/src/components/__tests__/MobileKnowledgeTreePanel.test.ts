import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mobileSource = readFileSync(path.resolve(__dirname, "../MobileKnowledgeTreePanel.tsx"), "utf8");
const sidebarSource = readFileSync(path.resolve(__dirname, "../Sidebar.tsx"), "utf8");
const helperSource = readFileSync(path.resolve(__dirname, "../../lib/mobileKnowledgeTree.ts"), "utf8");

describe("MobileKnowledgeTreePanel product contract", () => {
  it("uses a dedicated mobile navigator while desktop keeps the recursive tree", () => {
    expect(sidebarSource).toContain('import MobileKnowledgeTreePanel from "@/components/MobileKnowledgeTreePanel"');
    expect(sidebarSource).toContain('variant === "mobile" ? <MobileKnowledgeTreePanel /> : <KnowledgeTreePanel variant="desktop" />');
  });

  it("defaults to recent and offers a one-level browse mode", () => {
    expect(mobileSource).toContain('type MobileView = "recent" | "browse"');
    expect(mobileSource).toContain('useState<MobileView>("recent")');
    expect(mobileSource).toContain('getMobileKnowledgeTreeChildren(nodes, parentId, sortMode)');
    expect(mobileSource).toContain('data-nowen-mobile-knowledge-tree="flat-navigation"');
    expect(mobileSource).toContain('data-mobile-knowledge-tree-breadcrumb');
    expect(mobileSource).not.toContain("setExpanded(");
  });

  it("keeps global search, mobile sorting, creation and the full node menu", () => {
    expect(mobileSource).toContain("filterMobileKnowledgeTreeNodes(nodes, query, sortMode)");
    expect(mobileSource).toContain("saveMobileKnowledgeTreeSortMode(next)");
    expect(mobileSource).toContain("openCreateMenu");
    expect(mobileSource).toContain("<KnowledgeTreeNodeMenu");
    expect(mobileSource).toContain("onPermissions={setPermissionsNode}");
    expect(mobileSource).toContain("onMove=");
  });

  it("stores real open history and falls back to updatedAt", () => {
    expect(mobileSource).toContain("upsertMobileKnowledgeTreeRecentEntry");
    expect(helperSource).toContain("Math.max(openedAtByNode.get(a.id) || 0, timestamp(a.updatedAt))");
    expect(helperSource).toContain('return "updated-desc"');
  });
});
