import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("knowledge tree inline create contract", () => {
  it("uses the row plus button for direct document creation", () => {
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    expect(panel).toContain('startInlineCreate(node, "note")');
    expect(panel).toContain('data-knowledge-tree-inline-create=""');
    expect(panel).toContain('title="新建文档"');
    expect(panel).not.toContain('title: parent ? `在“${parent.title}”下新建`');
  });

  it("keeps secondary creation and imports in compact submenus", () => {
    const menu = source("../../components/KnowledgeTreeNodeMenu.tsx");
    expect(menu).toContain('id: "create", label: "新建"');
    expect(menu).toContain('id: "import", label: "导入"');
    expect(menu).toContain('id: "import_word"');
    expect(menu).toContain('onCreate(node, "markdown")');
    expect(menu).not.toContain('title: "新建子文件夹"');
  });
});
