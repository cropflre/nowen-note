import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const componentDir = path.resolve(__dirname, "..");
const libDir = path.resolve(__dirname, "../../lib");
const menuSource = readFileSync(path.join(componentDir, "KnowledgeTreeNodeMenu.tsx"), "utf8");
const searchSource = readFileSync(path.join(componentDir, "SearchCenter.tsx"), "utf8");
const panelSource = readFileSync(path.join(componentDir, "SearchNotebookExclusionsPanel.tsx"), "utf8");
const clientSource = readFileSync(path.join(libDir, "searchNotebookExclusions.ts"), "utf8");

describe("search notebook exclusion integration", () => {
  it("exposes exclusion controls from the shared tree context menu", () => {
    expect(menuSource).toContain("从全局搜索中排除");
    expect(menuSource).toContain("重新纳入全局搜索");
    expect(menuSource).toContain("已被上级目录排除");
    expect(menuSource).toContain("excludeNotebookFromSearch(node.resourceId)");
    expect(menuSource).toContain("includeNotebookInSearch(node.resourceId)");
  });

  it("keeps the search-center override session-only and reruns the query immediately", () => {
    expect(searchSource).toContain("includeExcluded");
    expect(searchSource).toContain("searchIncludingExcludedNotebooks(normalized)");
    expect(searchSource).toContain("setIncludeExcluded(false)");
    expect(searchSource).toContain("searchScopeRevision");
  });

  it("provides an in-search manager without turning exclusions into content metadata", () => {
    expect(panelSource).toContain("本次搜索包含已排除笔记本");
    expect(panelSource).toContain("管理已排除笔记本");
    expect(panelSource).toContain("重新纳入");
    expect(panelSource).toContain("不会删除、隐藏或修改这些笔记本");
  });

  it("uses an explicit includeExcluded request instead of mutating the default api search", () => {
    expect(clientSource).toContain('includeExcluded: "1"');
    expect(clientSource).toContain("SEARCH_NOTEBOOK_EXCLUSIONS_CHANGED_EVENT");
  });
});
